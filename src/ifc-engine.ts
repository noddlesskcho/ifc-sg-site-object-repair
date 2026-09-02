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
    let matches = value ? spaces.filter((space) => space.longName === value) : [];
    if (value && matches.length === 0) matches = spaces.filter((space) => space.longName.toLowerCase() === value.toLowerCase());
    const selectedIds = uniqueIds([...(selected[category] ?? []), ...(matches.length === 1 ? [matches[0].expressId] : [])]);
    const duplicate = selectedIds.find((id) => assigned.has(id));
    selectedIds.forEach((id) => assigned.set(id, category));
    const status =
      duplicate !== undefined ? "Duplicate assignment" : matches.length === 0 ? "Not found" : matches.length > 1 ? "Multiple matches" : "Found";
    results.push({ category, searchValue: value, status, matches, selectedIds });
  }
  return results;
}

function uniqueIds(ids: number[]): number[] {
  return [...new Set(ids)];
}

function checkRequiredPropertiesFromModel(model: StepModelType, selections: RepairSelection[]): PropertyCheckResult[] {
  return selections.flatMap((selection) => {
    if (selection.category === "siteCoverage") return [];
    const objectInfo = objectIdentity(selection.expressId, model);
    return REQUIRED_PROPERTIES.filter((required) => required.category === selection.category).flatMap((required) =>
      checkProperty(model, selection.expressId, required).map((check) => ({ ...check, ...objectInfo }))
    );
  });
}

export function checkRequiredProperties(text: string, selections: RepairSelection[]): PropertyCheckResult[] {
  return checkRequiredPropertiesFromModel(parseStep(text), selections);
}

export function repairIfc(text: string, filename: string, selections: RepairSelection[], warningsAccepted: boolean): RepairResult {
  // A single repair used to call parseStep on the same text 5-8+ times (once via
  // inspectIfc, once here, once inside checkRequiredProperties, twice inside
  // validateRepairedIfc, and once more per selection for matchedLongNames) -- for a
  // large IFC file that's most of the operation's cost spent re-tokenizing text it had
  // already tokenized. Everything below now shares exactly two parses: `sourceModel`
  // (read-only, used for anything that needs the original pre-repair shape of a record --
  // repairIfc mutates entity/args on `model` in place, which would otherwise corrupt
  // later reads like LongName/property lookups) and `model` (the one that gets mutated
  // into the repaired output).
  // The UI blocks a "Duplicate assignment" (the same object selected under two
  // categories) before it ever calls repairIfc -- see hasUnresolvedDuplicateAssignment()
  // in main.ts. repairIfc is exported and tested directly, though, and would otherwise
  // silently mutate the same record twice (each category's conversion overwriting the
  // last), so it enforces the same rule itself rather than relying on the caller.
  const seenIds = new Set<number>();
  for (const selection of selections) {
    if (seenIds.has(selection.expressId)) {
      throw new Error(`Object #${selection.expressId} is selected for more than one repair category. Resolve the duplicate assignment before repairing.`);
    }
    seenIds.add(selection.expressId);
  }

  const schema = detectSchema(text);
  if (schema.toUpperCase() !== "IFC4") throw new Error("Unsupported schema. Version 1 only repairs IFC4 files.");
  const sourceModel = parseStep(text);
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
    // Read from sourceModel (untouched) rather than `model` -- `model`'s IfcSpace records
    // get their args replaced below as each selection is converted, and reading the "old"
    // shape from the model being mutated risks picking up a stale cached storey/pset index
    // built before other selections' relationship changes landed.
    const old = spaceFromRecord(selection.expressId, sourceModel);
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
          // A Qto_SpaceBaseQuantities relationship can (rarely) relate more than one
          // IfcSpace to the same quantity set. Only drop the converted objects out of it --
          // deleting the whole record here would silently discard quantities that still
          // belong to an unselected, unconverted space.
          const remaining = relatedObjects.filter((id) => !selectedIdSet.has(id));
          if (remaining.length === 0) {
            deleted.add(record.id);
            removedIncompatibleSets.push(`${psetName} through relationship #${record.id}`);
          } else {
            record.args[4] = formatRefList(remaining);
            removedIncompatibleSets.push(`${psetName} through relationship #${record.id} (retained for unselected objects)`);
          }
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
  const propertyWarnings = checkRequiredPropertiesFromModel(sourceModel, selections).filter(
    (check) => check.status !== "Passed" && check.status !== "Advisory"
  );
  const validation = validateRepairedIfcFromModel(model, deleted, selections, sourceModel);
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
      detectedSchema: schema,
      objectsRepaired: selections.length,
      repairedCategories,
      skippedCategories,
      // Grouped as an array per category (not a single string) -- a category such as
      // Planting Areas can have more than one selected object, and a plain
      // Record<string, string> would let the second LongName silently overwrite the first.
      matchedLongNames: selections.reduce<Record<string, string[]>>((acc, selection) => {
        const label = CONVERSION_MAPPINGS[selection.category].label;
        const longName = spaceFromRecord(selection.expressId, sourceModel).longName;
        (acc[label] ??= []).push(longName);
        return acc;
      }, {}),
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

function validateRepairedIfcFromModel(
  model: StepModelType,
  deleted: Set<number>,
  selections: RepairSelection[],
  original?: StepModelType
): ValidationResult {
  const blockingErrors: string[] = [];
  const warnings: string[] = [];
  const checks: string[] = [];
  // FILE_SCHEMA always appears in the HEADER section, i.e. before the first numbered
  // record, so model.header carries the same text detectSchema needs -- no need to
  // re-scan (or re-parse) the full file text just for this.
  if (detectSchema(model.header).toUpperCase() !== "IFC4") blockingErrors.push("Output schema is not IFC4.");

  // These three checks used to each do their own O(records) scan PER SELECTION (an
  // O(records x selections) pass over the whole model). Built once here instead, and
  // skipping anything flagged `deleted` so this matches exactly what re-parsing the
  // final serialized (deleted-record-free) output would have found.
  const spaceBoundaryTargets = new Set<number>();
  const spaceTypeTargets = new Set<number>();
  const containmentCounts = new Map<number, number>();
  for (const record of model.records.values()) {
    if (deleted.has(record.id)) continue;
    if (record.entity === "IFCRELSPACEBOUNDARY") {
      const related = parseRef(record.args[4] ?? "");
      if (related !== undefined) spaceBoundaryTargets.add(related);
    } else if (record.entity === "IFCRELDEFINESBYTYPE") {
      const relatedType = parseRef(record.args[5] ?? "");
      if (relatedType !== undefined && model.records.get(relatedType)?.entity === "IFCSPACETYPE") {
        for (const id of parseRefList(record.args[4] ?? "")) spaceTypeTargets.add(id);
      }
    } else if (record.entity === "IFCRELCONTAINEDINSPATIALSTRUCTURE") {
      for (const id of parseRefList(record.args[4] ?? "")) {
        containmentCounts.set(id, (containmentCounts.get(id) ?? 0) + 1);
      }
    }
  }

  for (const selection of selections) {
    const mapping = CONVERSION_MAPPINGS[selection.category];
    const record = model.records.get(selection.expressId);
    if (!record || deleted.has(selection.expressId)) {
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
    if (spaceBoundaryTargets.has(selection.expressId)) blockingErrors.push(`#${selection.expressId} is still referenced by IfcRelSpaceBoundary.`);
    if (spaceTypeTargets.has(selection.expressId)) blockingErrors.push(`#${selection.expressId} is still assigned to IfcSpaceType.`);
    const containments = containmentCounts.get(selection.expressId) ?? 0;
    if (containments === 0) blockingErrors.push(`#${selection.expressId} has no spatial containment.`);
    if (containments > 1) blockingErrors.push(`#${selection.expressId} has duplicate spatial containment.`);
  }

  const dangling = findDanglingReferences(model, deleted);
  if (dangling.length > 0) blockingErrors.push(`Dangling references found: ${dangling.slice(0, 8).join(", ")}${dangling.length > 8 ? "..." : ""}.`);
  return { passed: blockingErrors.length === 0, blockingErrors, warnings, checks };
}

export function validateRepairedIfc(text: string, selections: RepairSelection[], originalText?: string): ValidationResult {
  return validateRepairedIfcFromModel(parseStep(text), new Set(), selections, originalText ? parseStep(originalText) : undefined);
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

// findStoreyForObject/propertySetsForObject/findAreaValue used to each do their own full
// O(records) linear scan, called once PER OBJECT (so O(records x objects) overall -- for a
// file with 100k records and 1k spaces that's ~100M iterations just for storey lookups on
// load). These are now backed by an index built once per model and cached by model identity,
// so repeated lookups against the same model are O(1) amortized instead of O(records).
//
// NOTE: the cache key is model object identity, not content. These indexes are only ever
// built from an already-parsed model and read afterwards in this codebase (never rebuilt
// mid-mutation) -- if a caller ever mutates a model's relationship records in place and then
// expects a storey/pset lookup to see the new relationships without re-parsing, the cached
// index would be stale. Re-parse into a fresh model object (or add cache invalidation) if
// that ever becomes necessary.
type StepModelType = ReturnType<typeof parseStep>;

const storeyIndexCache = new WeakMap<StepModelType, Map<number, number>>();

function getStoreyIndex(model: StepModelType): Map<number, number> {
  const cached = storeyIndexCache.get(model);
  if (cached) return cached;
  const index = new Map<number, number>();
  for (const record of model.records.values()) {
    if (record.entity === "IFCRELCONTAINEDINSPATIALSTRUCTURE") {
      const storey = parseRef(record.args[5] ?? "");
      if (storey !== undefined) {
        for (const id of parseRefList(record.args[4] ?? "")) {
          if (!index.has(id)) index.set(id, storey);
        }
      }
    } else if (record.entity === "IFCRELAGGREGATES") {
      const parent = parseRef(record.args[4] ?? "");
      if (parent !== undefined) {
        for (const id of parseRefList(record.args[5] ?? "")) {
          if (!index.has(id)) index.set(id, parent);
        }
      }
    }
  }
  storeyIndexCache.set(model, index);
  return index;
}

function findStoreyForObject(model: StepModelType, objectId: number): number | undefined {
  return getStoreyIndex(model).get(objectId);
}

const psetLinksCache = new WeakMap<StepModelType, Map<number, number[]>>();

function getPsetLinks(model: StepModelType): Map<number, number[]> {
  const cached = psetLinksCache.get(model);
  if (cached) return cached;
  const index = new Map<number, number[]>();
  for (const record of model.records.values()) {
    if (record.entity !== "IFCRELDEFINESBYPROPERTIES") continue;
    const psetId = parseRef(record.args[5] ?? "");
    if (psetId === undefined) continue;
    for (const objectId of parseRefList(record.args[4] ?? "")) {
      const list = index.get(objectId) ?? [];
      list.push(psetId);
      index.set(objectId, list);
    }
  }
  psetLinksCache.set(model, index);
  return index;
}

function findAreaValue(model: StepModelType, objectId: number): string | undefined {
  const psetIds = getPsetLinks(model).get(objectId) ?? [];
  for (const psetId of psetIds) {
    const pset = model.records.get(psetId);
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

function propertySetsForObject(model: StepModelType, objectId: number) {
  const psetIds = getPsetLinks(model).get(objectId) ?? [];
  return psetIds
    .map((id) => model.records.get(id))
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
  // IFCLOGICAL(.T.)/(.F.) is a valid true/false value wherever IfcBoolean is expected --
  // some real-world exports (Archicad in particular) write these properties as IfcLogical
  // rather than IfcBoolean. Only the unknown state (.U.) is invalid, and that is already
  // rejected earlier (as "No value") before typeMatches is ever consulted.
  if (expected.includes("Boolean")) return actual === "IFCBOOLEAN" || actual === "IFCLOGICAL";
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

function findDanglingReferences(model: StepModelType, deleted: Set<number> = new Set()): string[] {
  const dangling: string[] = [];
  for (const record of model.records.values()) {
    if (deleted.has(record.id)) continue;
    for (const ref of collectReferences(record.args)) {
      if (!model.records.has(ref) || deleted.has(ref)) dangling.push(`#${record.id} -> #${ref}`);
    }
  }
  return dangling;
}

function makeOutputFilename(filename: string): string {
  return filename.replace(/\.ifc$/i, "") + "_IFCSG_Repaired.ifc";
}

// A real IFC GlobalId is a 22-character base64-style compression of a 128-bit UUID (the
// well-known algorithm used across IFC tooling: 1 byte -> 2 chars, then five groups of
// 3 bytes -> 4 chars each = 1 + 15 = 16 bytes -> 2 + 5*4 = 22 chars). Picking 22 random
// characters from the alphabet independently of each other (the previous implementation)
// is not a valid compressed UUID, which can trip up strict validators in downstream BIM
// tools (Solibri, xBIM, re-import into Revit/Archicad) even though it "looks" the right
// shape. This builds a real (version 4 shaped) UUID from secure random bytes and encodes
// it with the standard compression so newly created relationships get a properly formed
// GlobalId.
function makeIfcGuid(): string {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const toBase64 = (value: number, length: number) => {
    let chars = "";
    let remaining = value;
    for (let i = 0; i < length; i += 1) {
      chars = alphabet[remaining % 64] + chars;
      remaining = Math.floor(remaining / 64);
    }
    return chars;
  };
  return (
    toBase64(bytes[0], 2) +
    toBase64((bytes[1] << 16) + (bytes[2] << 8) + bytes[3], 4) +
    toBase64((bytes[4] << 16) + (bytes[5] << 8) + bytes[6], 4) +
    toBase64((bytes[7] << 16) + (bytes[8] << 8) + bytes[9], 4) +
    toBase64((bytes[10] << 16) + (bytes[11] << 8) + bytes[12], 4) +
    toBase64((bytes[13] << 16) + (bytes[14] << 8) + bytes[15], 4)
  );
}
