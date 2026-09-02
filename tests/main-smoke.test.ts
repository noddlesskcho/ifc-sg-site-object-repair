import { describe, expect, it } from "vitest";

describe("browser startup", () => {
  it("renders the initial screen without a startup exception", async () => {
    document.body.innerHTML = '<div id="app"></div>';
    await import("../src/main.ts");
    expect(document.querySelector("h1")?.textContent).toBe("Site Object Repair");
    expect(document.querySelector("#file")).toBeTruthy();
  });
});
