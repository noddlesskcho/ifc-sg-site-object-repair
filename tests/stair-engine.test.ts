import { describe, expect, it } from "vitest";
import { analyseStairFlights, flightHasRepairWork, repairStairFlights, stairRepairPreconditionError, toleranceForUnit } from "../src/stair-engine";
import { nextStepId } from "../src/step-parser";
import type { StairGeometryEvidence } from "../src/types";

const stairIfc = `ISO-10303-21;
HEADER;
FILE_NAME('Stairs.ifc','2026-09-22T00:00:00',(''),(''),'test','Vitest Exporter','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('PROJECT',$,'Project',$,$,$,$,$,#4);
#2= IFCOWNERHISTORY($,$,$,.ADDED.,$,$,$,0);
#3= IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#4= IFCUNITASSIGNMENT((#3));
#10= IFCLOCALPLACEMENT($,$);
#20= IFCPRODUCTDEFINITIONSHAPE($,$,());
#30= IFCSTAIR('STAIR',#2,'ST01',$,$,#10,#20,'STAIR-TAG',.NOTDEFINED.);
#31= IFCSTAIRFLIGHT('FLIGHT',#2,'SS - 057',$,$,#10,#20,'FLIGHT-TAG',$,$,$,$,.NOTDEFINED.);
#32= IFCSLAB('LANDING',#2,'Landing',$,$,#10,#20,'LANDING-TAG',.LANDING.);
#40= IFCRELAGGREGATES('REL',#2,$,$,#30,(#31,#32));
#50= IFCPROPERTYSINGLEVALUE('NumberOfRiser',$,IFCINTEGER(6),$);
#51= IFCPROPERTYSINGLEVALUE('NumberOfTreads',$,IFCINTEGER(6),$);
#52= IFCPROPERTYSINGLEVALUE('RiserHeight',$,IFCLENGTHMEASURE(175.),$);
#53= IFCPROPERTYSINGLEVALUE('TreadLength',$,IFCLENGTHMEASURE(275.),$);
#54= IFCPROPERTYSET('PSET',#2,'Pset_StairCommon',$,(#50,#51,#52,#53));
#55= IFCRELDEFINESBYPROPERTIES('PSETREL',#2,$,$,(#30),#54);
ENDSEC;
END-ISO-10303-21;`;

const geometry: StairGeometryEvidence = {
  expressId: 31,
  horizontalLevels: [175, 350.0001, 525, 700, 875, 1050],
  levelCentres: [
    { x: 0, y: 0, z: 175 },
    { x: 275, y: 0, z: 350 },
    { x: 550, y: 0, z: 525 },
    { x: 825, y: 0, z: 700 },
    { x: 1100, y: 0, z: 875 },
    { x: 1375, y: 0, z: 1050 }
  ],
  minZ: 0,
  maxZ: 1050,
  vertexCount: 72,
  geometryCount: 1
};

const withFlightPropertySet = stairIfc.replace(
  "ENDSEC;\nEND-ISO-10303-21;",
  `#56= IFCPROPERTYSINGLEVALUE('NumberOfRiser',$,IFCCOUNTMEASURE(6.),$);
#57= IFCPROPERTYSINGLEVALUE('NumberOfTreads',$,IFCCOUNTMEASURE(5.),$);
#58= IFCPROPERTYSINGLEVALUE('RiserHeight',$,IFCPOSITIVELENGTHMEASURE(175.),$);
#59= IFCPROPERTYSINGLEVALUE('TreadLength',$,IFCPOSITIVELENGTHMEASURE(275.),$);
#60= IFCPROPERTYSET('FLIGHT_PSET',#2,'Pset_StairFlightCommon',$,(#56,#57,#58,#59));
#61= IFCRELDEFINESBYPROPERTIES('FLIGHT_PSET_REL',#2,$,$,(#31),#60);
ENDSEC;
END-ISO-10303-21;`
);

describe("IfcStairFlight analysis", () => {
  it("allocates an entity id without spreading a large IFC record collection", () => {
    const records = new Map<number, undefined>();
    for (let id = 1; id <= 150_000; id += 1) records.set(id, undefined);
    expect(nextStepId(records)).toBe(150_001);
  });

  it("follows IfcRelAggregates, detects landings and calculates a straight flight in project units", () => {
    const analysis = analyseStairFlights(stairIfc, "Stairs.ifc", [geometry]);
    expect(analysis.lengthUnit).toBe("mm");
    expect(analysis.flights).toHaveLength(1);
    const flight = analysis.flights[0];
    expect(flight.parentStairId).toBe(30);
    expect(flight.landingCount).toBe(1);
    expect(flight.fields.numberOfRisers.value).toBe(6);
    expect(flight.fields.numberOfTreads.value).toBe(5);
    expect(flight.fields.riserHeight.value).toBeCloseTo(175, 3);
    expect(flight.fields.treadLength.value).toBeCloseTo(275, 3);
    expect(flight.status).toBe("Ready to Repair");
    expect(analysis.parents[0].status).toBe("Pass");
    expect(analysis.parents[0].calculatedTreads).toBe(5);
    expect(analysis.parents[0].calculatedHorizontalStages).toBe(6);
  });

  it("accepts parent tread totals that exclude separate landing slabs", () => {
    const excludesLanding = stairIfc.replace("IFCINTEGER(6),$);\n#52", "IFCINTEGER(5),$);\n#52");
    const analysis = analyseStairFlights(excludesLanding, "Stairs.ifc", [geometry]);
    expect(analysis.parents[0].status).toBe("Pass");
    expect(analysis.parents[0].message).toContain("landings excluded");
  });

  it("repairs only missing native attributes and preserves every unrelated stair-flight argument", () => {
    const analysis = analyseStairFlights(stairIfc, "Stairs.ifc", [geometry]);
    const repaired = repairStairFlights(stairIfc, "Stairs.ifc", analysis, false, true);
    expect(repaired.ifcText).toContain("#31= IFCSTAIRFLIGHT('FLIGHT',#2,'SS - 057',$,$,#10,#20,'FLIGHT-TAG',6,5,175.,275.,.NOTDEFINED.);");
    expect(repaired.outputFilename).toBe("Stairs_repaired.ifc");
    expect(repaired.report.fieldsWritten).toBe(4);
    expect(repaired.report.propertyValuesWritten).toBe(4);
    expect(repaired.ifcText).toContain("'Pset_StairFlightCommon'");
    expect(repaired.ifcText).toContain("IFCPROPERTYSINGLEVALUE('NumberOfRiser',$,IFCCOUNTMEASURE(6.),$)");
    expect(repaired.ifcText).toContain("IFCPROPERTYSINGLEVALUE('RiserHeight',$,IFCPOSITIVELENGTHMEASURE(175.),$)");
    expect(repaired.report.validation.passed).toBe(true);
  });

  it("validates large-file repairs without reparsing duplicate full-file models", () => {
    const analysis = analyseStairFlights(stairIfc, "Stairs.ifc", [geometry]);
    const repaired = repairStairFlights(stairIfc, "Stairs.ifc", analysis, true, true);
    expect(repaired.report.validation.passed).toBe(true);
    expect(repaired.report.validation.checks[0]).toContain("without creating duplicate full-file parse trees");
    expect(repaired.ifcText).toContain("'FLIGHT-TAG',6,5,175.,275.,.NOTDEFINED.");
  });

  it("preserves existing values and reports a parent or geometry conflict instead of overwriting", () => {
    const withExisting = stairIfc.replace("'FLIGHT-TAG',$,$,$,$,.NOTDEFINED.", "'FLIGHT-TAG',7,$,$,$,.NOTDEFINED.");
    const analysis = analyseStairFlights(withExisting, "Stairs.ifc", [geometry]);
    expect(analysis.flights[0].fields.numberOfRisers.value).toBe(7);
    expect(analysis.flights[0].fields.numberOfRisers.conflict).toBeTruthy();
    expect(analysis.flights[0].status).toBe("Conflict");
    const repaired = repairStairFlights(withExisting, "Stairs.ifc", analysis, false, true);
    expect(repaired.ifcText).toContain("'FLIGHT-TAG',7,");
    expect(repaired.report.fieldsWritten).toBe(0);
    expect(repaired.report.propertyValuesWritten).toBe(0);
  });

  it("uses parent dimensions as a medium-confidence fallback but never copies parent counts to a flight", () => {
    const analysis = analyseStairFlights(stairIfc, "Stairs.ifc");
    const flight = analysis.flights[0];
    expect(flight.fields.riserHeight.source).toBe("PARENT_FALLBACK");
    expect(flight.fields.treadLength.source).toBe("PARENT_FALLBACK");
    expect(flight.fields.numberOfRisers.value).toBeUndefined();
    expect(flight.fields.numberOfTreads.value).toBeUndefined();
    expect(flight.status).toBe("Partial");
  });

  it("rejects tiny mesh-face spacing instead of treating it as stair geometry", () => {
    const noisyGeometry: StairGeometryEvidence = {
      expressId: 31,
      horizontalLevels: [0, 1.15],
      levelCentres: [{ x: 0, y: 0, z: 0 }, { x: 1.15, y: 0, z: 1.15 }],
      minZ: 0,
      maxZ: 1.15,
      vertexCount: 24,
      geometryCount: 1
    };
    const analysis = analyseStairFlights(stairIfc, "NoisyGeometry.ifc", [noisyGeometry]);
    const flight = analysis.flights[0];
    expect(flight.fields.numberOfRisers.value).toBeUndefined();
    expect(flight.fields.numberOfTreads.value).toBeUndefined();
    expect(flight.fields.riserHeight.value).toBe(175);
    expect(flight.fields.riserHeight.source).toBe("PARENT_FALLBACK");
    expect(flight.fields.treadLength.value).toBe(275);
    expect(flight.status).toBe("Partial");
    expect(flight.evidence).toContain("Ignored implausible geometry riser spacing 1.15; expected 50-400 mm.");
  });

  it("treats Pset_StairFlightCommon values as existing information and does not repair them", () => {
    const analysis = analyseStairFlights(withFlightPropertySet, "FlightPset.ifc");
    const flight = analysis.flights[0];
    expect(flight.fields.numberOfRisers.value).toBe(6);
    expect(flight.fields.numberOfTreads.value).toBe(5);
    expect(flight.fields.riserHeight.value).toBe(175);
    expect(flight.fields.treadLength.value).toBe(275);
    expect(flight.fields.numberOfRisers.source).toBe("FLIGHT_PSET");
    expect(flight.fields.numberOfRisers.existing).toBe(6);
    expect(flight.status).toBe("Already Complete");
    expect(flight.repairableFields).toEqual([]);

    const repaired = repairStairFlights(withFlightPropertySet, "FlightPset.ifc", analysis, false, true);
    expect(repaired.ifcText).toContain("'FLIGHT-TAG',$,$,$,$,.NOTDEFINED.");
    expect(repaired.report.fieldsWritten).toBe(0);
    expect(repaired.report.propertyValuesWritten).toBe(0);
    expect(repaired.ifcText).toContain("#56= IFCPROPERTYSINGLEVALUE('NumberOfRiser',$,IFCCOUNTMEASURE(6.),$);");
    expect(repaired.ifcText).toContain("#60= IFCPROPERTYSET('FLIGHT_PSET',#2,'Pset_StairFlightCommon',$,(#56,#57,#58,#59));");
  });

  it("does not repair complete native attributes or overwrite property-set values", () => {
    const complete = withFlightPropertySet.replace("'FLIGHT-TAG',$,$,$,$,.NOTDEFINED.", "'FLIGHT-TAG',6,5,175.,275.,.NOTDEFINED.");
    const analysis = analyseStairFlights(complete, "Complete.ifc");
    expect(analysis.flights[0].status).toBe("Already Complete");
    expect(analysis.flights[0].repairableFields).toEqual([]);

    const repaired = repairStairFlights(complete, "Complete.ifc", analysis, false, true);
    expect(repaired.report.fieldsWritten).toBe(0);
    expect(repaired.ifcText).toContain("'FLIGHT-TAG',6,5,175.,275.,.NOTDEFINED.");
    expect(repaired.ifcText).toContain("#56= IFCPROPERTYSINGLEVALUE('NumberOfRiser',$,IFCCOUNTMEASURE(6.),$);");
  });

  it("repairs only information absent from both native attributes and the flight property set", () => {
    const partial = stairIfc.replace("'FLIGHT-TAG',$,$,$,$,.NOTDEFINED.", "'FLIGHT-TAG',6,$,$,$,.NOTDEFINED.");
    const analysis = analyseStairFlights(partial, "Partial.ifc", [geometry]);
    const repaired = repairStairFlights(partial, "Partial.ifc", analysis, false, true);
    expect(repaired.report.fieldsWritten).toBe(3);
    expect(repaired.report.propertyValuesWritten).toBe(3);
    expect(repaired.ifcText).toContain("'FLIGHT-TAG',6,5,175.,275.,.NOTDEFINED.");
  });

  it("extends an existing flight property set without replacing its properties", () => {
    const statusOnly = stairIfc.replace(
      "ENDSEC;\nEND-ISO-10303-21;",
      `#56= IFCPROPERTYSINGLEVALUE('Status',$,IFCLABEL('EXISTING'),$);
#57= IFCPROPERTYSET('STATUS_PSET',#2,'Pset_StairFlightCommon',$,(#56));
#58= IFCRELDEFINESBYPROPERTIES('STATUS_REL',#2,$,$,(#31),#57);
ENDSEC;
END-ISO-10303-21;`
    );
    const analysis = analyseStairFlights(statusOnly, "StatusOnly.ifc", [geometry]);
    const repaired = repairStairFlights(statusOnly, "StatusOnly.ifc", analysis, false, true);
    expect(repaired.report.fieldsWritten).toBe(4);
    expect(repaired.report.propertyValuesWritten).toBe(4);
    expect(repaired.ifcText).toContain("IFCPROPERTYSINGLEVALUE('Status',$,IFCLABEL('EXISTING'),$)");
    expect(repaired.ifcText).toMatch(/IFCPROPERTYSET\('STATUS_PSET',#2,'Pset_StairFlightCommon',\$,\(#56,#\d+,#\d+,#\d+,#\d+\)\)/);
    expect(repaired.report.validation.passed).toBe(true);
  });

  it("supports metre projects with unit-scaled tolerances", () => {
    const metreIfc = stairIfc.replace(".MILLI.,.METRE.", "$,.METRE.");
    const metreGeometry: StairGeometryEvidence = {
      ...geometry,
      horizontalLevels: geometry.horizontalLevels.map((value) => value / 1000),
      levelCentres: geometry.levelCentres.map((point) => ({ x: point.x / 1000, y: point.y, z: point.z / 1000 })),
      minZ: 0,
      maxZ: 1.05
    };
    const analysis = analyseStairFlights(metreIfc, "Metre.ifc", [metreGeometry]);
    expect(analysis.lengthUnit).toBe("m");
    expect(analysis.flights[0].fields.riserHeight.value).toBeCloseTo(0.175, 4);
    expect(toleranceForUnit(1).elevation).toBeLessThan(0.001);
  });
});

const parentStairProperties = `#70= IFCPROPERTYENUMERATEDVALUE('Status',$,(IFCLABEL('EXISTING')),$);
#71= IFCPROPERTYSINGLEVALUE('ConstructionMethod',$,IFCLABEL('Cast in-situ'),$);
#72= IFCPROPERTYSINGLEVALUE('MaterialGrade',$,IFCLABEL('C32/40'),$);
#73= IFCPROPERTYSINGLEVALUE('AmendmentStatus',$,IFCLABEL('Added'),$);
#74= IFCPROPERTYSET('SG_STAIR',#2,'SGPset_Stair',$,(#70,#71,#72,#73));
#75= IFCRELDEFINESBYPROPERTIES('SG_STAIR_REL',#2,$,$,(#30),#74);
#76= IFCPROPERTYSINGLEVALUE('ConstructionMethod',$,IFCLABEL('-'),$);
#77= IFCPROPERTYSET('SG_FLIGHT',#2,'SGPset_StairFlight',$,(#76));
#78= IFCRELDEFINESBYPROPERTIES('SG_FLIGHT_REL',#2,$,$,(#31),#77);
ENDSEC;
END-ISO-10303-21;`;
const withParentProperties = stairIfc.replace("ENDSEC;\nEND-ISO-10303-21;", parentStairProperties);

// One straight flight whose mesh carries a joint face 25 mm below the top tread, as Archicad
// exports where a flight meets a landing slab.
function tessellatedFlightIfc(parentProperties: string) {
  const treadLevels = [175, 350, 525, 700, 875, 1050, 1025];
  const points = treadLevels.flatMap((z, index) => [`(${index * 275},0.,${z}.)`, `(${index * 275 + 275},0.,${z}.)`, `(${index * 275 + 275},1000.,${z}.)`, `(${index * 275},1000.,${z}.)`]);
  const faces = treadLevels.map((_, index) => `#${200 + index}= IFCINDEXEDPOLYGONALFACE((${index * 4 + 1},${index * 4 + 2},${index * 4 + 3},${index * 4 + 4}));`);
  return `ISO-10303-21;
HEADER;
FILE_NAME('Mesh.ifc','2026-10-29T00:00:00',(''),(''),'test','Vitest Exporter','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('PROJECT',$,'Project',$,$,$,$,$,#4);
#2= IFCOWNERHISTORY($,$,$,.ADDED.,$,$,$,0);
#3= IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#4= IFCUNITASSIGNMENT((#3));
#10= IFCLOCALPLACEMENT($,$);
#20= IFCPRODUCTDEFINITIONSHAPE($,$,());
#21= IFCPRODUCTDEFINITIONSHAPE($,$,(#22));
#22= IFCSHAPEREPRESENTATION($,'Body','Tessellation',(#23));
#23= IFCPOLYGONALFACESET(#24,$,(${faces.map((_, index) => `#${200 + index}`).join(",")}),$);
#24= IFCCARTESIANPOINTLIST3D((${points.join(",")}),$);
${faces.join("\n")}
#30= IFCSTAIR('STAIR',#2,'ST01',$,$,#10,#20,'STAIR-TAG',.NOTDEFINED.);
#31= IFCSTAIRFLIGHT('FLIGHT',#2,'SS - 081',$,$,#10,#21,'FLIGHT-TAG',$,$,$,$,.NOTDEFINED.);
#40= IFCRELAGGREGATES('REL',#2,$,$,#30,(#31));
${parentProperties}
ENDSEC;
END-ISO-10303-21;`;
}

describe("IfcStair parent rules", () => {
  it("blocks repair and reports when the file has no IfcStair", () => {
    const noStair = stairIfc
      .replace("#30= IFCSTAIR('STAIR',#2,'ST01',$,$,#10,#20,'STAIR-TAG',.NOTDEFINED.);\n", "")
      .replace("#40= IFCRELAGGREGATES('REL',#2,$,$,#30,(#31,#32));\n", "");
    const analysis = analyseStairFlights(noStair, "NoStair.ifc", [geometry]);
    expect(analysis.repairBlocked).toBe(true);
    expect(analysis.blockers.map((blocker) => blocker.code)).toEqual(["NO_IFCSTAIR"]);
    expect(analysis.blockers[0].message).toContain("No IfcStair was found");
    expect(analysis.flights[0].status).toBe("Blocked");
    expect(analysis.flights[0].repairableFields).toEqual([]);
    expect(flightHasRepairWork(analysis.flights[0])).toBe(false);
    expect(() => repairStairFlights(noStair, "NoStair.ifc", analysis, false, true)).toThrow(/No IfcStair was found/);
  });

  it("reports an IfcStairFlight used as a parent stair and leaves that stair unrepaired", () => {
    const flightParent = withParentProperties.replace(
      "ENDSEC;\nEND-ISO-10303-21;",
      `#80= IFCSTAIRFLIGHT('WRONG_PARENT',#2,'ST02',$,$,#10,#20,'WRONG-TAG',$,$,$,$,.NOTDEFINED.);
#81= IFCSTAIRFLIGHT('CHILD',#2,'SS - 090',$,$,#10,#20,'CHILD-TAG',$,$,$,$,.NOTDEFINED.);
#82= IFCRELAGGREGATES('WRONG_REL',#2,$,$,#80,(#81));
ENDSEC;
END-ISO-10303-21;`
    );
    const analysis = analyseStairFlights(flightParent, "FlightParent.ifc", [geometry]);
    expect(analysis.repairBlocked).toBe(false);
    const blocker = analysis.blockers.find((item) => item.code === "STAIRFLIGHT_AS_PARENT");
    expect(blocker?.elements.map((element) => element.expressId)).toEqual([80]);
    expect(analysis.flights.find((flight) => flight.expressId === 80)?.status).toBe("Blocked");
    expect(analysis.flights.find((flight) => flight.expressId === 81)?.status).toBe("Blocked");
    expect(analysis.flights.find((flight) => flight.expressId === 31)?.status).toBe("Ready to Repair");

    const repaired = repairStairFlights(flightParent, "FlightParent.ifc", analysis);
    expect(repaired.ifcText).toContain("#80= IFCSTAIRFLIGHT('WRONG_PARENT',#2,'ST02',$,$,#10,#20,'WRONG-TAG',$,$,$,$,.NOTDEFINED.);");
    expect(repaired.ifcText).toContain("#81= IFCSTAIRFLIGHT('CHILD',#2,'SS - 090',$,$,#10,#20,'CHILD-TAG',$,$,$,$,.NOTDEFINED.);");
    expect(repaired.report.blockers.map((item) => item.code)).toContain("STAIRFLIGHT_AS_PARENT");
    expect(repaired.report.validation.passed).toBe(true);
  });

  it("lists missing parent values and requires confirmation before repair", () => {
    const analysis = analyseStairFlights(stairIfc, "Stairs.ifc", [geometry]);
    expect(analysis.missingParentProperties).toEqual([
      expect.objectContaining({ expressId: 30, missing: ["Status", "ConstructionMethod", "MaterialGrade", "AmendmentStatus"] })
    ]);
    expect(stairRepairPreconditionError(analysis, false)).toContain("Confirm they are intentionally left out");
    expect(stairRepairPreconditionError(analysis, true)).toBeUndefined();
    expect(() => repairStairFlights(stairIfc, "Stairs.ifc", analysis)).toThrow(/intentionally left out/);
    const repaired = repairStairFlights(stairIfc, "Stairs.ifc", analysis, false, true);
    expect(repaired.report.confirmedOmissions[0].missing).toContain("AmendmentStatus");
  });

  it("leaves riser height and tread length empty when the parent stair does not set them", () => {
    const noDimensions = withParentProperties.replace(",#52,#53));", "));");
    const analysis = analyseStairFlights(noDimensions, "NoDimensions.ifc", [geometry]);
    const flight = analysis.flights[0];
    expect(flight.fields.riserHeight.value).toBeUndefined();
    expect(flight.fields.treadLength.value).toBeUndefined();
    expect(flight.fields.numberOfRisers.value).toBe(6);
    expect(flight.repairableFields).toEqual(["numberOfRisers", "numberOfTreads"]);
    expect(analysis.missingParentProperties[0].missing).toEqual(["RiserHeight", "TreadLength"]);
  });

  it("copies Status, ConstructionMethod, MaterialGrade and AmendmentStatus from the parent IfcStair", () => {
    const analysis = analyseStairFlights(withParentProperties, "Inherit.ifc", [geometry]);
    expect(analysis.missingParentProperties).toEqual([]);
    const inherited = Object.fromEntries(analysis.flights[0].inheritedProperties.map((property) => [property.name, property]));
    expect(inherited.ConstructionMethod.action).toBe("Inherit");
    expect(inherited.ConstructionMethod.propertySet).toBe("SGPset_StairFlight");
    expect(inherited.Status.propertySet).toBe("Pset_StairFlightCommon");

    const repaired = repairStairFlights(withParentProperties, "Inherit.ifc", analysis);
    expect(repaired.report.validation.passed).toBe(true);
    expect(repaired.report.inheritedPropertiesWritten).toBe(4);
    expect(repaired.report.propertyChanges.find((change) => change.property === "ConstructionMethod")).toMatchObject({ oldValue: "Missing", newValue: "Cast in-situ" });
    // The parent's own properties stay untouched; the child's "-" placeholder is swapped out of its set.
    expect(repaired.ifcText).toContain("#71= IFCPROPERTYSINGLEVALUE('ConstructionMethod',$,IFCLABEL('Cast in-situ'),$);");
    expect(repaired.ifcText).toContain("#74= IFCPROPERTYSET('SG_STAIR',#2,'SGPset_Stair',$,(#70,#71,#72,#73));");
    expect(repaired.ifcText).not.toContain("#77= IFCPROPERTYSET('SG_FLIGHT',#2,'SGPset_StairFlight',$,(#76");
    expect(repaired.ifcText).toMatch(/IFCPROPERTYENUMERATEDVALUE\('Status',\$,\(IFCLABEL\('EXISTING'\)\),\$\)/);
  });

  it("keeps a child value that differs from the parent and reports it", () => {
    const differs = withParentProperties.replace("#76= IFCPROPERTYSINGLEVALUE('ConstructionMethod',$,IFCLABEL('-'),$);", "#76= IFCPROPERTYSINGLEVALUE('ConstructionMethod',$,IFCLABEL('Precast'),$);");
    const analysis = analyseStairFlights(differs, "Differs.ifc", [geometry]);
    const constructionMethod = analysis.flights[0].inheritedProperties.find((property) => property.name === "ConstructionMethod");
    expect(constructionMethod?.action).toBe("Kept (differs from parent)");
    const repaired = repairStairFlights(differs, "Differs.ifc", analysis);
    expect(repaired.ifcText).toContain("#77= IFCPROPERTYSET('SG_FLIGHT',#2,'SGPset_StairFlight',$,(#76");
    expect(repaired.report.propertyChanges.some((change) => change.property === "ConstructionMethod")).toBe(false);
  });

  it("does not count a landing joint face as an extra step when the parent has no riser height", () => {
    const parentWithoutDimensions = `#50= IFCPROPERTYSINGLEVALUE('NumberOfRiser',$,IFCINTEGER(7),$);
#54= IFCPROPERTYSET('PSET',#2,'Pset_StairCommon',$,(#50));
#55= IFCRELDEFINESBYPROPERTIES('PSETREL',#2,$,$,(#30),#54);`;
    const analysis = analyseStairFlights(tessellatedFlightIfc(parentWithoutDimensions), "Mesh.ifc");
    const flight = analysis.flights[0];
    expect([flight.fields.numberOfRisers.value, flight.fields.numberOfTreads.value]).toEqual([7, 6]);
    expect(flight.evidence.some((item) => item.startsWith("Estimated riser spacing 175"))).toBe(true);
  });
});
