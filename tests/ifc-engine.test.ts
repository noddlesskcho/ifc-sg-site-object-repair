import { describe, expect, it } from "vitest";
import { checkRequiredProperties, inspectIfc, matchSpaces, repairIfc, validateRepairedIfc } from "../src/ifc-engine";
import type { RepairSelection } from "../src/types";

const baseIfc = `ISO-10303-21;
HEADER;
FILE_NAME('Sample.ifc','2026-09-02T00:00:00',(''),(''),'test','Vitest Exporter','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('PROJECT',$,'Project',$,$,$,$,$,$);
#2= IFCOWNERHISTORY($,$,$,.ADDED.,$,$,$,0);
#10= IFCBUILDINGSTOREY('STOREY',$,'Ground',$,$,$,$,$,$);
#20= IFCREPRESENTATION($,$,$,());
#30= IFCLOCALPLACEMENT($,$);
#40= IFCSPACE('GID_COVERAGE',#2,'Coverage Name',$,$,#30,#20,'SITE COVERAGE AREA Test',.ELEMENT.,.INTERNAL.,$);
#41= IFCSPACE('GID_PLANTING',#2,'Planting Name',$,$,#30,#20,'GREEN BUFFER LINE',.ELEMENT.,.INTERNAL.,$);
#44= IFCSPACE('GID_PLANTING_STRIP',#2,'Planting Strip',$,$,#30,#20,'PLANTING STRIP',.ELEMENT.,.INTERNAL.,$);
#42= IFCSPACE('GID_BOUNDARY',#2,'Boundary Name',$,$,#30,#20,'SITE BOUNDARY',.ELEMENT.,.INTERNAL.,$);
#43= IFCSPACE('GID_DUPLICATE',#2,'Duplicate',$,$,#30,#20,'SITE BOUNDARY',.ELEMENT.,.INTERNAL.,$);
#50= IFCRELAGGREGATES('AGG',$,$,$,#10,(#40,#41,#44,#42,#43));
#60= IFCSPACETYPE('SPACE_TYPE',#2,'Room Text',$,$,$,$,'T',$,.INTERNAL.,$);
#61= IFCRELDEFINESBYTYPE('TYPE_REL',$,$,$,(#40,#41,#42),#60);
#70= IFCRELSPACEBOUNDARY('BOUNDARY_A',$,'2ndLevel','2a',#40,$,#20,.VIRTUAL.,.EXTERNAL.);
#71= IFCRELSPACEBOUNDARY('BOUNDARY_B',$,'2ndLevel','2a',#41,$,#20,.VIRTUAL.,.EXTERNAL.);
#80= IFCPROPERTYSINGLEVALUE('BroadLandUse',$,IFCTEXT('Residential'),$);
#81= IFCPROPERTYSINGLEVALUE('VacantLand',$,IFCBOOLEAN(.F.),$);
#82= IFCPROPERTYSET('PSET_BOUNDARY',#2,'SGPset_GeographicElement',$,(#80,#81));
#83= IFCRELDEFINESBYPROPERTIES('REL_BOUNDARY',$,$,$,(#42),#82);
#84= IFCPROPERTYSINGLEVALUE('Area',$,IFCAREAMEASURE(18.1),$);
#85= IFCPROPERTYSET('PSET_PLANTING_DIM',#2,'SGPset_GeographicElementDimension',$,(#84));
#86= IFCRELDEFINESBYPROPERTIES('REL_PLANTING_DIM',$,$,$,(#41),#85);
#87= IFCPROPERTYSET('QTO_SPACE',#2,'Qto_SpaceBaseQuantities',$,(#84));
#88= IFCRELDEFINESBYPROPERTIES('REL_QTO',$,$,$,(#41),#87);
ENDSEC;
END-ISO-10303-21;`;

const selections: RepairSelection[] = [
  { category: "siteCoverage", expressId: 40 },
  { category: "siteBoundary", expressId: 42 },
  { category: "plantingAreas", expressId: 41 }
];

describe("file reading and inspection", () => {
  it("reads valid IFC4 files", () => {
    const inspection = inspectIfc(baseIfc, "Sample.ifc", baseIfc.length);
    expect(inspection.schema).toBe("IFC4");
    expect(inspection.exporter).toBe("Vitest Exporter");
    expect(inspection.spaces).toHaveLength(5);
  });

  it("flags unsupported schemas", () => {
    const inspection = inspectIfc(baseIfc.replace("IFC4", "IFC2X3"));
    expect(inspection.status).toBe("error");
    expect(inspection.message).toContain("Unsupported schema");
  });

  it("rejects malformed and empty files", () => {
    expect(() => inspectIfc("")).toThrow("empty");
    expect(() => inspectIfc("ISO-10303-21; FILE_SCHEMA(('IFC4')); #10= IFCSPACE(")).toThrow();
  });
});

describe("inspection details", () => {
  it("resolves the containing storey for every space via the aggregation index", () => {
    const spaces = inspectIfc(baseIfc).spaces;
    expect(spaces).toHaveLength(5);
    for (const space of spaces) expect(space.storeyName).toBe("Ground");
  });
});

describe("matching", () => {
  const spaces = inspectIfc(baseIfc).spaces;

  it("supports exact, case-insensitive, and trimmed LongName matching", () => {
    const result = matchSpaces(spaces, {
      siteCoverage: " SITE COVERAGE AREA Test ",
      siteBoundary: "site boundary",
      plantingAreas: "GREEN BUFFER LINE"
    });
    expect(result[0].matches).toHaveLength(1);
    expect(result[1].status).toBe("Multiple matches");
    expect(result[2].status).toBe("Found");
  });

  it("reports no match, multiple matches, duplicate assignments, and skipped categories", () => {
    expect(matchSpaces(spaces, { siteCoverage: "None", siteBoundary: "", plantingAreas: "" })[0].status).toBe("Not found");
    const duplicate = matchSpaces(
      spaces,
      { siteCoverage: "SITE COVERAGE AREA Test", siteBoundary: "SITE BOUNDARY", plantingAreas: "GREEN BUFFER LINE" },
      new Set(),
      { siteCoverage: [40], siteBoundary: [40] }
    );
    expect(duplicate[1].status).toBe("Duplicate assignment");
    expect(matchSpaces(spaces, { siteCoverage: "", siteBoundary: "", plantingAreas: "" }, new Set(["plantingAreas"]))[2].status).toBe("Skipped");
  });

  it("keeps previous selections when another LongName is matched in the same category", () => {
    const first = matchSpaces(spaces, { siteCoverage: "", siteBoundary: "", plantingAreas: "GREEN BUFFER LINE" });
    expect(first[2].selectedIds).toEqual([41]);

    const second = matchSpaces(
      spaces,
      { siteCoverage: "", siteBoundary: "", plantingAreas: "PLANTING STRIP" },
      new Set(),
      { plantingAreas: first[2].selectedIds }
    );
    expect(second[2].status).toBe("Found");
    expect(second[2].selectedIds).toEqual([41, 44]);
  });
});

describe("property checks", () => {
  it("passes text values and Boolean false, and warns for missing planting properties", () => {
    const checks = checkRequiredProperties(baseIfc, selections);
    expect(checks.find((check) => check.property === "BroadLandUse")?.status).toBe("Passed");
    expect(checks.find((check) => check.property === "VacantLand")?.status).toBe("Passed");
    expect(checks.find((check) => check.property === "ApprovedSoilMixture")?.status).toBe("Missing property set");
  });

  it("handles Boolean true, unknown logical, empty text, whitespace text, wrong type, zero and negative area advisories, and capitalisation", () => {
    const variant = baseIfc
      .replace("IFCBOOLEAN(.F.)", "IFCBOOLEAN(.T.)")
      .replace("IFCTEXT('Residential')", "IFCLOGICAL(.U.)")
      .replace("IFCAREAMEASURE(18.1)", "IFCAREAMEASURE(0.)");
    const checks = checkRequiredProperties(variant, selections);
    expect(checks.find((check) => check.property === "VacantLand")?.status).toBe("Passed");
    expect(checks.find((check) => check.property === "BroadLandUse")?.status).toBe("No value");
    expect(checks.find((check) => check.property === "Area" && check.status === "Advisory")).toBeTruthy();

    const wrongType = baseIfc.replace("IFCBOOLEAN(.F.)", "IFCLABEL('false')");
    expect(checkRequiredProperties(wrongType, selections).find((check) => check.property === "VacantLand")?.status).toBe("Wrong data type");

    const blank = baseIfc.replace("IFCTEXT('Residential')", "IFCLABEL('   ')");
    expect(checkRequiredProperties(blank, selections).find((check) => check.property === "BroadLandUse")?.status).toBe("No value");

    const caseIssue = baseIfc.replace("SGPset_GeographicElement", "sgpset_geographicelement");
    expect(checkRequiredProperties(caseIssue, selections).find((check) => check.property === "BroadLandUse")?.status).toBe(
      "Incorrect property name capitalisation"
    );

    const negative = baseIfc.replace("IFCAREAMEASURE(18.1)", "IFCAREAMEASURE(-2.)");
    expect(checkRequiredProperties(negative, selections).find((check) => check.property === "Area" && check.status === "Advisory")).toBeTruthy();
  });

  it("accepts IfcLogical .T./.F. wherever IfcBoolean is expected, but not .U.", () => {
    const logicalFalse = baseIfc.replace("IFCBOOLEAN(.F.)", "IFCLOGICAL(.F.)");
    expect(checkRequiredProperties(logicalFalse, selections).find((check) => check.property === "VacantLand")?.status).toBe("Passed");

    const logicalTrue = baseIfc.replace("IFCBOOLEAN(.F.)", "IFCLOGICAL(.T.)");
    expect(checkRequiredProperties(logicalTrue, selections).find((check) => check.property === "VacantLand")?.status).toBe("Passed");

    const logicalUnknown = baseIfc.replace("IFCBOOLEAN(.F.)", "IFCLOGICAL(.U.)");
    expect(checkRequiredProperties(logicalUnknown, selections).find((check) => check.property === "VacantLand")?.status).toBe("No value");
  });
});

describe("IFC conversion and validation", () => {
  it("repairs entity mappings, preserves IDs and geometry, fixes relationships, and leaves the source unchanged", () => {
    const repaired = repairIfc(baseIfc, "Sample.ifc", selections, true);
    expect(repaired.ifcText).toContain("#40= IFCBUILDINGELEMENTPROXY('GID_COVERAGE'");
    expect(repaired.ifcText).toContain("'SITECOVERAGE',#30,#20");
    expect(repaired.ifcText).toContain("#42= IFCGEOGRAPHICELEMENT('GID_BOUNDARY'");
    expect(repaired.ifcText).toContain("'SITEBOUNDARY',#30,#20");
    expect(repaired.ifcText).toContain("#41= IFCGEOGRAPHICELEMENT('GID_PLANTING'");
    expect(repaired.ifcText).toContain("'PLANTINGAREAS',#30,#20");
    expect(repaired.ifcText).not.toContain("IFCRELSPACEBOUNDARY('BOUNDARY_A'");
    expect(repaired.ifcText).not.toContain("IFCRELSPACEBOUNDARY('BOUNDARY_B'");
    expect(repaired.ifcText).not.toContain("IFCRELDEFINESBYTYPE('TYPE_REL'");
    expect(repaired.ifcText).toContain("IFCRELCONTAINEDINSPATIALSTRUCTURE");
    expect(repaired.report.removedIncompatibleSets[0]).toContain("Qto_SpaceBaseQuantities");
    expect(baseIfc).toContain("#40= IFCSPACE");
    expect(repaired.report.validation.passed).toBe(true);
  });

  it("detects validation failures and dangling references", () => {
    const repaired = repairIfc(baseIfc, "Sample.ifc", selections, true).ifcText;
    const broken = repaired.replace("#20= IFCREPRESENTATION($,$,$,());\n", "");
    const validation = validateRepairedIfc(broken, selections, baseIfc);
    expect(validation.passed).toBe(false);
    expect(validation.blockingErrors.join(" ")).toContain("Dangling references");
  });

  it("uses the required download filename", () => {
    expect(repairIfc(baseIfc, "Source.ifc", selections, true).outputFilename).toBe("Source_IFCSG_Repaired.ifc");
  });

  it("generates a properly formed 22-character compressed-UUID GlobalId for new relationships", () => {
    const repaired = repairIfc(baseIfc, "Sample.ifc", selections, true).ifcText;
    const match = repaired.match(/IFCRELCONTAINEDINSPATIALSTRUCTURE\('([^']+)'/);
    expect(match).toBeTruthy();
    const guid = match![1];
    expect(guid).toHaveLength(22);
    expect(guid).toMatch(/^[0-9A-Za-z_$]{22}$/);
    // Generating it twice should not collide.
    const repairedAgain = repairIfc(baseIfc, "Sample.ifc", selections, true).ifcText;
    const guidAgain = repairedAgain.match(/IFCRELCONTAINEDINSPATIALSTRUCTURE\('([^']+)'/)![1];
    expect(guidAgain).not.toBe(guid);
  });

  it("does not report a dangling reference for a '#123'-looking token inside quoted text", () => {
    const withHashInText = baseIfc.replace("IFCTEXT('Residential')", "IFCTEXT('Unit #999 Residential')");
    const repaired = repairIfc(withHashInText, "Sample.ifc", selections, true).ifcText;
    const validation = validateRepairedIfc(repaired, selections, withHashInText);
    expect(validation.blockingErrors.join(" ")).not.toContain("Dangling references");
  });

  it("keeps a Qto_SpaceBaseQuantities relationship for an unselected space when it is shared with a selected one", () => {
    // #43 ("GID_DUPLICATE") is never in `selections`. Relating it to the same Qto set as
    // the selected #41 checks that repair only drops the selected object out of the
    // relationship instead of deleting the whole relationship (which would silently take
    // #43's quantities with it).
    const shared = baseIfc.replace(
      "#88= IFCRELDEFINESBYPROPERTIES('REL_QTO',$,$,$,(#41),#87);",
      "#88= IFCRELDEFINESBYPROPERTIES('REL_QTO',$,$,$,(#41,#43),#87);"
    );
    const repaired = repairIfc(shared, "Sample.ifc", selections, true);
    expect(repaired.ifcText).toContain("#88= IFCRELDEFINESBYPROPERTIES('REL_QTO',$,$,$,(#43),#87);");
    expect(repaired.report.removedIncompatibleSets[0]).toContain("retained for unselected objects");
  });

  it("still removes a Qto_SpaceBaseQuantities relationship entirely when every related space was selected", () => {
    const repaired = repairIfc(baseIfc, "Sample.ifc", selections, true);
    expect(repaired.ifcText).not.toContain("REL_QTO");
    expect(repaired.report.removedIncompatibleSets[0]).not.toContain("retained");
  });

  it("keeps every matched LongName when a category has more than one selected object", () => {
    const multiPlanting: RepairSelection[] = [...selections, { category: "plantingAreas", expressId: 44 }];
    const repaired = repairIfc(baseIfc, "Sample.ifc", multiPlanting, true);
    expect(repaired.report.matchedLongNames["Planting Areas"]).toEqual(["GREEN BUFFER LINE", "PLANTING STRIP"]);
  });

  it("rejects a repair call whose selections assign the same object to more than one category, even without going through the UI's own guard", () => {
    const duplicated: RepairSelection[] = [...selections, { category: "plantingAreas", expressId: 42 }];
    expect(() => repairIfc(baseIfc, "Sample.ifc", duplicated, true)).toThrow("more than one repair category");
  });
});
