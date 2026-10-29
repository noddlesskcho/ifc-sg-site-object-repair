import type { IfcInspection, MatchResult, PropertyCheckResult, RepairCategory, RepairResult, RepairSelection, SpaceInfo, StairAnalysisResult, StairRepairResult } from "./types";

type WorkerRequest =
  | { type: "inspect"; payload: { bytes: ArrayBuffer; filename: string; fileSize: number } }
  | {
      type: "match";
      payload: { spaces: SpaceInfo[]; searches: Record<RepairCategory, string>; skipped: RepairCategory[]; selected: Partial<Record<RepairCategory, number[]>> };
    }
  | { type: "properties"; payload: { text?: string; selections: RepairSelection[] } }
  | { type: "repair"; payload: { text?: string; filename: string; selections: RepairSelection[]; warningsAccepted: boolean } }
  | { type: "analyse-stairs"; payload: { text?: string; filename: string } }
  | { type: "repair-stairs"; payload: { text?: string; filename: string; analysis: StairAnalysisResult } };

const WORKER_TEXT_HANDLE = "__IFC_SOURCE_HELD_BY_WORKER__";

export class IfcWorkerClient {
  private worker = new Worker(new URL("./ifc-worker.ts", import.meta.url), { type: "module" });
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: unknown) => void }>();
  // The source text stays exclusively in the worker. The page stores this small opaque handle
  // instead of receiving another full copy of a potentially very large IFC string.
  private lastInspectedText: string | undefined;

  constructor() {
    this.worker.onmessage = (event) => {
      const { id, ok, value, error } = event.data;
      const waiter = this.pending.get(id);
      if (!waiter) return;
      this.pending.delete(id);
      if (ok) waiter.resolve(value);
      else waiter.reject(new Error(error));
    };
  }

  inspect(file: File) {
    return file.arrayBuffer().then((bytes) => this.doInspect(bytes, file.name, file.size));
  }

  inspectBuffer(bytes: ArrayBuffer, filename: string, fileSize: number) {
    return this.doInspect(bytes, filename, fileSize);
  }

  private doInspect(bytes: ArrayBuffer, filename: string, fileSize: number) {
    // Transfer (not copy) the buffer -- the caller doesn't need it back, and for a large
    // file a structured-clone copy across to the worker is a real, avoidable cost.
    return this.call<{ inspection: IfcInspection }>({ type: "inspect", payload: { bytes, filename, fileSize } }, [bytes]).then((value) => {
      this.lastInspectedText = WORKER_TEXT_HANDLE;
      return { inspection: value.inspection, text: WORKER_TEXT_HANDLE };
    });
  }

  match(spaces: SpaceInfo[], searches: Record<RepairCategory, string>, skipped: RepairCategory[], selected: Partial<Record<RepairCategory, number[]>>) {
    return this.call<MatchResult[]>({ type: "match", payload: { spaces, searches, skipped, selected } });
  }

  properties(text: string, selections: RepairSelection[]) {
    return this.call<PropertyCheckResult[]>({ type: "properties", payload: { text: this.textForWorker(text), selections } });
  }

  repair(text: string, filename: string, selections: RepairSelection[], warningsAccepted: boolean) {
    return this.call<RepairResult>({ type: "repair", payload: { text: this.textForWorker(text), filename, selections, warningsAccepted } });
  }

  analyseStairs(text: string, filename: string) {
    return this.call<StairAnalysisResult>({ type: "analyse-stairs", payload: { text: this.textForWorker(text), filename } });
  }

  repairStairs(text: string, filename: string, analysis: StairAnalysisResult) {
    return this.call<StairRepairResult>({ type: "repair-stairs", payload: { text: this.textForWorker(text), filename, analysis } });
  }

  private textForWorker(text: string): string | undefined {
    return text === this.lastInspectedText ? undefined : text;
  }

  private call<T>(request: WorkerRequest, transfer: Transferable[] = []): Promise<T> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.worker.postMessage({ id, ...request }, transfer);
    });
  }
}
