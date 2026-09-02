import { CATEGORY_ORDER, CONVERSION_MAPPINGS, REQUIRED_PROPERTIES } from "./ifc-config";
import type {
  IfcInspection,
  MatchResult,
  PropertyCheckResult,
  RepairCategory,
  RepairReport,
  RepairResult,
  RepairSelection,
  SpaceInfo,
  ValidationResult
} from "./types";
import {
  collectReferences,
  formatRefList,
  parseEnum,
  parseRef,
  parseRefList,
  parseStep,
  parseTypedValue,
  quoteStep,
  serializeStep,
  splitStepArgs,
  unquoteStep
} from "./step-parser";

const TEXT_TYPES = new Set(["IFCLABEL", "IFCTEXT", "IFCIDENTIFIER"]);

export function detectSchema(text: string): string {
  const match = text.match(/FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/i);
  return match?.[1] ?? "Unknown";
}

export function detectExporter(text: string): string {
  const match = text.match(/FILE_NAME\s*\(([\s\S]*?)\);/i);
  if (!match) return "Unknown";
  const args = splitStepArgs(match[1]);
  return args[5] ? unquoteStep(args[5]) : "Unknown";
}

export function inspectIfc(text: string, filename = "model.ifc", fileSize = text.length): IfcInspection {
  if (text.trim().length === 0) throw new Error("The selected IFC file is empty.");
  const schema = detectSchema(text);
  if (!schema || schema === "Unknown") throw new Error("The IFC schema could not be detected.");
  const model = parseStep(text);
  const spaces = [...model.records.values()]
    .filter((record) => record.entity === "IFCSPACE")
    .map((record) => spaceFromRecord(record.id, model));
  return {
    filename,
    fileSize,
    schema,
    exporter: detectExporter(text),
    entityCount: model.records.size,
    spaces,
    status: schema.toUpperCase() === "IFC4" ? "waiting" : "error",
    message: schema.toUpperCase() === "IFC4" ? undefined : `Unsupported schema ${schema}. Version 1 only repairs IFC4 files.`
  };
}

export function matchSpaces(
  spaces: SpaceInfo[],
  searches: Record<RepairCategory, string>,
  skipped: Set<RepairCategory> = new Set(),
  selected: Partial<Record<RepairCategory, number[]>> = {}
): MatchResult[] {
  const assigned = new Map<number, RepairCategory>();
  const results: MatchResult[] = [];
  for (const category of CATEGORY_ORDER) {
    if (skipped.has(category)) {
      results.push({ category, searchValue: searches[category] ?? "", status: "Skipped", matches: [], selectedIds: [] });
      continue;
    }
    const value = (searches[category] ?? "").trim();
    let matches = spaces.filter((space) => space.longName === value);
    if (value && matches.length === 0) matches = spaces.filter((space) => space.longName.toLowerCase() === value.toLowerCase());
    const selectedIds = selected[category] ?? (matches.length === 1 ? [matches[0].expressId] : []);
    const duplicate = selectedIds.find((id) => assigned.has(id));
    selectedIds.forEach((id) => assigned.set(id, category));
    const status =
      duplicate !== undefined ? "Duplicate assignment" : matches.length === 0 ? "Not found" : matches.length > 1 ? "Multiple matches" : "Found";
    results.push({ category, searchValue: value, status, matches, selectedIds });
  }
  return results;
}

export function checkRequiredProperties(text: string, selections: RepairSelection[]): PropertyCheckResult[] {
  const model = parseStep(text);
  return selections.flatMap((selection) => {
    if (selection.category === "siteCoverage") return [];
    const objectInfo = objectIdentity(selection.expressId, model);
    return REQUIRED_PROPERTIES.filter((required) => required.category === selection.category).flatMap((required) =>
      checkProperty(model, selection.expressId, required).map((check) => ({ ...check, ...objectInfo }))
    );
  });
}

export function repairIfc(text: string, filename: string, selections: RepairSelection[], warningsAccepted: boolean): RepairResult {
  const sourceInspection = inspectIfc(text, filename, text.length);
  if (sourceInspection.schema.toUpperCase() !== "IFC4") throw new Error("Unsupported schema. Version 1 only repairs IFC4 files.");
  const model = parseStep(text);
  const deleted = new Set<number>();
  const relationshipChanges: string[] = [];
  const removedIncompatibleSets: string[] = [];
  const retainedPropertySets: string[] = [];
  const entityChanges: RepairReport["entityChanges"] = [];
  const selectionById = new Map(selections.map((selection) => [selection.expressId, selection.category]));
  const selectedIds = [...selectionById.keys()];
  const selectedIdSet = new Set(selectedIds);
  const storeyTargets = new Map<number, number[]>();

  for (const selection of selections) {
    const record = model.records.get(selection.expressId);
    if (!record || record.entity !== "IFCSPACE") throw new Error(`Selected object #${selection.expressId} is not an IfcSpace.`);
    const mapping = CONVERSION_MAPPINGS[selection.category];
    const old = spaceFromRecord(selection.expressId, model);
    const tag = old.name.trim() ? old.name : old.longName;
    record.entity = mapping.entity;
    record.args = [
      record.args[0],
      record.args[1],
      record.args[2],
      record.args[3],
      quoteStep(mapping.objectType),
      record.args[5],
      record.args[6],
      tag.trim() ? quoteStep(tag) : "$",
      `.${mapping.predefinedType}.`
    ];
    entityChanges.push({
      category: mapping.label,
      expressId: selection.expressId,
      globalId: old.globalId,
      oldEntity: "IfcSpace",
      newEntity: mapping.entityLabel,
      oldPredefinedType: old.predefinedType || "Empty",
      newPredefinedType: mapping.predefinedType,
      oldObjectType: old.objectType || "Empty",
      newObjectType: mapping.objectType
    });
    if (old.storeyId) {
      const current = storeyTargets.get(old.storeyId) ?? [];
      current.push(selection.expressId);
      storeyTargets.set(old.storeyId, current);
    }
  }

  for (const record of model.records.values()) {
    if (record.entity === "IFCRELSPACEBOUNDARY") {
      const relatedSpace = parseRef(record.args[4]);
      if (relatedSpace && selectedIdSet.has(relatedSpace)) {
        deleted.add(record.id);
        relationshipChanges.push(`Removed IfcRelSpaceBoundary #${record.id} from converted object #${relatedSpace}.`);
      }
    }

    if (record.entity === "IFCRELDEFINESBYTYPE") {
      const relatedObjects = parseRefList(record.args[4]);
      const relatedType = parseRef(record.args[5]);
      const typeRecord = relatedType ? model.records.get(relatedType) : undefined;
      if (typeRecord?.entity === "IFCSPACETYPE" && relatedObjects.some((id) => selectedIdSet.has(id))) {
        const remaining = relatedObjects.filter((id) => !selectedIdSet.has(id));
        if (remaining.length === 0) {
          deleted.add(record.id);
          relationshipChanges.push(`Removed IfcRelDefinesByType #${record.id} because it only referenced converted spaces.`);
        } else {
          record.args[4] = formatRefList(remaining);
          relationshipChanges.push(`Updated IfcRelDefinesByType #${record.id} to remove converted spaces.`);
        }
      }
    }

    if (record.entity === "IFCRELAGGREGATES") {
      const relatedObjects = parseRefList(record.args[5]);
      if (relatedObjects.some((id) => selectedIdSet.has(id))) {
        const remaining = relatedObjects.filter((id) => !selectedIdSet.has(id));
        for (const id of relatedObjects.filter((relatedId) => selectedIdSet.has(relatedId))) {
          const storey = parseRef(record.args[4]);
          if (storey) {
            const current = storeyTargets.get(storey) ?? [];
            if (!current.includes(id)) current.push(id);
            storeyTargets.set(storey, current);
          }
        }
        if (remaining.length === 0) {
          deleted.add(record.id);
          relationshipChanges.push(`Removed IfcRelAggregates #${record.id} after moving converted objects to containment.`);
        } else {
          record.args[5] = formatRefList(remaining);
          relationshipChanges.push(`Updated IfcRelAggregates #${record.id} to remove converted objects from spatial decomposition.`);
        }
      }
    }

    if (record.entity === "IFCRELDEFINESBYPROPERTIES") {
      const relatedObjects = parseRefList(record.args[4]);
      const propertySetId = parseRef(record.args[5]);
      const propertySet = propertySetId ? model.records.get(propertySetId) : undefined;
      if (relatedObjects.some((id) => selectedIdSet.has(id)) && propertySet) {
        const psetName = unquoteStep(propertySet.args[2] ?? "");
        if (/^QTO_SPACE/i.test(psetName)) {
          deleted.add(record.id);
          removedIncompatibleSets.push(`${psetName} through relationship #${record.id}`);
        } else {
          retainedPropertySets.push(psetName);
        }
      }
    }
  }

  for (const [storeyId, ids] of storeyTargets) {
    const existing = [...model.records.values()].find(
      (record) => record.entity === "IFCRELCONTAINEDINSPATIALSTRUCTURE" && parseRef(record.args[5]) === storeyId && !deleted.has(record.id)
    );
    if (existing) {
      const merged = [...new Set([...parseRefList(existing.args[4]), ...ids])];
      existing.args[4] = formatRefList(merged);
      relationshipChanges.push(`Reused containment relationship #${existing.id} for storey #${storeyId}.`);
    } else {
      const newId = Math.max(...model.records.keys()) + 1;
      model.records.set(newId, {
        id: newId,
        entity: "IFCRELCONTAINEDINSPATIALSTRUCTURE",
        args: [quoteStep(makeIfcGuid()), "#2", "$", "$", formatRefList(ids), `#${storeyId}`],
        raw: ""
      });
      relationshipChanges.push(`Created containment relationship #${newId} for storey #${storeyId}.`);
    }
  }

  const ifcText = serializeStep(model, deleted);
  const outputFilename = makeOutputFilename(filename);
  const propertyWarnings = checkRequiredProperties(text, selections).filter((check) => check.status !== "Passed" && check.status !== "Advisory");
  const validation = validateRepairedIfc(ifcText, selections, text);
  const repairedCategories = selections.map((selection) => CONVERSION_MAPPINGS[selection.category].label);
  const skippedCategories = CATEGORY_ORDER.filter((category) => !selections.some((selection) => selection.category === category)).map(
    (category) => CONVERSION_MAPPINGS[category].label
  );

  return {
    ifcText,
    outputFilename,
    report: {
      originalFilename: filename,
      outputFilename,
      detectedSchema: sourceInspection.schema,
      objectsRepaired: selections.length,
      repairedCategories,
      skippedCategories,
      matchedLongNames: Object.fromEntries(
        selections.map((selection) => [CONVERSION_MAPPINGS[selection.category].label, spaceFromRecord(selection.expressId, parseStep(text)).longName])
      ),
      entityChanges,
      relationshipChanges,
      removedIncompatibleSets,
      retainedPropertySets: [...new Set(retainedPropertySets)].filter(Boolean),
      propertyWarnings,
      warningsAccepted,
      validation
    }
  };
}

export function validateRepairedIfc(text: string, selections: RepairSelection[], originalText?: string): ValidationResult {
  const blockingErrors: string[] = [];
  const warnings: string[] = [];
  const checks: string[] = [];
  const model = parseStep(text);
  const original = originalText ? parseStep(originalText) : undefined;
  if (detectSchema(text).toUpperCase() !== "IFC4") blockingErrors.push("Output schema is not IFC4.");

  for (const selection of selections) {
    const mapping = CONVERSION_MAPPINGS[selection.category];
    const record = model.records.get(selection.expressId);
    if (!record) {
      blockingErrors.push(`Repaired entity #${selection.expressId} does not exist.`);
      continue;
    }
    if (record.entity !== mapping.entity) blockingErrors.push(`#${selection.expressId} is ${record.entity}, expected ${mapping.entity}.`);
    if (unquoteStep(record.args[4] ?? "") !== mapping.objectType) blockingErrors.push(`#${selection.expressId} has incorrect ObjectType.`);
    if (parseEnum(record.args[8] ?? "") !== mapping.predefinedType) blockingErrors.push(`#${selection.expressId} has incorrect PredefinedType.`);
    checks.push(`${mapping.label}: entity, ObjectType and PredefinedType checked.`);

    const representationRef = parseRef(record.args[6] ?? "");
    if (representationRef && !model.records.has(representationRef)) blockingErrors.push(`#${selection.expressId} has a broken representation reference.`);
    if (original) {
      const oldRecord = original.records.get(selection.expressId);
      if (oldRecord && oldRecord.args[0] !== record.args[0]) blockingErrors.push(`#${selection.expressId} did not preserve GlobalId.`);
      if (oldRecord && oldRecord.args[6] !== record.args[6]) blockingErrors.push(`#${selection.expressId} did not preserve geometry representation reference.`);
    }
    const inSpaceBoundary = [...model.records.values()].some(
      (candidate) => candidate.entity === "IFCRELSPACEBOUNDARY" && parseRef(candidate.args[4]) === selection.expressId
    );
    if (inSpaceBoundary) blockingErrors.push(`#${selection.expressId} is still referenced by IfcRelSpaceBoundary.`);
    const inSpaceType = [...model.records.values()].some((candidate) => {
      const relatedType = parseRef(candidate.args[5] ?? "");
      return (
        candidate.entity === "IFCRELDEFINESBYTYPE" &&
        parseRefList(candidate.args[4]).includes(selection.expressId) &&
        relatedType !== undefined &&
        model.records.get(relatedType)?.entity === "IFCSPACETYPE"
      );
    });
    if (inSpaceType) blockingErrors.push(`#${selection.expressId} is still assigned to IfcSpaceType.`);
    const containments = [...model.records.values()].filter(
      (candidate) =>
        candidate.entity === "IFCRELCONTAINEDINSPATIALSTRUCTURE" && parseRefList(candidate.args[4]).includes(selection.expressId)
    );
    if (containments.length === 0) blockingErrors.push(`#${selection.expressId} has no spatial containment.`);
    if (containments.length > 1) blockingErrors.push(`#${selection.expressId} has duplicate spatial containment.`);
  }

  const dangling = findDanglingReferences(model);
  if (dangling.length > 0) blockingErrors.push(`Dangling references found: ${dangling.slice(0, 8).join(", ")}${dangling.length > 8 ? "..." : ""}.`);
  return { passed: blockingErrors.length === 0, blockingErrors, warnings, checks };
}

function spaceFromRecord(id: number, model: ReturnType<typeof parseStep>): SpaceInfo {
  const record = model.records.get(id);
  if (!record) throw new Error(`Missing space #${id}`);
  const storeyId = findStoreyForObject(model, id);
  const storeyRecord = storeyId ? model.records.get(storeyId) : undefined;
  return {
    expressId: id,
    globalId: unquoteStep(record.args[0] ?? ""),
    name: unquoteStep(record.args[2] ?? ""),
    objectType: unquoteStep(record.args[4] ?? ""),
    longName: unquoteStep(record.args[7] ?? ""),
    predefinedType: parseEnum(record.args[9] ?? ""),
    storeyId,
    storeyName: storeyRecord ? unquoteStep(storeyRecord.args[2] ?? "") : undefined,
    area: findAreaValue(model, id)
  };
}

function findStoreyForObject(model: ReturnType<typeof parseStep>, objectId: number): number | undefined {
  for (const record of model.records.values()) {
    if ((record.entity === "IFCRELAGGREGATES" || record.entity === "IFCRELCONTAINEDINSPATIALSTRUCTURE") && parseRefList(record.args[5] ?? "").includes(objectId)) {
      return parseRef(record.args[4]);
    }
    if (record.entity === "IFCRELCONTAINEDINSPATIALSTRUCTURE" && parseRefList(record.args[4] ?? "").includes(objectId)) {
      return parseRef(record.args[5]);
    }
    if (record.entity === "IFCRELAGGREGATES" && parseRefList(record.args[5] ?? "").includes(objectId)) {
      return parseRef(record.args[4]);
    }
  }
  return undefined;
}

function findAreaValue(model: ReturnType<typeof parseStep>, objectId: number): string | undefined {
  const rels = [...model.records.values()].filter(
    (record) => record.entity === "IFCRELDEFINESBYPROPERTIES" && parseRefList(record.args[4]).includes(objectId)
  );
  for (const rel of rels) {
    const pset = model.records.get(parseRef(rel.args[5]) ?? -1);
    if (!pset) continue;
    const propertyIds = parseRefList(pset.args[4] ?? "");
    for (const propertyId of propertyIds) {
      const property = model.records.get(propertyId);
      if (property?.entity === "IFCPROPERTYSINGLEVALUE" && unquoteStep(property.args[0]) === "Area") {
        return parseTypedValue(property.args[2] ?? "$").value;
      }
    }
  }
  return undefined;
}

function checkProperty(
  model: ReturnType<typeof parseStep>,
  objectId: number,
  required: Omit<PropertyCheckResult, "expressId" | "globalId" | "longName" | "currentType" | "currentValue" | "status" | "explanation">
): Array<Omit<PropertyCheckResult, "expressId" | "globalId" | "longName">> {
  const psets = propertySetsForObject(model, objectId);
  const exactPset = psets.find((pset) => pset.name === required.propertySet);
  const ciPset = psets.find((pset) => pset.name.toLowerCase() === required.propertySet.toLowerCase());
  const fallbackAreaPset =
    required.property === "Area"
      ? psets.find((candidate) => candidate.name === "SGPset_GeographicElement" && candidate.properties.some((property) => property.name === "Area"))
      : undefined;
  const pset = exactPset ?? ciPset ?? fallbackAreaPset;
  if (!pset) return [result(required, "", "", "Missing property set", `Required property set ${required.propertySet} was not found.`)];
  const exactProperty = pset.properties.find((property) => property.name === required.property);
  const ciProperty = pset.properties.find((property) => property.name.toLowerCase() === required.property.toLowerCase());
  const property = exactProperty ?? ciProperty;
  if (!property) return [result(required, "", "", "Missing property", `Required property ${required.property} was not found in ${pset.name}.`)];
  const typed = parseTypedValue(property.value);
  const compatibleAreaLocation = required.property === "Area" && pset.name === "SGPset_GeographicElement";
  const capitalisationIssue = !compatibleAreaLocation && (pset.name !== required.propertySet || property.name !== required.property);
  if (capitalisationIssue) {
    return [
      result(
        required,
        typed.type,
        typed.value,
        "Incorrect property name capitalisation",
        "A case-insensitive match was found, but the name must use the required capitalisation."
      )
    ];
  }
  if (typed.empty) return [result(required, typed.type, typed.value, "No value", "$, empty text, and whitespace-only text do not pass.")];
  if (typed.type === "IFCLOGICAL" && typed.value === ".U.") return [result(required, typed.type, typed.value, "No value", "Unknown logical value does not pass.")];
  if (!typeMatches(required.expectedType, typed.type)) {
    return [result(required, typed.type, typed.value, "Wrong data type", `${typed.type || "Unwrapped value"} does not match ${required.expectedType}.`)];
  }
  const rows = [result(required, typed.type, typed.value, "Passed", "Required information is present and correctly typed.")];
  if (required.property === "Area" && typed.numeric !== undefined && typed.numeric <= 0) {
    rows.push(result(required, typed.type, typed.value, "Advisory", "Area is zero or negative; this is non-blocking in version 1."));
  }
  return rows;
}

function propertySetsForObject(model: ReturnType<typeof parseStep>, objectId: number) {
  return [...model.records.values()]
    .filter((record) => record.entity === "IFCRELDEFINESBYPROPERTIES" && parseRefList(record.args[4]).includes(objectId))
    .map((rel) => model.records.get(parseRef(rel.args[5]) ?? -1))
    .filter(Boolean)
    .map((pset) => ({
      id: pset!.id,
      name: unquoteStep(pset!.args[2] ?? ""),
      properties: parseRefList(pset!.args[4] ?? "").map((id) => {
        const property = model.records.get(id);
        return { id, name: unquoteStep(property?.args[0] ?? ""), value: property?.args[2] ?? "$" };
      })
    }));
}

function typeMatches(expected: string, actual: string): boolean {
  if (expected.includes("Boolean")) return actual === "IFCBOOLEAN";
  if (expected.includes("AreaMeasure")) return actual === "IFCAREAMEASURE";
  if (expected.includes("Label") || expected.includes("text")) return TEXT_TYPES.has(actual);
  return false;
}

function result(
  required: Omit<PropertyCheckResult, "expressId" | "globalId" | "longName" | "currentType" | "currentValue" | "status" | "explanation">,
  currentType: string,
  currentValue: string,
  status: PropertyCheckResult["status"],
  explanation: string
): Omit<PropertyCheckResult, "expressId" | "globalId" | "longName"> {
  return { ...required, currentType: currentType || "None", currentValue: currentValue || "Empty", status, explanation };
}

function objectIdentity(objectId: number, model: ReturnType<typeof parseStep>) {
  const record = model.records.get(objectId);
  return {
    expressId: objectId,
    globalId: record ? unquoteStep(record.args[0] ?? "") : "",
    longName: record ? unquoteStep(record.args[7] ?? "") : ""
  };
}

function findDanglingReferences(model: ReturnType<typeof parseStep>): string[] {
  const dangling: string[] = [];
  for (const record of model.records.values()) {
    for (const ref of collectReferences(record.args)) {
      if (!model.records.has(ref)) dangling.push(`#${record.id} -> #${ref}`);
    }
  }
  return dangling;
}

function makeOutputFilename(filename: string): string {
  return filename.replace(/\.ifc$/i, "") + "_IFCSG_Repaired.ifc";
}

function makeIfcGuid(): string {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";
  const bytes = crypto.getRandomValues(new Uint8Array(22));
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
}
