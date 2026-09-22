import { IfcAPI, IFCSTAIRFLIGHT } from "web-ifc";
import { checkRequiredProperties, inspectIfc, matchSpaces, repairIfc, validateRepairedIfc } from "./ifc-engine";
import { analyseStairFlights, repairStairFlights, toleranceForUnit } from "./stair-engine";
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

async function analyseStairsWithGeometry(text: string, filename: string) {
  const api = await getIfcApi();
  const modelId = api.OpenModel(new TextEncoder().encode(text));
  try {
    const metadata = analyseStairFlights(text, filename);
    const tolerance = toleranceForUnit(metadata.unitScaleToMetres);
    const geometry = [] as import("./types").StairGeometryEvidence[];
    api.StreamAllMeshesWithTypes(modelId, [IFCSTAIRFLIGHT], (mesh) => {
      const vertices: Array<{ x: number; y: number; z: number }> = [];
      const horizontalTriangles: Array<{ x: number; y: number; z: number; area: number }> = [];
      for (let itemIndex = 0; itemIndex < mesh.geometries.size(); itemIndex += 1) {
        const placed = mesh.geometries.get(itemIndex);
        const shape = api.GetGeometry(modelId, placed.geometryExpressID);
        try {
          const rawVertices = api.GetVertexArray(shape.GetVertexData(), shape.GetVertexDataSize());
          const indices = api.GetIndexArray(shape.GetIndexData(), shape.GetIndexDataSize());
          const transformed: Array<{ x: number; y: number; z: number }> = [];
          for (let offset = 0; offset < rawVertices.length; offset += 6) {
            const point = transformPoint(rawVertices[offset], rawVertices[offset + 1], rawVertices[offset + 2], placed.flatTransformation);
            transformed.push(point);
            vertices.push(point);
          }
          for (let index = 0; index + 2 < indices.length; index += 3) {
            const a = transformed[indices[index]];
            const b = transformed[indices[index + 1]];
            const c = transformed[indices[index + 2]];
            if (!a || !b || !c) continue;
            const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
            const ac = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
            const normal = {
              x: ab.y * ac.z - ab.z * ac.y,
              y: ab.z * ac.x - ab.x * ac.z,
              z: ab.x * ac.y - ab.y * ac.x
            };
            const doubleArea = Math.hypot(normal.x, normal.y, normal.z);
            if (doubleArea === 0 || Math.abs(normal.z) / doubleArea < tolerance.horizontalNormal) continue;
            horizontalTriangles.push({ x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3, z: (a.z + b.z + c.z) / 3, area: doubleArea / 2 });
          }
        } finally {
          shape.delete();
        }
      }
      const groups = clusterHorizontalTriangles(horizontalTriangles, tolerance.elevation);
      let minZ = Number.POSITIVE_INFINITY;
      let maxZ = Number.NEGATIVE_INFINITY;
      for (const point of vertices) {
        minZ = Math.min(minZ, point.z);
        maxZ = Math.max(maxZ, point.z);
      }
      geometry.push({
        expressId: mesh.expressID,
        horizontalLevels: groups.map((group) => group.z),
        levelCentres: groups.map((group) => ({ x: group.x, y: group.y, z: group.z })),
        minZ: vertices.length ? minZ : 0,
        maxZ: vertices.length ? maxZ : 0,
        vertexCount: vertices.length,
        geometryCount: mesh.geometries.size()
      });
    });
    return analyseStairFlights(text, filename, geometry);
  } finally {
    api.CloseModel(modelId);
  }
}

function transformPoint(x: number, y: number, z: number, matrix: Array<number>) {
  return {
    x: matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    y: matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    z: matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]
  };
}

function clusterHorizontalTriangles(triangles: Array<{ x: number; y: number; z: number; area: number }>, tolerance: number) {
  const sorted = [...triangles].sort((a, b) => a.z - b.z);
  const groups: Array<{ x: number; y: number; z: number; area: number }> = [];
  for (const triangle of sorted) {
    let group: { x: number; y: number; z: number; area: number } | undefined;
    for (let index = groups.length - 1; index >= 0; index -= 1) {
      if (Math.abs(groups[index].z - triangle.z) <= tolerance) {
        group = groups[index];
        break;
      }
    }
    if (!group) {
      groups.push({ ...triangle });
      continue;
    }
    const total = group.area + triangle.area;
    group.x = (group.x * group.area + triangle.x * triangle.area) / total;
    group.y = (group.y * group.area + triangle.y * triangle.area) / total;
    group.z = (group.z * group.area + triangle.z * triangle.area) / total;
    group.area = total;
  }
  return groups;
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

    if (type === "analyse-stairs") {
      const text = payload.text ?? lastInspectedText;
      if (text === undefined) throw new Error("No IFC file has been inspected yet.");
      postMessage({ id, ok: true, value: await analyseStairsWithGeometry(text, payload.filename) });
    }

    if (type === "repair-stairs") {
      const text = payload.text ?? lastInspectedText;
      if (text === undefined) throw new Error("No IFC file has been inspected yet.");
      const repaired = repairStairFlights(text, payload.filename, payload.analysis);
      await reopenWithWebIfc(repaired.ifcText);
      repaired.report.validation.checks.push("Output reopened successfully with web-ifc/WebAssembly.");
      postMessage({ id, ok: true, value: repaired });
    }
  } catch (error) {
    postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
