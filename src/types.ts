export type RepairCategory = "siteCoverage" | "siteBoundary" | "plantingAreas";

export type StatusKind =
  | "waiting"
  | "reading"
  | "processing"
  | "warning"
  | "error"
  | "repair-completed"
  | "validation-passed"
  | "validation-failed";

export interface ConversionMapping {
  category: RepairCategory;
  label: string;
  entity: "IFCBUILDINGELEMENTPROXY" | "IFCGEOGRAPHICELEMENT";
  entityLabel: "IfcBuildingElementProxy" | "IfcGeographicElement";
  predefinedType: "USERDEFINED";
  objectType: "SITECOVERAGE" | "SITEBOUNDARY" | "PLANTINGAREAS";
}

export interface SpaceInfo {
  expressId: number;
  globalId: string;
  name: string;
  longName: string;
  objectType: string;
  predefinedType: string;
  storeyId?: number;
  storeyName?: string;
  area?: string;
}

export interface IfcInspection {
  filename: string;
  fileSize: number;
  schema: string;
  exporter: string;
  entityCount: number;
  spaces: SpaceInfo[];
  status: StatusKind;
  message?: string;
}

export interface MatchResult {
  category: RepairCategory;
  searchValue: string;
  status: "Found" | "Not found" | "Multiple matches" | "Skipped" | "Duplicate assignment";
  matches: SpaceInfo[];
  selectedIds: number[];
}

export interface RequiredProperty {
  category: RepairCategory;
  propertySet: string;
  property: string;
  expectedType: string;
}

export interface PropertyCheckResult extends RequiredProperty {
  expressId: number;
  globalId: string;
  longName: string;
  currentType: string;
  currentValue: string;
  status:
    | "Passed"
    | "Missing property set"
    | "Missing property"
    | "No value"
    | "Wrong data type"
    | "Incorrect property name capitalisation"
    | "Advisory";
  explanation: string;
}

export interface RepairSelection {
  category: RepairCategory;
  expressId: number;
}

export interface RepairReport {
  originalFilename: string;
  outputFilename: string;
  detectedSchema: string;
  objectsRepaired: number;
  repairedCategories: string[];
  skippedCategories: string[];
  matchedLongNames: Record<string, string[]>;
  entityChanges: Array<{
    category: string;
    expressId: number;
    globalId: string;
    oldEntity: string;
    newEntity: string;
    oldPredefinedType: string;
    newPredefinedType: string;
    oldObjectType: string;
    newObjectType: string;
  }>;
  relationshipChanges: string[];
  removedIncompatibleSets: string[];
  retainedPropertySets: string[];
  propertyWarnings: PropertyCheckResult[];
  warningsAccepted: boolean;
  validation: ValidationResult;
}

export interface ValidationResult {
  passed: boolean;
  blockingErrors: string[];
  warnings: string[];
  checks: string[];
}

export interface RepairResult {
  ifcText: string;
  ifcBytes?: ArrayBuffer;
  outputFilename: string;
  report: RepairReport;
}

export type StairFieldName = "numberOfRisers" | "numberOfTreads" | "riserHeight" | "treadLength";
export type StairValueSource =
  | "EXISTING"
  | "FLIGHT_PSET"
  | "GEOMETRY"
  | "TESSELLATED_GEOMETRY"
  | "PARENT_CONFIRMED"
  | "PARENT_FALLBACK"
  | "DERIVED"
  | "UNRESOLVED";
export type StairConfidence = "High" | "Medium" | "None";
export type StairAnalysisStatus = "Already Complete" | "Ready to Repair" | "Partial" | "Conflict" | "Manual Review" | "Cannot Calculate" | "Blocked";

export type StairBlockerCode = "NO_IFCSTAIR" | "STAIRFLIGHT_AS_PARENT" | "UNASSIGNED_FLIGHT";

export interface StairBlocker {
  code: StairBlockerCode;
  message: string;
  elements: Array<{ expressId: number; globalId: string; name: string; storeyName?: string }>;
}

/** Text properties a child IfcStairFlight takes over from its parent IfcStair. */
export type StairInheritedPropertyName = "Status" | "ConstructionMethod" | "MaterialGrade" | "AmendmentStatus";

export interface StairInheritedProperty {
  name: StairInheritedPropertyName;
  propertySet: string;
  parentValue?: string;
  parentPropertyId?: number;
  existingValue?: string;
  existingPropertyId?: number;
  action: "Inherit" | "Already Matches" | "Kept (differs from parent)" | "Parent Missing";
}

export interface StairGeometryEvidence {
  expressId: number;
  horizontalLevels: number[];
  levelCentres: Array<{ x: number; y: number; z: number }>;
  minZ: number;
  maxZ: number;
  vertexCount: number;
  geometryCount: number;
}

export interface StairFieldAnalysis {
  existing?: number;
  calculated?: number;
  value?: number;
  source: StairValueSource;
  confidence: StairConfidence;
  conflict?: string;
}

export interface StairFlightAnalysis {
  expressId: number;
  globalId: string;
  name: string;
  sourceEntity: "IFCSTAIRFLIGHT" | "IFCBUILDINGELEMENTPROXY";
  storeyName?: string;
  parentStairId?: number;
  parentStairName: string;
  landingCount: number;
  fields: Record<StairFieldName, StairFieldAnalysis>;
  status: StairAnalysisStatus;
  evidence: string[];
  repairableFields: StairFieldName[];
  inheritedProperties: StairInheritedProperty[];
}

export interface StairParentValidation {
  expressId: number;
  globalId: string;
  name: string;
  storeyName?: string;
  flightIds: number[];
  landingIds: number[];
  expectedRisers?: number;
  calculatedRisers?: number;
  landingTransitionRisers?: number;
  expectedTreads?: number;
  calculatedTreads?: number;
  calculatedHorizontalStages?: number;
  status: "Pass" | "Conflict" | "Incomplete" | "No parent data";
  message: string;
}

export interface StairAnalysisResult {
  filename: string;
  schema: string;
  lengthUnit: "mm" | "m";
  unitScaleToMetres: number;
  flights: StairFlightAnalysis[];
  parents: StairParentValidation[];
  /** Whole-file or per-stair conditions that stop automatic repair; reported, never fixed. */
  blockers: StairBlocker[];
  /** True when no IfcStair exists, so nothing in the file may be repaired. */
  repairBlocked: boolean;
  analysedAt: string;
}

export interface StairRepairReport {
  originalFilename: string;
  outputFilename: string;
  flightsAnalysed: number;
  flightsRepaired: number;
  fieldsWritten: number;
  propertyValuesWritten: number;
  entitiesConverted: number;
  conversions: Array<{ expressId: number; globalId: string; name: string; oldEntity: string; newEntity: string }>;
  changes: Array<{ expressId: number; name: string; field: StairFieldName; oldValue: string; newValue: number; source: StairValueSource }>;
  inheritedPropertiesWritten: number;
  propertyChanges: Array<{ expressId: number; name: string; propertySet: string; property: StairInheritedPropertyName; oldValue: string; newValue: string; parentStairId: number }>;
  blockers: StairBlocker[];
  validation: ValidationResult;
}

export interface StairRepairResult {
  ifcText: string;
  ifcBytes?: ArrayBuffer;
  outputFilename: string;
  report: StairRepairReport;
}
