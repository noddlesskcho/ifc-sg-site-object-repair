import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkRequiredProperties, inspectIfc, repairIfc } from "../src/ifc-engine";
import { analyseStairFlights, repairStairFlights } from "../src/stair-engine";
import type { RepairSelection } from "../src/types";

// These exercise the app against real Archicad/Revit sample exports that only exist on the
// original developer's machine. They previously hardcoded an absolute Windows path and would
// fail with ENOENT anywhere else (a fresh checkout, CI, another contributor's machine), which
// meant `pnpm test` wasn't actually portable. They now skip (not fail) when the files aren't
// present at those paths, and still run for real when they are.
const sourcePath = "C:/Users/ISS/Downloads/wetransfer_s2502_ar_lb-to-3rd-ifc_2026-09-02_0729/Site Boundary Test.ifc";
const referencePath = "C:/Users/ISS/Desktop/fORp&t.ifc";
const hasSamples = existsSync(sourcePath) && existsSync(referencePath);

describe.skipIf(!hasSamples)("supplied IFC files", () => {
  it("confirms the Revit reference mappings", () => {
    const reference = readFileSync(referencePath, "utf8");
    expect(reference).toContain("IFCBUILDINGELEMENTPROXY");
    expect(reference).toContain("'SITECOVERAGE'");
    expect(reference).toContain("IFCGEOGRAPHICELEMENT");
    expect(reference).toContain("'SITEBOUNDARY'");
    expect(reference).toContain("'PLANTINGAREAS'");
    expect(reference).toContain("IFCPROPERTYSINGLEVALUE('VacantLand',$,IFCBOOLEAN(.T.),$)");
  });

  it("repairs the Archicad sample in memory", () => {
    const source = readFileSync(sourcePath, "utf8");
    const inspection = inspectIfc(source, "Site Boundary Test.ifc", source.length);
    expect(inspection.schema).toBe("IFC4");

    const siteCoverage = inspection.spaces.find((space) => space.longName === "SITE COVERAGE AREA Test")!;
    const siteBoundary = inspection.spaces.find((space) => space.longName === "SITE BOUNDARY")!;
    const plantingAreas = inspection.spaces.find((space) => space.longName === "GREEN BUFFER LINE")!;
    expect(siteCoverage).toBeTruthy();
    expect(siteBoundary).toBeTruthy();
    expect(plantingAreas).toBeTruthy();

    const selections: RepairSelection[] = [
      { category: "siteCoverage", expressId: siteCoverage.expressId },
      { category: "siteBoundary", expressId: siteBoundary.expressId },
      { category: "plantingAreas", expressId: plantingAreas.expressId }
    ];
    const checks = checkRequiredProperties(source, selections);
    expect(checks.find((check) => check.category === "siteBoundary" && check.property === "BroadLandUse")?.status).toBe("Passed");
    expect(checks.find((check) => check.category === "siteBoundary" && check.property === "VacantLand")?.status).toBe("Passed");
    expect(checks.find((check) => check.category === "plantingAreas" && check.property === "Area")?.status).toBe("Passed");
    expect(checks.some((check) => check.category === "plantingAreas" && check.status === "Missing property")).toBe(true);

    const repaired = repairIfc(source, "Site Boundary Test.ifc", selections, true);
    expect(repaired.report.validation.passed).toBe(true);
    expect(repaired.ifcText).toContain(`#${siteCoverage.expressId}= IFCBUILDINGELEMENTPROXY`);
    expect(repaired.ifcText).toContain("'SITECOVERAGE'");
    expect(repaired.ifcText).toContain(`#${siteBoundary.expressId}= IFCGEOGRAPHICELEMENT`);
    expect(repaired.ifcText).toContain("'SITEBOUNDARY'");
    expect(repaired.ifcText).toContain(`#${plantingAreas.expressId}= IFCGEOGRAPHICELEMENT`);
    expect(repaired.ifcText).toContain("'PLANTINGAREAS'");
  });
});

const stairPath = "C:/Users/ISS/Documents/Corenet X/Missing IfcStairFlight/stairs_for checking.ifc";
const largeStairPath = "C:/Users/ISS/Documents/Corenet X/Example IFC files from Consultants/Sample model from ADDP/BLOCK 41.ifc";
const previouslyRepairedStairPaths = [
  "C:/Users/ISS/Downloads/stairs_for checking_StairFlight_Repaired.ifc",
  "C:/Users/ISS/Downloads/stairs_for checking_StairFlight_Repaired (1).ifc",
  "C:/Users/ISS/Downloads/stairs_for checking_StairFlight_Repaired (2).ifc",
  "C:/Users/ISS/Downloads/stairs_for checking_StairFlight_Repaired (3).ifc",
  "C:/Users/ISS/Downloads/stairs_for checking_StairFlight_Repaired (4).ifc"
].filter(existsSync);

describe.skipIf(!existsSync(stairPath))("supplied stair IFC file", () => {
  it("adds resolved dimensions to each existing Pset_StairFlightCommon", () => {
    const source = readFileSync(stairPath, "utf8");
    const analysis = analyseStairFlights(source, "stairs_for checking.ifc");
    expect(analysis.flights.map((flight) => [flight.expressId, flight.fields.numberOfRisers.value, flight.fields.numberOfTreads.value])).toEqual([
      [115, 2, 1],
      [157, 6, 5],
      [213, 8, 7],
      [234, 2, 1]
    ]);
    expect(analysis.parents[0].status).toBe("Pass");
    const repaired = repairStairFlights(source, "stairs_for checking.ifc", analysis);

    expect(repaired.report.validation.passed).toBe(true);
    expect(repaired.report.fieldsWritten).toBe(16);
    expect(repaired.report.propertyValuesWritten).toBe(16);
    expect(repaired.ifcText.match(/IFCPROPERTYSINGLEVALUE\('RiserHeight'/g)).toHaveLength(5);
    expect(repaired.ifcText.match(/IFCPROPERTYSINGLEVALUE\('TreadLength'/g)).toHaveLength(5);
    for (const statusPropertyId of [343, 356, 370, 383]) {
      expect(repaired.ifcText).toContain(`#${statusPropertyId}= IFCPROPERTYENUMERATEDVALUE('Status'`);
    }
    expect(repaired.ifcText).toMatch(/#115= IFCSTAIRFLIGHT\([^;]*,2,1,175\.,275\.,\.NOTDEFINED\.\);/);
    expect(repaired.ifcText).toMatch(/#157= IFCSTAIRFLIGHT\([^;]*,6,5,175\.,275\.,\.NOTDEFINED\.\);/);
    expect(repaired.ifcText).toMatch(/#213= IFCSTAIRFLIGHT\([^;]*,8,7,175\.,275\.,\.NOTDEFINED\.\);/);
    expect(repaired.ifcText).toMatch(/#234= IFCSTAIRFLIGHT\([^;]*,2,1,175\.,275\.,\.NOTDEFINED\.\);/);
  });
});

describe.skipIf(!existsSync(largeStairPath))("large supplied stair IFC file", () => {
  it("analyses and repairs without exceeding the JavaScript argument limit", () => {
    const source = readFileSync(largeStairPath, "utf8");
    const analysis = analyseStairFlights(source, "BLOCK 41.ifc");
    const repaired = repairStairFlights(source, "BLOCK 41.ifc", analysis);

    expect(analysis.flights.length).toBeGreaterThan(0);
    expect(repaired.report.flightsAnalysed).toBe(analysis.flights.length);
    expect(repaired.report.validation.passed).toBe(true);
  });
});

describe.skipIf(previouslyRepairedStairPaths.length === 0)("previously repaired stair IFC files", () => {
  it.each(previouslyRepairedStairPaths)("still recovers missing flight counts from %s", (path) => {
    const source = readFileSync(path, "utf8");
    const analysis = analyseStairFlights(source, path.split("/").at(-1) ?? "repaired.ifc");

    expect(analysis.flights.map((flight) => [flight.expressId, flight.fields.numberOfRisers.value, flight.fields.numberOfTreads.value])).toEqual([
      [115, 2, 1],
      [157, 6, 5],
      [213, 8, 7],
      [234, 2, 1]
    ]);
    expect(analysis.parents[0].status).toBe("Pass");
  });
});
