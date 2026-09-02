import type { ConversionMapping, RepairCategory, RequiredProperty } from "./types";

export const CONVERSION_MAPPINGS: Record<RepairCategory, ConversionMapping> = {
  siteCoverage: {
    category: "siteCoverage",
    label: "Site Coverage",
    entity: "IFCBUILDINGELEMENTPROXY",
    entityLabel: "IfcBuildingElementProxy",
    predefinedType: "USERDEFINED",
    objectType: "SITECOVERAGE"
  },
  siteBoundary: {
    category: "siteBoundary",
    label: "Site Boundary",
    entity: "IFCGEOGRAPHICELEMENT",
    entityLabel: "IfcGeographicElement",
    predefinedType: "USERDEFINED",
    objectType: "SITEBOUNDARY"
  },
  plantingAreas: {
    category: "plantingAreas",
    label: "Planting Areas",
    entity: "IFCGEOGRAPHICELEMENT",
    entityLabel: "IfcGeographicElement",
    predefinedType: "USERDEFINED",
    objectType: "PLANTINGAREAS"
  }
};

export const REQUIRED_PROPERTIES: RequiredProperty[] = [
  {
    category: "siteBoundary",
    propertySet: "SGPset_GeographicElement",
    property: "BroadLandUse",
    expectedType: "IfcLabel or compatible text value"
  },
  {
    category: "siteBoundary",
    propertySet: "SGPset_GeographicElement",
    property: "VacantLand",
    expectedType: "IfcBoolean"
  },
  {
    category: "plantingAreas",
    propertySet: "SGPset_GeographicElementDimension",
    property: "Area",
    expectedType: "IfcAreaMeasure"
  },
  {
    category: "plantingAreas",
    propertySet: "SGPset_GeographicElement",
    property: "ApprovedSoilMixture",
    expectedType: "IfcBoolean"
  },
  {
    category: "plantingAreas",
    propertySet: "SGPset_GeographicElement",
    property: "Status",
    expectedType: "IfcLabel or compatible text"
  },
  {
    category: "plantingAreas",
    propertySet: "SGPset_GeographicElement",
    property: "Turf",
    expectedType: "IfcBoolean"
  },
  {
    category: "plantingAreas",
    propertySet: "SGPset_GeographicElement",
    property: "TurfSpecies",
    expectedType: "IfcLabel or compatible text"
  },
  {
    category: "plantingAreas",
    propertySet: "SGPset_GeographicElement",
    property: "Compensated",
    expectedType: "IfcBoolean"
  },
  {
    category: "plantingAreas",
    propertySet: "SGPset_GeographicElement",
    property: "Encroachment",
    expectedType: "IfcBoolean"
  },
  {
    category: "plantingAreas",
    propertySet: "SGPset_GeographicElement",
    property: "CarparkProvision",
    expectedType: "IfcBoolean"
  }
];

export const CATEGORY_ORDER: RepairCategory[] = ["siteCoverage", "siteBoundary", "plantingAreas"];
