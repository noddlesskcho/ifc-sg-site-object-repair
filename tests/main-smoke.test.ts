import { describe, expect, it } from "vitest";

describe("browser startup", () => {
  it("renders the initial screen without a startup exception", async () => {
    document.body.innerHTML = '<div id="app"></div>';
    await import("../src/main.ts");
    expect(document.querySelector("h1")?.textContent).toBe("IFC Repair Utility");
    expect(document.querySelector(".subtitle")?.textContent).toContain("from Archicad models");
    expect(document.querySelector("#file")).toBeTruthy();
    expect(document.querySelector(".upload.compact")).toBeFalsy();
    expect(document.querySelectorAll(".mode-tab")).toHaveLength(2);
  });
});
