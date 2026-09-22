import { makeIfcGuid } from "./ifc-engine";
import { formatRefList, parseEnum, parseRef, parseRefList, parseStep, parseTypedValue, quoteStep, serializeStep, splitStepArgs, unquoteStep } from "./step-parser";
import type {
  StairAnalysisResult,
  StairConfidence,
  StairFieldAnalysis,
  StairFieldName,
  StairFlightAnalysis,
  StairGeometryEvidence,
  StairParentValidation,
  StairRepairResult,
  StairValueSource,
  ValidationResult
} from "./types";

const FIELD_ARGS: Record<StairFieldName, number> = {
  numberOfRisers: 8,
  numberOfTreads: 9,
  riserHeight: 10,
  treadLength: 11
};

const FIELD_LABELS: Record<StairFieldName, string> = {
  numberOfRisers: "NumberOfRisers",
  numberOfTreads: "NumberOfTreads",
  riserHeight: "RiserHeight",
  treadLength: "TreadLength"
};

const PSET_PROPERTY_NAMES: Record<StairFieldName, string> = {
  numberOfRisers: "NumberOfRiser",
  numberOfTreads: "NumberOfTreads",
  riserHeight: "RiserHeight",
  treadLength: "TreadLength"
};

export interface StairTolerance {
  elevation: number;
  dimension: number;
  relative: number;
  horizontalNormal: number;
  straightDirectionCosine: number;
  unitScaleToMetres: number;
}

export function toleranceForUnit(unitScaleToMetres: number): StairTolerance {
  return {
    elevation: 0.00075 / unitScaleToMetres,
    dimension: 0.0015 / unitScaleToMetres,
    relative: 0.015,
    horizontalNormal: 0.96,
    straightDirectionCosine: 0.97,
    unitScaleToMetres
  };
}

export function analyseStairFlights(
  text: string,
  filename: string,
  geometry: StairGeometryEvidence[] = []
): StairAnalysisResult {
  const model = parseStep(text);
  const schema = detectSchema(text);
  if (schema !== "IFC4") throw new Error(`Unsupported schema ${schema || "Unknown"}. This stair repair currently supports IFC4.`);
  const unit = detectLengthUnit(model);
  const tolerance = toleranceForUnit(unit.scaleToMetres);
  const geometryById = new Map(geometry.map((item) => [item.expressId, item]));
  const parentLinks = buildParentLinks(model);
  const psets = buildPropertyIndex(model);

  const flights: StairFlightAnalysis[] = [];
  for (const record of model.records.values()) {
    if (record.entity !== "IFCSTAIRFLIGHT") continue;
    const parentId = parentLinks.childToParent.get(record.id);
    const parent = parentId ? model.records.get(parentId) : undefined;
    const siblings = parentId ? parentLinks.parentToChildren.get(parentId) ?? [] : [];
    const landingIds = siblings.filter((id) => {
      const sibling = model.records.get(id);
      return sibling?.entity === "IFCSLAB" && parseEnum(sibling.args[8] ?? "") === "LANDING";
    });
    const parentValues = parentId ? readStairProperties(psets.get(parentId) ?? [], model) : {};
    const flightPsetValues = readStairFlightProperties(psets.get(record.id) ?? [], model);
    flights.push(analyseFlight(record, parent, landingIds.length, parentValues, flightPsetValues, geometryById.get(record.id), tolerance, model));
  }

  const parents = buildParentValidations(model, parentLinks, flights, psets);
  return {
    filename,
    schema,
    lengthUnit: unit.label,
    unitScaleToMetres: unit.scaleToMetres,
    flights,
    parents,
    analysedAt: new Date().toISOString()
  };
}

export function repairStairFlights(text: string, filename: string, analysis: StairAnalysisResult): StairRepairResult {
  const model = parseStep(text);
  const changes: StairRepairResult["report"]["changes"] = [];
  const originalArgs = new Map<number, string[]>();
  const psetIndex = buildPropertyIndex(model);
  let nextId = Math.max(0, ...model.records.keys()) + 1;
  let propertyValuesWritten = 0;

  for (const flight of analysis.flights) {
    if (flight.status === "Conflict") continue;
    const record = model.records.get(flight.expressId);
    if (!record || record.entity !== "IFCSTAIRFLIGHT") continue;
    originalArgs.set(record.id, [...record.args]);
    for (const field of flight.repairableFields) {
      const result = flight.fields[field];
      const argIndex = FIELD_ARGS[field];
      if (!isMissing(record.args[argIndex]) || result.value === undefined || result.confidence === "None") continue;
      record.args[argIndex] = formatStepNumber(result.value, field === "numberOfRisers" || field === "numberOfTreads");
      changes.push({ expressId: record.id, name: flight.name, field, oldValue: "$", newValue: result.value, source: result.source });
      const pset = getOrCreateFlightPropertySet(model, psetIndex, record.id, record.args[1] ?? "$", () => nextId++);
      if (writeMissingFlightProperty(model, pset, field, result.value, () => nextId++)) propertyValuesWritten += 1;
    }
  }

  const ifcText = serializeStep(model);
  const validation = validateStairRepair(text, ifcText, changes, originalArgs);
  return {
    ifcText,
    outputFilename: filename.replace(/\.ifc$/i, "") + "_StairFlight_Repaired.ifc",
    report: {
      originalFilename: filename,
      outputFilename: filename.replace(/\.ifc$/i, "") + "_StairFlight_Repaired.ifc",
      flightsAnalysed: analysis.flights.length,
      flightsRepaired: new Set(changes.map((change) => change.expressId)).size,
      fieldsWritten: changes.length,
      propertyValuesWritten,
      changes,
      validation
    }
  };
}

function getOrCreateFlightPropertySet(
  model: ReturnType<typeof parseStep>,
  psetIndex: Map<number, number[]>,
  flightId: number,
  ownerHistory: string,
  allocateId: () => number
) {
  for (const psetId of psetIndex.get(flightId) ?? []) {
    const pset = model.records.get(psetId);
    if (pset?.entity === "IFCPROPERTYSET" && unquoteStep(pset.args[2] ?? "") === "Pset_StairFlightCommon") return pset;
  }
  const psetId = allocateId();
  const pset = {
    id: psetId,
    entity: "IFCPROPERTYSET",
    args: [quoteStep(makeIfcGuid()), ownerHistory, quoteStep("Pset_StairFlightCommon"), "$", "()"],
    raw: ""
  };
  model.records.set(psetId, pset);
  const relationId = allocateId();
  model.records.set(relationId, {
    id: relationId,
    entity: "IFCRELDEFINESBYPROPERTIES",
    args: [quoteStep(makeIfcGuid()), ownerHistory, "$", "$", formatRefList([flightId]), `#${psetId}`],
    raw: ""
  });
  psetIndex.set(flightId, [...(psetIndex.get(flightId) ?? []), psetId]);
  return pset;
}

function writeMissingFlightProperty(
  model: ReturnType<typeof parseStep>,
  pset: ReturnType<typeof parseStep>["records"] extends Map<number, infer T> ? T : never,
  field: StairFieldName,
  value: number,
  allocateId: () => number
): boolean {
  const propertyName = PSET_PROPERTY_NAMES[field];
  const propertyIds = parseRefList(pset.args[4] ?? "()");
  for (const propertyId of propertyIds) {
    const property = model.records.get(propertyId);
    if (property?.entity !== "IFCPROPERTYSINGLEVALUE") continue;
    const name = unquoteStep(property.args[0] ?? "");
    const sameField = name === propertyName || (field === "numberOfRisers" && name === "NumberOfRisers");
    if (!sameField) continue;
    if (parseTypedValue(property.args[2] ?? "$").numeric !== undefined) return false;
    property.args[2] = formatFlightPropertyValue(field, value);
    return true;
  }
  const propertyId = allocateId();
  model.records.set(propertyId, {
    id: propertyId,
    entity: "IFCPROPERTYSINGLEVALUE",
    args: [quoteStep(propertyName), "$", formatFlightPropertyValue(field, value), "$"],
    raw: ""
  });
  pset.args[4] = formatRefList([...propertyIds, propertyId]);
  return true;
}

function formatFlightPropertyValue(field: StairFieldName, value: number): string {
  if (field === "numberOfRisers" || field === "numberOfTreads") return `IFCCOUNTMEASURE(${Math.round(value)}.)`;
  return `IFCPOSITIVELENGTHMEASURE(${formatStepNumber(value, false)})`;
}

function analyseFlight(
  record: ReturnType<typeof parseStep>["records"] extends Map<number, infer T> ? T : never,
  parent: ReturnType<typeof parseStep>["records"] extends Map<number, infer T> ? T | undefined : never,
  landingCount: number,
  parentValues: Partial<Record<StairFieldName, number>>,
  flightPsetValues: Partial<Record<StairFieldName, number>>,
  geometry: StairGeometryEvidence | undefined,
  tolerance: StairTolerance,
  model: ReturnType<typeof parseStep>
): StairFlightAnalysis {
  const evidence: string[] = [];
  const nativeValues = Object.fromEntries(
    (Object.keys(FIELD_ARGS) as StairFieldName[]).map((field) => [field, parseOptionalNumber(record.args[FIELD_ARGS[field]])])
  ) as Partial<Record<StairFieldName, number>>;
  const existing = Object.fromEntries(
    (Object.keys(FIELD_ARGS) as StairFieldName[]).map((field) => [field, nativeValues[field] ?? validFallbackValue(field, flightPsetValues[field])])
  ) as Partial<Record<StairFieldName, number>>;
  const geometryValues = calculateGeometryValues(geometry, tolerance, evidence);
  const tessellatedValues = calculateTessellatedCounts(record, model, tolerance, parentValues.riserHeight, evidence);
  const fields = {} as Record<StairFieldName, StairFieldAnalysis>;

  for (const field of Object.keys(FIELD_ARGS) as StairFieldName[]) {
    const current = nativeValues[field];
    const geometric = tessellatedValues[field] ?? geometryValues[field];
    const parentValue = parentValues[field];
    const flightPsetValue = validFallbackValue(field, flightPsetValues[field]);
    if (current !== undefined) {
      const comparison = geometric ?? flightPsetValue ?? ((field === "riserHeight" || field === "treadLength") ? parentValue : undefined);
      fields[field] = fieldResult(current, current, "EXISTING", "High", comparison, tolerance, field);
      continue;
    }
    if (flightPsetValue !== undefined) {
      const comparison = geometric ?? ((field === "riserHeight" || field === "treadLength") ? parentValue : undefined);
      fields[field] = fieldResult(flightPsetValue, flightPsetValue, "FLIGHT_PSET", "High", comparison, tolerance, field);
      evidence.push(`${FIELD_LABELS[field]} already exists in Pset_StairFlightCommon with value ${flightPsetValue}.`);
      continue;
    }
    if (geometric !== undefined) {
      const comparison = (field === "riserHeight" || field === "treadLength") ? parentValue : undefined;
      const confirmedByParent = comparison !== undefined && valuesMatch(field, geometric, comparison, tolerance);
      const source = tessellatedValues[field] !== undefined
        ? "TESSELLATED_GEOMETRY"
        : confirmedByParent
        ? "PARENT_CONFIRMED"
        : field === "numberOfTreads"
          ? "DERIVED"
          : "GEOMETRY";
      fields[field] = fieldResult(undefined, geometric, source, "High", comparison, tolerance, field);
      continue;
    }
    if ((field === "riserHeight" || field === "treadLength") && parentValue !== undefined) {
      fields[field] = { calculated: parentValue, value: parentValue, source: "PARENT_FALLBACK", confidence: "Medium" };
      evidence.push(`${FIELD_LABELS[field]} uses parent Pset_StairCommon value ${parentValue}.`);
      continue;
    }
    fields[field] = { source: "UNRESOLVED", confidence: "None" };
  }

  const conflicts = Object.values(fields).some((field) => field.conflict);
  const missingFields = (Object.keys(fields) as StairFieldName[]).filter((field) => existing[field] === undefined);
  const repairableFields = missingFields.filter((field) => fields[field].value !== undefined && fields[field].confidence !== "None" && !fields[field].conflict);
  const unresolved = missingFields.filter((field) => fields[field].value === undefined);
  const noParent = !parent;
  let status: StairFlightAnalysis["status"];
  if (conflicts) status = "Conflict";
  else if (missingFields.length === 0) status = "Already Complete";
  else if (repairableFields.length === missingFields.length) status = "Ready to Repair";
  else if (repairableFields.length > 0) status = "Partial";
  else if (noParent || geometry) status = "Manual Review";
  else status = "Cannot Calculate";
  if (noParent) evidence.push("Flight is not related to an IfcStair through IfcRelAggregates.");
  if (!geometry) evidence.push("No usable triangulated geometry was available for this flight.");
  if (unresolved.length) evidence.push(`Unresolved: ${unresolved.map((field) => FIELD_LABELS[field]).join(", ")}.`);

  return {
    expressId: record.id,
    globalId: unquoteStep(record.args[0] ?? ""),
    name: unquoteStep(record.args[2] ?? "") || `#${record.id}`,
    parentStairId: parent?.id,
    parentStairName: parent ? unquoteStep(parent.args[2] ?? "") || `#${parent.id}` : "Unassigned",
    landingCount,
    fields,
    status,
    evidence,
    repairableFields
  };
}

function calculateTessellatedCounts(
  flight: ReturnType<typeof parseStep>["records"] extends Map<number, infer T> ? T : never,
  model: ReturnType<typeof parseStep>,
  tolerance: StairTolerance,
  parentRiserHeight: number | undefined,
  evidence: string[]
): Partial<Record<StairFieldName, number>> {
  const representationId = parseRef(flight.args[6] ?? "");
  const representation = representationId === undefined ? undefined : model.records.get(representationId);
  if (representation?.entity !== "IFCPRODUCTDEFINITIONSHAPE") return {};
  const upwardLevels: number[] = [];
  for (const shapeId of parseRefList(representation.args[2] ?? "")) {
    const shape = model.records.get(shapeId);
    if (shape?.entity !== "IFCSHAPEREPRESENTATION") continue;
    for (const itemId of parseRefList(shape.args[3] ?? "")) {
      const faceSet = model.records.get(itemId);
      if (faceSet?.entity !== "IFCPOLYGONALFACESET") continue;
      const pointListId = parseRef(faceSet.args[0] ?? "");
      const pointList = pointListId === undefined ? undefined : model.records.get(pointListId);
      if (pointList?.entity !== "IFCCARTESIANPOINTLIST3D") continue;
      const points = parsePointList3D(pointList.args[0] ?? "");
      for (const faceId of parseRefList(faceSet.args[2] ?? "")) {
        const face = model.records.get(faceId);
        if (face?.entity !== "IFCINDEXEDPOLYGONALFACE") continue;
        const indices = parseIndexList(face.args[0] ?? "");
        const vertices = indices.map((index) => points[index - 1]).filter((point): point is { x: number; y: number; z: number } => Boolean(point));
        if (vertices.length < 3) continue;
        const minZ = Math.min(...vertices.map((point) => point.z));
        const maxZ = Math.max(...vertices.map((point) => point.z));
        if (maxZ - minZ > tolerance.elevation) continue;
        const normalZ = polygonNormalZ(vertices);
        if (normalZ <= tolerance.dimension * tolerance.dimension) continue;
        upwardLevels.push(average(vertices.map((point) => point.z)));
      }
    }
  }
  if (upwardLevels.length === 0) return {};
  const mergeDistance = parentRiserHeight === undefined
    ? tolerance.elevation
    : Math.max(tolerance.elevation, parentRiserHeight * 0.25);
  const levels = clusterNumericLevels(upwardLevels, mergeDistance);
  if (levels.length === 0) return {};
  const numberOfTreads = levels.length;
  const numberOfRisers = numberOfTreads + 1;
  evidence.push(`Tessellated stair faces contain ${numberOfTreads} upward tread level${numberOfTreads === 1 ? "" : "s"}; inferred ${numberOfRisers} risers.`);
  return { numberOfRisers, numberOfTreads };
}

function parsePointList3D(value: string): Array<{ x: number; y: number; z: number }> {
  const trimmed = value.trim();
  if (!trimmed.startsWith("(") || !trimmed.endsWith(")")) return [];
  return splitStepArgs(trimmed.slice(1, -1)).map((tuple) => {
    const inner = tuple.trim().replace(/^\(/, "").replace(/\)$/, "");
    const values = splitStepArgs(inner).map(Number);
    return { x: values[0], y: values[1], z: values[2] };
  }).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z));
}

function parseIndexList(value: string): number[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("(") || !trimmed.endsWith(")")) return [];
  return splitStepArgs(trimmed.slice(1, -1)).map(Number).filter(Number.isInteger);
}

function polygonNormalZ(vertices: Array<{ x: number; y: number }>): number {
  let value = 0;
  for (let index = 0; index < vertices.length; index += 1) {
    const current = vertices[index];
    const next = vertices[(index + 1) % vertices.length];
    value += current.x * next.y - next.x * current.y;
  }
  return value / 2;
}

function clusterNumericLevels(values: number[], tolerance: number): number[] {
  const groups: number[][] = [];
  for (const value of [...values].sort((a, b) => a - b)) {
    let group: number[] | undefined;
    for (let index = groups.length - 1; index >= 0; index -= 1) {
      if (Math.abs(average(groups[index]) - value) <= tolerance) {
        group = groups[index];
        break;
      }
    }
    if (group) group.push(value);
    else groups.push([value]);
  }
  return groups.map(average);
}

function calculateGeometryValues(
  geometry: StairGeometryEvidence | undefined,
  tolerance: StairTolerance,
  evidence: string[]
): Partial<Record<StairFieldName, number>> {
  if (!geometry || geometry.vertexCount < 3 || geometry.horizontalLevels.length < 2) return {};
  const levels = [...geometry.horizontalLevels].sort((a, b) => a - b);
  const riserDiffs = consecutiveDiffs(levels).filter((value) => value > tolerance.elevation);
  const riserHeight = stableMedian(riserDiffs, tolerance);
  if (riserHeight === undefined) {
    evidence.push("Horizontal elevations are not regular enough for a straight-flight calculation.");
    return {};
  }
  const riserHeightMetres = riserHeight * tolerance.unitScaleToMetres;
  if (riserHeightMetres < 0.05 || riserHeightMetres > 0.4) {
    evidence.push(`Ignored implausible geometry riser spacing ${formatEvidenceNumber(riserHeight)}; expected 50-400 mm.`);
    return {};
  }
  const totalRise = geometry.maxZ - geometry.minZ;
  const riserRatio = totalRise / riserHeight;
  const numberOfRisers = Math.round(riserRatio);
  const validRiserCount = numberOfRisers > 0 && Math.abs(riserRatio - numberOfRisers) <= Math.max(0.08, numberOfRisers * tolerance.relative);

  const centres = [...geometry.levelCentres].sort((a, b) => a.z - b.z);
  const vectors = centres.slice(1).map((point, index) => ({ x: point.x - centres[index].x, y: point.y - centres[index].y }));
  const lengths = vectors.map((vector) => Math.hypot(vector.x, vector.y)).filter((value) => value > tolerance.dimension);
  const treadLength = stableMedian(lengths, tolerance);
  const treadLengthMetres = treadLength === undefined ? undefined : treadLength * tolerance.unitScaleToMetres;
  const plausibleTreadLength = treadLengthMetres !== undefined && treadLengthMetres >= 0.1 && treadLengthMetres <= 2;
  const straight = plausibleTreadLength && vectorsAreStraight(vectors, tolerance.straightDirectionCosine);

  evidence.push(`Geometry rise ${formatEvidenceNumber(totalRise)}; repeated riser spacing ${formatEvidenceNumber(riserHeight)}.`);
  if (plausibleTreadLength && treadLength !== undefined) evidence.push(`Repeated horizontal spacing ${formatEvidenceNumber(treadLength)} across ${centres.length} tread levels.`);
  else if (treadLength !== undefined) evidence.push(`Ignored implausible geometry tread spacing ${formatEvidenceNumber(treadLength)}; expected 100-2000 mm.`);
  if (!straight && lengths.length > 1) evidence.push("Horizontal step directions or spacing are irregular; tread calculations require manual review.");

  const result: Partial<Record<StairFieldName, number>> = { riserHeight };
  if (validRiserCount) result.numberOfRisers = numberOfRisers;
  if (straight && treadLength !== undefined) {
    result.treadLength = treadLength;
    if (validRiserCount && numberOfRisers > 1) result.numberOfTreads = numberOfRisers - 1;
  }
  return result;
}

function fieldResult(
  existing: number | undefined,
  value: number,
  source: StairValueSource,
  confidence: StairConfidence,
  comparison: number | undefined,
  tolerance: StairTolerance,
  field: StairFieldName
): StairFieldAnalysis {
  const result: StairFieldAnalysis = { existing, calculated: existing === undefined ? value : comparison, value, source, confidence };
  const matches = comparison === undefined || valuesMatch(field, value, comparison, tolerance);
  if (comparison !== undefined && !matches) {
    result.conflict = `${FIELD_LABELS[field]} ${value} conflicts with ${comparison}.`;
  }
  return result;
}

function buildParentLinks(model: ReturnType<typeof parseStep>) {
  const childToParent = new Map<number, number>();
  const parentToChildren = new Map<number, number[]>();
  for (const record of model.records.values()) {
    if (record.entity !== "IFCRELAGGREGATES") continue;
    const parent = parseRef(record.args[4] ?? "");
    if (parent === undefined || model.records.get(parent)?.entity !== "IFCSTAIR") continue;
    const children = parseRefList(record.args[5] ?? "");
    parentToChildren.set(parent, [...(parentToChildren.get(parent) ?? []), ...children]);
    for (const child of children) childToParent.set(child, parent);
  }
  return { childToParent, parentToChildren };
}

function buildPropertyIndex(model: ReturnType<typeof parseStep>): Map<number, number[]> {
  const index = new Map<number, number[]>();
  for (const record of model.records.values()) {
    if (record.entity !== "IFCRELDEFINESBYPROPERTIES") continue;
    const pset = parseRef(record.args[5] ?? "");
    if (pset === undefined) continue;
    for (const objectId of parseRefList(record.args[4] ?? "")) index.set(objectId, [...(index.get(objectId) ?? []), pset]);
  }
  return index;
}

function readStairProperties(psetIds: number[], model: ReturnType<typeof parseStep>): Partial<Record<StairFieldName, number>> {
  return readNamedStairProperties(psetIds, model, "Pset_StairCommon");
}

function readStairFlightProperties(psetIds: number[], model: ReturnType<typeof parseStep>): Partial<Record<StairFieldName, number>> {
  return readNamedStairProperties(psetIds, model, "Pset_StairFlightCommon");
}

function readNamedStairProperties(
  psetIds: number[],
  model: ReturnType<typeof parseStep>,
  propertySetName: "Pset_StairCommon" | "Pset_StairFlightCommon"
): Partial<Record<StairFieldName, number>> {
  const result: Partial<Record<StairFieldName, number>> = {};
  const mapping: Record<string, StairFieldName> = {
    NumberOfRiser: "numberOfRisers",
    NumberOfRisers: "numberOfRisers",
    NumberOfTreads: "numberOfTreads",
    RiserHeight: "riserHeight",
    TreadLength: "treadLength"
  };
  for (const psetId of psetIds) {
    const pset = model.records.get(psetId);
    if (!pset || unquoteStep(pset.args[2] ?? "") !== propertySetName) continue;
    for (const propertyId of parseRefList(pset.args[4] ?? "")) {
      const property = model.records.get(propertyId);
      if (property?.entity !== "IFCPROPERTYSINGLEVALUE") continue;
      const field = mapping[unquoteStep(property.args[0] ?? "")];
      const numeric = parseTypedValue(property.args[2] ?? "$" ).numeric;
      if (field && numeric !== undefined) result[field] = numeric;
    }
  }
  return result;
}

function buildParentValidations(
  model: ReturnType<typeof parseStep>,
  links: ReturnType<typeof buildParentLinks>,
  flights: StairFlightAnalysis[],
  psets: Map<number, number[]>
): StairParentValidation[] {
  const byId = new Map(flights.map((flight) => [flight.expressId, flight]));
  const results: StairParentValidation[] = [];
  for (const [parentId, children] of links.parentToChildren) {
    const parent = model.records.get(parentId)!;
    const flightIds = children.filter((id) => model.records.get(id)?.entity === "IFCSTAIRFLIGHT");
    const landingIds = children.filter((id) => model.records.get(id)?.entity === "IFCSLAB" && parseEnum(model.records.get(id)!.args[8] ?? "") === "LANDING");
    const parentValues = readStairProperties(psets.get(parentId) ?? [], model);
    const expectedRisers = parentValues.numberOfRisers;
    const expectedTreads = parentValues.numberOfTreads;
    const values = flightIds.map((id) => byId.get(id)?.fields.numberOfRisers.value);
    const treadValues = flightIds.map((id) => byId.get(id)?.fields.numberOfTreads.value);
    const risersComplete = values.every((value) => value !== undefined);
    const treadsComplete = treadValues.every((value) => value !== undefined);
    const calculatedRisers = risersComplete ? (values as number[]).reduce((sum, value) => sum + value, 0) : undefined;
    const calculatedTreads = treadsComplete ? (treadValues as number[]).reduce((sum, value) => sum + value, 0) : undefined;
    const calculatedHorizontalStages = calculatedTreads === undefined ? undefined : calculatedTreads + landingIds.length;
    let status: StairParentValidation["status"] = "No parent data";
    let message = "Parent stair count properties are not available.";
    const hasParentCounts = expectedRisers !== undefined || expectedTreads !== undefined;
    const incomplete = (expectedRisers !== undefined && calculatedRisers === undefined) || (expectedTreads !== undefined && calculatedHorizontalStages === undefined);
    const risersConflict = expectedRisers !== undefined && calculatedRisers !== undefined && expectedRisers !== calculatedRisers;
    const treadsConflict =
      expectedTreads !== undefined &&
      calculatedTreads !== undefined &&
      expectedTreads !== calculatedTreads &&
      expectedTreads !== calculatedHorizontalStages;
    if (hasParentCounts && incomplete) {
      status = "Incomplete";
      message = "One or more child flight counts remain unresolved, so the parent totals cannot be fully checked.";
    } else if (risersConflict || treadsConflict) {
      status = "Conflict";
      message = `Child totals: ${calculatedRisers ?? "unresolved"} risers, ${calculatedTreads ?? "unresolved"} treads, and ${calculatedHorizontalStages ?? "unresolved"} horizontal stages including landings; parent reports ${expectedRisers ?? "not set"} risers and ${expectedTreads ?? "not set"} treads.`;
    } else if (hasParentCounts) {
      status = "Pass";
      const treadConvention =
        expectedTreads === undefined
          ? "treads not checked"
          : expectedTreads === calculatedTreads
            ? `${calculatedTreads} flight treads (landings excluded)`
            : `${calculatedHorizontalStages} horizontal stages (landings included)`;
      message = `Child totals match the parent: ${calculatedRisers ?? "risers not checked"} risers and ${treadConvention}.`;
    }
    results.push({ expressId: parentId, name: unquoteStep(parent.args[2] ?? "") || `#${parentId}`, flightIds, landingIds, expectedRisers, calculatedRisers, expectedTreads, calculatedTreads, calculatedHorizontalStages, status, message });
  }
  return results;
}

function detectLengthUnit(model: ReturnType<typeof parseStep>): { label: "mm" | "m"; scaleToMetres: number } {
  const project = [...model.records.values()].find((record) => record.entity === "IFCPROJECT");
  const assignmentId = parseRef(project?.args[8] ?? "");
  const assignment = assignmentId === undefined ? undefined : model.records.get(assignmentId);
  const unitIds = assignment?.entity === "IFCUNITASSIGNMENT" ? parseRefList(assignment.args[0] ?? "") : [];
  for (const unitId of unitIds) {
    const record = model.records.get(unitId);
    if (!record) continue;
    if (record.entity !== "IFCSIUNIT" || parseEnum(record.args[1] ?? "") !== "LENGTHUNIT") continue;
    const prefix = parseEnum(record.args[2] ?? "");
    const name = parseEnum(record.args[3] ?? "");
    if (name === "METRE" && prefix === "MILLI") return { label: "mm", scaleToMetres: 0.001 };
    if (name === "METRE" && (record.args[2]?.trim() === "$" || !prefix)) return { label: "m", scaleToMetres: 1 };
  }
  return { label: "m", scaleToMetres: 1 };
}

function validateStairRepair(
  originalText: string,
  repairedText: string,
  changes: StairRepairResult["report"]["changes"],
  originals: Map<number, string[]>
): ValidationResult {
  const blockingErrors: string[] = [];
  const checks: string[] = [];
  const warnings: string[] = [];
  let repaired: ReturnType<typeof parseStep>;
  try {
    repaired = parseStep(repairedText);
    checks.push("Repaired IFC STEP data parsed successfully.");
  } catch (error) {
    return { passed: false, blockingErrors: [error instanceof Error ? error.message : String(error)], warnings, checks };
  }
  const original = parseStep(originalText);
  const repairedPsets = buildPropertyIndex(repaired);
  for (const [id, oldArgs] of originals) {
    const before = original.records.get(id);
    const after = repaired.records.get(id);
    if (!before || !after || after.entity !== "IFCSTAIRFLIGHT") {
      blockingErrors.push(`#${id} is missing or no longer an IfcStairFlight.`);
      continue;
    }
    for (let index = 0; index < Math.max(oldArgs.length, after.args.length); index += 1) {
      const isTarget = Object.values(FIELD_ARGS).includes(index);
      if (!isTarget && oldArgs[index] !== after.args[index]) blockingErrors.push(`#${id} changed unrelated argument ${index + 1}.`);
    }
  }
  for (const change of changes) {
    const value = parseOptionalNumber(repaired.records.get(change.expressId)?.args[FIELD_ARGS[change.field]]);
    if (value === undefined || Math.abs(value - change.newValue) > 1e-8) blockingErrors.push(`#${change.expressId} ${FIELD_LABELS[change.field]} was not written correctly.`);
    const propertyValue = readStairFlightProperties(repairedPsets.get(change.expressId) ?? [], repaired)[change.field];
    if (propertyValue === undefined || Math.abs(propertyValue - change.newValue) > 1e-8) blockingErrors.push(`#${change.expressId} ${FIELD_LABELS[change.field]} was not written to Pset_StairFlightCommon correctly.`);
  }
  if (changes.length === 0) warnings.push("No missing fields had sufficient evidence to repair.");
  else checks.push(`${changes.length} repaired IfcStairFlight values were re-read from both native attributes and Pset_StairFlightCommon.`);
  return { passed: blockingErrors.length === 0, blockingErrors, warnings, checks };
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (!value || isMissing(value)) return undefined;
  const numeric = Number(value.trim());
  return Number.isFinite(numeric) ? numeric : parseTypedValue(value).numeric;
}

function isMissing(value: string | undefined): boolean {
  return !value || value.trim() === "$" || value.trim() === "*";
}

function consecutiveDiffs(values: number[]): number[] {
  return values.slice(1).map((value, index) => value - values[index]);
}

function stableMedian(values: number[], tolerance: StairTolerance): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const allowed = Math.max(tolerance.dimension, Math.abs(median) * tolerance.relative);
  return values.every((value) => Math.abs(value - median) <= allowed) ? average(values) : undefined;
}

function vectorsAreStraight(vectors: Array<{ x: number; y: number }>, cosineThreshold: number): boolean {
  const usable = vectors.filter((vector) => Math.hypot(vector.x, vector.y) > 0);
  if (usable.length < 1) return false;
  const base = usable[0];
  const baseLength = Math.hypot(base.x, base.y);
  return usable.every((vector) => (base.x * vector.x + base.y * vector.y) / (baseLength * Math.hypot(vector.x, vector.y)) >= cosineThreshold);
}

function approximatelyEqual(a: number, b: number, tolerance: StairTolerance): boolean {
  return Math.abs(a - b) <= Math.max(tolerance.dimension, Math.max(Math.abs(a), Math.abs(b)) * tolerance.relative);
}

function valuesMatch(field: StairFieldName, a: number, b: number, tolerance: StairTolerance): boolean {
  return field === "numberOfRisers" || field === "numberOfTreads" ? Math.abs(a - b) <= 0.01 : approximatelyEqual(a, b, tolerance);
}

function validFallbackValue(field: StairFieldName, value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  if ((field === "numberOfRisers" || field === "numberOfTreads") && !Number.isInteger(value)) return undefined;
  return value;
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatStepNumber(value: number, integer: boolean): string {
  if (integer) return String(Math.round(value));
  const rounded = Math.round(value * 1e9) / 1e9;
  return Number.isInteger(rounded) ? `${rounded}.` : String(rounded);
}

function formatEvidenceNumber(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

function detectSchema(text: string): string {
  return text.match(/FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/i)?.[1]?.toUpperCase() ?? "";
}
