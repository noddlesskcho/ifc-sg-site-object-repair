import { IfcAPI } from "web-ifc";
import { checkRequiredProperties, inspectIfc, matchSpaces, repairIfc, validateRepairedIfc } from "./ifc-engine";
import type { RepairCategory, RepairSelection } from "./types";

let ifcApi: IfcAPI | undefined;

async function getIfcApi() {
  if (!ifcApi) {
    ifcApi = new IfcAPI();
    ifcApi.SetWasmPath("/wasm/");
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
      postMessage({ id, ok: true, value: checkRequiredProperties(payload.text, payload.selections as RepairSelection[]) });
    }

    if (type === "repair") {
      const repaired = repairIfc(payload.text, payload.filename, payload.selections as RepairSelection[], payload.warningsAccepted);
      await reopenWithWebIfc(repaired.ifcText);
      const webIfcValidation = validateRepairedIfc(repaired.ifcText, payload.selections as RepairSelection[], payload.text);
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
