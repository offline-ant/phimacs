import type { Sink } from "../client.ts";
import { type MuxOptions, Mux } from "../mux.ts";
import { COMPANION_STATUS_KEY, type CompanionRecord, type JsonRecord, type SnapshotData } from "../protocol.ts";

/** A client connection that records every line it was handed. */
export class FakeSink implements Sink {
  records: JsonRecord[] = [];
  accepting = true;
  destroyed = false;
  private drain: (() => void) | undefined;

  write(data: string): boolean {
    for (const line of data.split("\n")) if (line) this.records.push(JSON.parse(line) as JsonRecord);
    return this.accepting;
  }

  onDrain(listener: () => void): void {
    this.drain = listener;
  }

  destroy(): void {
    this.destroyed = true;
  }

  release(): void {
    this.accepting = true;
    this.drain?.();
  }

  types(): unknown[] {
    return this.records.map((record) => record.type);
  }

  take(): JsonRecord[] {
    const records = this.records;
    this.records = [];
    return records;
  }
}

export function fakeMux(options: Partial<MuxOptions> = {}) {
  const toPi: JsonRecord[] = [];
  let statusChanges = 0;
  const mux = new Mux({
    muxId: "mux", socketPath: "/tmp/mux.sock", piPid: 42,
    writeToPi: (record) => toPi.push(record), onStatus: () => statusChanges++,
    ...options,
  });
  return {
    mux, toPi,
    statusChanges: () => statusChanges,
    pi: (record: JsonRecord): void => mux.piLine(JSON.stringify(record)),
    companion: (record: CompanionRecord): void => mux.piLine(JSON.stringify({
      type: "extension_ui_request", id: `status-${Math.random()}`, method: "setStatus", statusKey: COMPANION_STATUS_KEY, statusText: JSON.stringify(record),
    })),
  };
}

export const SESSION = { file: "/tmp/s.jsonl", id: "s1", name: null, cwd: "/tmp" };

export function snapshotData(extra: Partial<SnapshotData> = {}): SnapshotData {
  return { session: SESSION, model: { provider: "p", id: "m" }, thinkingLevel: "off", idle: true, leafId: "e2",
    entries: [{ id: "e1", parentId: null }], messages: [{ role: "user", content: "hi" }], ...extra };
}
