import assert from "node:assert/strict";
import test from "node:test";
import type { Client, Sink } from "./client.ts";
import { Mux } from "./mux.ts";
import { COMPANION_STATUS_KEY, isReadOnlyCommand, parseInputContext, type CompanionRecord, type JsonRecord, type SnapshotData } from "./protocol.ts";

class Output implements Sink {
  records: JsonRecord[] = [];
  accepting = true;
  private drain?: () => void;
  write(line: string): boolean { this.records.push(JSON.parse(line) as JsonRecord); return this.accepting; }
  onDrain(listener: () => void): void { this.drain = listener; }
  destroy(): void {}
  release(): void { this.accepting = true; this.drain?.(); }
}
const session = { file: "/synthetic/a.jsonl", id: "a", name: null, cwd: "/synthetic" };
function data(extra: Partial<SnapshotData> = {}): SnapshotData {
  return { session, leafId: "a-leaf", model: null, thinkingLevel: "off", idle: true, entries: [], messages: [], ...extra };
}
function fixture() {
  const writes: JsonRecord[] = [];
  let writeFailure = false;
  const mux = new Mux({ muxId: "context-test", socketPath: "/synthetic/socket", piPid: 1,
    writeToPi: (record) => { if (writeFailure) throw new Error("synthetic write failure"); writes.push(record); }, onStatus() {}, canAcceptCommands: () => true });
  const companion = (record: CompanionRecord): void => mux.piLine(JSON.stringify({ type: "extension_ui_request", method: "setStatus",
    statusKey: COMPANION_STATUS_KEY, statusText: JSON.stringify(record) }));
  const snapshot = (extra: Partial<SnapshotData> = {}): void => {
    const request = writes.findLast((record) => String(record.id).startsWith("pimux:"))!;
    companion({ kind: "snapshot", generation: Number(String(request.id).slice(6)), data: data(extra) });
  };
  const attach = (ready = true): { client: Client; output: Output } => {
    const output = new Output(), client = mux.addClient(output);
    if (ready) snapshot();
    return { client, output };
  };
  const send = (client: Client, record: JsonRecord): void => mux.clientLine(client, JSON.stringify(record));
  return { writes, mux, companion, snapshot, attach, send, failWrites: (): void => { writeFailure = true; } };
}

test("only explicit getters bypass the contextual command contract", () => {
  assert.equal(isReadOnlyCommand("get_available_thinking_levels"), true);
  for (const command of ["prompt", "abort", "clear_queue", "extension_ui_response", "future_mutation"]) assert.equal(isReadOnlyCommand(command), false);
  for (const value of [null, {}, { sessionFile: null, leafId: null, contextId: "" }, { sessionFile: 3, leafId: null, contextId: "x" }]) assert.equal(parseInputContext(value), undefined);
  assert.deepEqual(parseInputContext({ sessionFile: null, leafId: null, contextId: "root", ignored: true }), { sessionFile: null, leafId: null, contextId: "root" });
});

test("hello-only peers cannot mutate; safe getters and bootstrap remain available", () => {
  const f = fixture(), { client, output } = f.attach(false);
  assert.deepEqual(output.records.map((record) => record.type), ["pimux_hello"]);
  const before = f.writes.length;
  f.send(client, { type: "prompt", id: "early", message: "not authorized", pimuxContext: { sessionFile: session.file, leafId: "a-leaf", contextId: "guessed" } });
  assert.equal(f.writes.length, before);
  assert.equal(output.records.at(-1)?.delivery, "rejected");
  f.send(client, { type: "get_state", id: "read" });
  assert.equal(f.writes.at(-1)?.type, "get_state");
  f.snapshot();
  const context = f.mux.state.inputContext!;
  f.send(client, { type: "prompt", message: "authorized", pimuxContext: context });
  assert.equal(f.writes.at(-1)?.message, "authorized");
  assert.equal("pimuxContext" in f.writes.at(-1)!, false);
  f.mux.finish({ code: 0, signal: null, stderrTail: "" });
});

test("file and tree replacements reject captured prompts, replies, queue clearing and abort", () => {
  const f = fixture(), a = f.attach(), b = f.attach();
  const old = { ...f.mux.state.inputContext! };
  f.companion({ kind: "tree", oldLeafId: "a-leaf", newLeafId: "other", data: data({ leafId: "other" }) });
  for (const type of ["prompt", "steer", "follow_up", "extension_ui_response", "clear_queue", "abort", "set_model", "future_mutation"]) {
    const before = f.writes.length;
    f.send(a.client, { type, id: `stale-${type}`, message: "old branch", pimuxContext: old });
    assert.equal(f.writes.length, before, type);
    assert.equal(a.output.records.at(-1)?.delivery, "rejected", type);
  }
  const branch = { ...f.mux.state.inputContext! };
  assert.notEqual(branch.contextId, old.contextId);
  f.companion({ kind: "session", reason: "resume", previousSessionFile: session.file,
    data: data({ session: { ...session, file: "/synthetic/b.jsonl", id: "b" }, leafId: null }) });
  const before = f.writes.length;
  f.send(b.client, { type: "prompt", message: "old file", pimuxContext: branch });
  assert.equal(f.writes.length, before);
  const next = f.mux.state.inputContext!;
  f.send(b.client, { type: "prompt", message: "new file", pimuxContext: next });
  assert.equal(f.writes.at(-1)?.message, "new file");
  // A token alone cannot be combined with a fabricated file/leaf.
  for (const pimuxContext of [{ ...next, sessionFile: session.file }, { ...next, leafId: "other" }]) {
    const count = f.writes.length;
    f.send(b.client, { type: "clear_queue", pimuxContext });
    assert.equal(f.writes.length, count);
  }
});

test("ordinary refresh and concurrent same-branch steering keep the branch anchor", () => {
  const f = fixture(), a = f.attach(), b = f.attach();
  const context = { ...f.mux.state.inputContext! };
  f.send(a.client, { type: "pimux_bootstrap" });
  f.snapshot({ leafId: "newly-appended-descendant" });
  assert.deepEqual(f.mux.state.inputContext, context);
  for (const client of [a.client, b.client]) {
    f.send(client, { type: "prompt", streamingBehavior: "steer", message: "current branch", pimuxContext: context });
    assert.equal(f.writes.at(-1)?.message, "current branch");
  }
});

test("pending replacement fences other clients before Pi emits a change and after cancellation until resync", () => {
  const f = fixture(), a = f.attach(), b = f.attach();
  const context = { ...f.mux.state.inputContext! };
  f.send(a.client, { type: "switch_session", sessionPath: "/synthetic/b.jsonl", pimuxContext: context });
  const transition = f.writes.at(-1)!;
  const before = f.writes.length;
  f.send(b.client, { type: "prompt", message: "racing instruction", pimuxContext: context });
  assert.equal(f.writes.length, before);
  assert.match(String(b.output.records.at(-1)?.error), /pending/);
  f.mux.removeClient(a.client);
  // Disconnecting the requester must not release an outstanding transition.
  f.send(b.client, { type: "clear_queue", pimuxContext: context });
  assert.equal(f.writes.length, before);
  f.mux.piLine(JSON.stringify({ type: "response", id: transition.id, command: "switch_session", success: true, data: { cancelled: true } }));
  const resync = f.writes.length;
  f.send(b.client, { type: "prompt", message: "not ready", pimuxContext: context });
  assert.equal(f.writes.length, resync);
  f.snapshot();
  f.send(b.client, { type: "prompt", message: "after cancellation", pimuxContext: context });
  assert.equal(f.writes.at(-1)?.message, "after cancellation");
});

test("a pending slash command can receive its context-bound dialog answer without deadlock", () => {
  const f = fixture(), a = f.attach(), b = f.attach();
  const pimuxContext = { ...f.mux.state.inputContext! };
  f.send(a.client, { type: "prompt", message: "/dialog", pimuxContext });
  f.mux.piLine(JSON.stringify({ type: "extension_ui_request", id: "dialog", method: "input" }));
  f.send(b.client, { type: "extension_ui_response", id: "dialog", value: "answer", pimuxContext });
  assert.deepEqual(f.writes.at(-1), { type: "extension_ui_response", id: "dialog", value: "answer" });
});

test("snapshot failure and identity-only history errors keep input gated without losing new identity", () => {
  const f = fixture(), a = f.attach();
  const old = f.mux.state.inputContext!;
  f.send(a.client, { type: "pimux_bootstrap" });
  const generation = Number(String(f.writes.at(-1)!.id).slice(6));
  f.companion({ kind: "snapshot-failed", generation, error: "broken history" });
  let before = f.writes.length;
  f.send(a.client, { type: "prompt", message: "failed boundary", pimuxContext: old });
  assert.equal(f.writes.length, before);
  const changed = { ...session, file: "/synthetic/identity-only.jsonl", id: "identity-only" };
  f.companion({ kind: "session", reason: "resume", previousSessionFile: session.file,
    data: data({ session: changed, historyError: "not serializable" }) });
  assert.equal(f.mux.state.session?.file, changed.file);
  assert.equal(f.mux.state.inputContext, null);
  before = f.writes.length;
  f.send(a.client, { type: "clear_queue", pimuxContext: old });
  assert.equal(f.writes.length, before);
  f.send(a.client, { type: "pimux_bootstrap" });
  f.snapshot({ session: changed });
  const recovered = f.mux.state.inputContext!;
  assert.notEqual(recovered.contextId, old.contextId);
  f.send(a.client, { type: "prompt", message: "recovered", pimuxContext: recovered });
  assert.equal(f.writes.at(-1)?.message, "recovered");
});

test("a failed dialog dispatch is uncertain and never manufactures authoritative closure", () => {
  const f = fixture(), a = f.attach();
  f.mux.piLine(JSON.stringify({ type: "extension_ui_request", id: "answer", method: "input" }));
  f.failWrites();
  f.send(a.client, { type: "extension_ui_response", id: "answer", value: "retained", pimuxContext: f.mux.state.inputContext });
  assert.equal(a.output.records.at(-1)?.delivery, "uncertain");
  assert.equal(f.mux.state.hasDialog("answer"), true);
  assert.equal(a.output.records.some((record) => record.type === "pimux_dialog_closed"), false);
});

test("an identity-only file change invalidates the old anchor before a full snapshot", () => {
  const f = fixture(), a = f.attach();
  const old = f.mux.state.inputContext!;
  const changed = { ...session, file: "/synthetic/identity-b.jsonl", id: "identity-b" };
  f.companion({ kind: "identity", reason: "reload", session: changed, model: null, thinkingLevel: "off" });
  assert.equal(f.mux.state.session?.file, changed.file);
  assert.equal(f.mux.state.inputContext, null);
  const count = f.writes.length;
  f.send(a.client, { type: "prompt", message: "old identity", pimuxContext: old });
  assert.equal(f.writes.length, count);
  f.send(a.client, { type: "pimux_bootstrap" });
  f.snapshot({ session: changed });
  assert.notEqual(parseInputContext(a.output.records.findLast((record) => record.type === "pimux_snapshot")?.inputContext)?.contextId, old.contextId);
});

test("a peer with its snapshot/live still queued cannot submit work", () => {
  const f = fixture(), a = f.attach(false);
  a.output.accepting = false;
  f.snapshot();
  assert.ok(a.client.queuedLines > 0);
  const count = f.writes.length;
  f.send(a.client, { type: "prompt", message: "ahead of live", pimuxContext: f.mux.state.inputContext });
  assert.equal(f.writes.length, count);
  a.output.release();
  f.send(a.client, { type: "prompt", message: "after drain", pimuxContext: f.mux.state.inputContext });
  assert.equal(f.writes.at(-1)?.message, "after drain");
});
