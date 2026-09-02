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
  matchedLongNames: Record<string, string>;
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
  outputFilename: string;
  report: RepairReport;
}
