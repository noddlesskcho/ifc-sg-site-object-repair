import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { IfcAPI } from "web-ifc";
import { inspectIfc, repairIfc } from "../src/ifc-engine";
import type { RepairSelection } from "../src/types";

const sourcePath = "C:/Users/ISS/Downloads/wetransfer_s2502_ar_lb-to-3rd-ifc_2026-09-02_0729/Site Boundary Test.ifc";

describe("web-ifc reopen validation", () => {
  it("reopens the repaired Archicad sample with web-ifc", async () => {
    const source = readFileSync(sourcePath, "utf8");
    const inspection = inspectIfc(source, "Site Boundary Test.ifc", source.length);
    const selections: RepairSelection[] = [
      { category: "siteCoverage", expressId: inspection.spaces.find((space) => space.longName === "SITE COVERAGE AREA Test")!.expressId },
      { category: "siteBoundary", expressId: inspection.spaces.find((space) => space.longName === "SITE BOUNDARY")!.expressId },
      { category: "plantingAreas", expressId: inspection.spaces.find((space) => space.longName === "GREEN BUFFER LINE")!.expressId }
    ];
    const repaired = repairIfc(source, "Site Boundary Test.ifc", selections, true);
    const api = new IfcAPI();
    await api.Init();
    const modelId = api.OpenModel(new TextEncoder().encode(repaired.ifcText));
    expect(api.GetModelSchema(modelId)).toBe("IFC4");
    api.CloseModel(modelId);
  });
});
