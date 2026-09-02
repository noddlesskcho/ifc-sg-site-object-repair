import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkRequiredProperties, inspectIfc, repairIfc } from "../src/ifc-engine";
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
