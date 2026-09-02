import { IfcAPI } from "web-ifc";
import { checkRequiredProperties, inspectIfc, matchSpaces, repairIfc, validateRepairedIfc } from "./ifc-engine";
import type { RepairCategory, RepairSelection } from "./types";

let ifcApi: IfcAPI | undefined;
// Remembers the last inspected IFC text so "properties"/"repair" calls don't need to
// re-send the (potentially 100MB+) file text over postMessage every time -- the main
// thread only sends it explicitly when it differs from what this worker already has.
let lastInspectedText: string | undefined;

async function getIfcApi() {
  if (!ifcApi) {
    ifcApi = new IfcAPI();
    // import.meta.env.BASE_URL is always an absolute-from-domain-root prefix (see
    // vite.config.ts) -- "/" locally, or the repo subpath on GitHub Pages -- so this
    // resolves correctly regardless of where the site is actually served from, unlike a
    // hardcoded "/wasm/" which would 404 under a Pages project subpath.
    ifcApi.SetWasmPath(`${import.meta.env.BASE_URL}wasm/`);
    await ifcApi.Init();
  }
  return ifcApi;
}

async function reopenWithWebIfc(text: string) {
  const api = await getIfcApi();
  const bytes = new TextEncoder().encode(text);
  const modelId = api.OpenModel(bytes);
  const schema = api.GetModelSchema(modelId);
  api.CloseModel(modelId);
  return schema;
}

self.onmessage = async (event: MessageEvent) => {
  const { id, type, payload } = event.data;
  try {
    if (type === "inspect") {
      const text = new TextDecoder().decode(payload.bytes);
      lastInspectedText = text;
      const inspection = inspectIfc(text, payload.filename, payload.fileSize);
      if (inspection.schema.toUpperCase() === "IFC4") {
        await reopenWithWebIfc(text);
      }
      postMessage({ id, ok: true, value: { inspection, text } });
    }

    if (type === "match") {
      postMessage({
        id,
        ok: true,
        value: matchSpaces(payload.spaces, payload.searches as Record<RepairCategory, string>, new Set(payload.skipped), payload.selected)
      });
    }

    if (type === "properties") {
      const text = payload.text ?? lastInspectedText;
      if (text === undefined) throw new Error("No IFC file has been inspected yet.");
      postMessage({ id, ok: true, value: checkRequiredProperties(text, payload.selections as RepairSelection[]) });
    }

    if (type === "repair") {
      const text = payload.text ?? lastInspectedText;
      if (text === undefined) throw new Error("No IFC file has been inspected yet.");
      const repaired = repairIfc(text, payload.filename, payload.selections as RepairSelection[], payload.warningsAccepted);
      await reopenWithWebIfc(repaired.ifcText);
      const webIfcValidation = validateRepairedIfc(repaired.ifcText, payload.selections as RepairSelection[], text);
      repaired.report.validation = {
        ...webIfcValidation,
        checks: [...webIfcValidation.checks, "Output reopened successfully with web-ifc/WebAssembly."]
      };
      postMessage({ id, ok: true, value: repaired });
    }
  } catch (error) {
    postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
