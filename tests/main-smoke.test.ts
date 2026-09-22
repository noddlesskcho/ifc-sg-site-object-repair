import { describe, expect, it } from "vitest";

describe("browser startup", () => {
  it("renders the initial screen without a startup exception", async () => {
    document.body.innerHTML = '<div id="app"></div>';
    await import("../src/main.ts");
    expect(document.querySelector("h1")?.textContent).toBe("ArchiCAD IFC Repair Tool");
    expect(document.querySelector(".subtitle")?.textContent).toContain("from Archicad models");
    expect(document.querySelector("#file")).toBeFalsy();
    expect(document.querySelectorAll(".mode-choice")).toHaveLength(2);
  });
});
