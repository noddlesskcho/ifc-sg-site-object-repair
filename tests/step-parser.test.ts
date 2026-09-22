import { describe, expect, it } from "vitest";
import { parseStep, serializeStep } from "../src/step-parser";

const header = "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n";
const footer = "ENDSEC;\nEND-ISO-10303-21;";

describe("STEP serialization", () => {
  it("preserves already ordered records and omits deleted records", () => {
    const model = parseStep(`${header}#1= IFCOWNERHISTORY($);\n#2= IFCPROJECT($);\n#3= IFCSITE($);\n${footer}`);
    const output = serializeStep(model, new Set([2]));

    expect(output.indexOf("#1=")).toBeLessThan(output.indexOf("#3="));
    expect(output).not.toContain("#2=");
  });

  it("sorts records when their map insertion order is not ascending", () => {
    const model = parseStep(`${header}#3= IFCSITE($);\n#1= IFCOWNERHISTORY($);\n#2= IFCPROJECT($);\n${footer}`);
    const output = serializeStep(model);

    expect(output.indexOf("#1=")).toBeLessThan(output.indexOf("#2="));
    expect(output.indexOf("#2=")).toBeLessThan(output.indexOf("#3="));
  });
});
