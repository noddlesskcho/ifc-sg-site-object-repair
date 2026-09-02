import type { IfcInspection, MatchResult, PropertyCheckResult, RepairCategory, RepairResult, RepairSelection, SpaceInfo } from "./types";

type WorkerRequest =
  | { type: "inspect"; payload: { bytes: ArrayBuffer; filename: string; fileSize: number } }
  | {
      type: "match";
      payload: { spaces: SpaceInfo[]; searches: Record<RepairCategory, string>; skipped: RepairCategory[]; selected: Partial<Record<RepairCategory, number[]>> };
    }
  | { type: "properties"; payload: { text: string; selections: RepairSelection[] } }
  | { type: "repair"; payload: { text: string; filename: string; selections: RepairSelection[]; warningsAccepted: boolean } };

export class IfcWorkerClient {
  private worker = new Worker(new URL("./ifc-worker.ts", import.meta.url), { type: "module" });
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: unknown) => void }>();

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
    return file.arrayBuffer().then((bytes) =>
      this.call<{ inspection: IfcInspection; text: string }>({ type: "inspect", payload: { bytes, filename: file.name, fileSize: file.size } })
    );
  }

  inspectBuffer(bytes: ArrayBuffer, filename: string, fileSize: number) {
    return this.call<{ inspection: IfcInspection; text: string }>({ type: "inspect", payload: { bytes, filename, fileSize } });
  }

  match(spaces: SpaceInfo[], searches: Record<RepairCategory, string>, skipped: RepairCategory[], selected: Partial<Record<RepairCategory, number[]>>) {
    return this.call<MatchResult[]>({ type: "match", payload: { spaces, searches, skipped, selected } });
  }

  properties(text: string, selections: RepairSelection[]) {
    return this.call<PropertyCheckResult[]>({ type: "properties", payload: { text, selections } });
  }

  repair(text: string, filename: string, selections: RepairSelection[], warningsAccepted: boolean) {
    return this.call<RepairResult>({ type: "repair", payload: { text, filename, selections, warningsAccepted } });
  }

  private call<T>(request: WorkerRequest): Promise<T> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.worker.postMessage({ id, ...request });
    });
  }
}
