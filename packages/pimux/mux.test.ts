import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Sink } from "./client.ts";
import { Mux, type MuxOptions } from "./mux.ts";
import { COMPANION_STATUS_KEY, type CompanionRecord, type JsonRecord, MODELS_COMMAND, SNAPSHOT_COMMAND, type SnapshotData } from "./protocol.ts";

class FakeSink implements Sink {
  records: JsonRecord[] = [];
  accepting = true;
  destroyed = false;
  private drain: (() => void) | undefined;
  write(data: string): boolean {
    for (const line of data.split("\n")) if (line) this.records.push(JSON.parse(line) as JsonRecord);
    return this.accepting;
  }
  onDrain(listener: () => void): void { this.drain = listener; }
  destroy(): void { this.destroyed = true; }
  release(): void { this.accepting = true; this.drain?.(); }
  types(): unknown[] { return this.records.map((record) => record.type); }
  take(): JsonRecord[] { const records = this.records; this.records = []; return records; }
}

const SESSION = { file: "/tmp/synthetic-session.jsonl", id: "s1", name: null, cwd: "/tmp" };
function snapshotData(extra: Partial<SnapshotData> = {}): SnapshotData {
  return { session: SESSION, model: { provider: "p", id: "m" }, thinkingLevel: "off", idle: true, leafId: "e2",
    entries: [{ id: "e1", parentId: null }], messages: [{ role: "user", content: "hi" }], ...extra };
}

function fakeMux(options: Partial<MuxOptions> = {}) {
  const toPi: JsonRecord[] = [];
  const diagnostics: string[] = [];
  let statusChanges = 0;
  const mux = new Mux({
    muxId: "mux", socketPath: "/tmp/synthetic-mux.sock", piPid: 42,
    writeToPi: (record) => toPi.push(record), onStatus: () => statusChanges++, onDiagnostic: (line) => diagnostics.push(line),
    ...options,
  });
  return {
    mux, toPi, diagnostics, statusChanges: () => statusChanges,
    pi: (record: JsonRecord): void => mux.piLine(JSON.stringify(record)),
    companion: (record: CompanionRecord): void => mux.piLine(JSON.stringify({
      type: "extension_ui_request", method: "setStatus", statusKey: COMPANION_STATUS_KEY, statusText: JSON.stringify(record),
    })),
  };
}

function answerSnapshot(fake: ReturnType<typeof fakeMux>, extra: Partial<SnapshotData> = {}, request = fake.toPi.findLast(
  (record) => typeof record.id === "string" && record.id.startsWith("pimux:"))!): number {
  assert.ok(request);
  const [, generation, include] = String(request.message).split(" ");
  assert.match(String(request.message), new RegExp(`^/${SNAPSHOT_COMMAND} `));
  fake.pi({ type: "response", id: request.id, command: "prompt", success: true, data: { disposition: "handled" } });
  const data = snapshotData(extra);
  if (!include!.includes("entries")) delete data.entries;
  if (!include!.includes("messages")) delete data.messages;
  fake.companion({ kind: "snapshot", generation: Number(generation), data });
  return Number(generation);
}

function attach(options: Partial<MuxOptions> = {}) {
  const fake = fakeMux(options);
  const sink = new FakeSink();
  const client = fake.mux.addClient(sink);
  answerSnapshot(fake);
  return { ...fake, sink, client };
}

function attachPeer(fake: ReturnType<typeof fakeMux>) {
  const sink = new FakeSink();
  const client = fake.mux.addClient(sink);
  answerSnapshot(fake);
  return { sink, client };
}

function treeChange(fake: ReturnType<typeof fakeMux>, bytes = 0): void {
  fake.companion({ kind: "tree", newLeafId: "e2", oldLeafId: "e1",
    data: snapshotData({ entries: [{ padding: "x".repeat(bytes) }] }) });
}

test("every socket peer receives protocol-2 hello first and its own authoritative attach snapshot", () => {
  const fake = fakeMux();
  const first = new FakeSink();
  fake.mux.addClient(first);
  const firstRequest = fake.toPi.at(-1)!;
  assert.deepEqual(first.records[0], { type: "pimux_hello", protocol: 2, capabilities: ["snapshot", "stop", "detached", "contextual-input", "models"],
    muxId: "mux", clientId: 1, piPid: 42, socket: "/tmp/synthetic-mux.sock" });
  assert.equal("role" in first.records[0]!, false);
  fake.pi({ type: "agent_start" });
  fake.pi({ type: "message_start", message: { role: "assistant", content: [] } });
  fake.pi({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" } });
  const second = new FakeSink();
  const client = fake.mux.addClient(second);
  const secondRequest = fake.toPi.at(-1)!;
  fake.pi({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" } });
  fake.mux.clientLine(client, JSON.stringify({ id: "q", type: "get_state" }));
  fake.pi({ type: "response", id: fake.toPi.at(-1)!.id, command: "get_state", success: true, data: {} });
  assert.deepEqual(second.types(), ["pimux_hello", "response"]);
  answerSnapshot(fake, {}, firstRequest);
  const generation = answerSnapshot(fake, {}, secondRequest);
  fake.pi({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "!" } });
  assert.deepEqual(second.types(), ["pimux_hello", "response", "pimux_snapshot", "agent_start", "message_start", "message_update", "pimux_live", "message_update"]);
  assert.equal(second.records[2]!.generation, generation);
  assert.equal((second.records[5]!.assistantMessageEvent as { delta: string }).delta, "Hello");
  assert.equal(first.records.at(-1)!.type, "message_update");
});

test("response IDs are isolated across equal peers and internal commands are hidden", () => {
  const fake = attach();
  const peer = attachPeer(fake);
  fake.sink.take(); peer.sink.take();
  for (const client of [fake.client, peer.client]) fake.mux.clientLine(client, JSON.stringify({ id: "same", type: "get_state" }));
  fake.mux.clientLine(peer.client, JSON.stringify({ id: { arbitrary: [7] }, type: "get_messages" }));
  fake.mux.clientLine(peer.client, JSON.stringify({ type: "get_commands" }));
  const [a, b, c, d] = fake.toPi.slice(-4);
  assert.notEqual(a!.id, b!.id);
  fake.pi({ type: "response", id: b!.id, command: "get_state", success: true, data: { who: "peer" } });
  fake.pi({ type: "response", id: a!.id, command: "get_state", success: true, data: { who: "creator" } });
  fake.pi({ type: "response", id: c!.id, command: "get_messages", success: true });
  fake.pi({ type: "response", id: d!.id, command: "get_commands", success: true, data: { commands: [{ name: SNAPSHOT_COMMAND }, { name: MODELS_COMMAND }, { name: "worker-cancel" }] } });
  assert.deepEqual(fake.sink.take(), [{ type: "response", id: "same", command: "get_state", success: true, data: { who: "creator" } }]);
  const records = peer.sink.take();
  assert.deepEqual(records[1]!.id, { arbitrary: [7] });
  assert.equal("id" in records[2]!, false);
  assert.deepEqual(records[2]!.data, { commands: [{ name: "worker-cancel" }] });
  for (const line of ["{bad json", "[]", '{}', '{"type":42}']) {
    fake.mux.clientLine(peer.client, line);
    assert.equal(peer.sink.records.at(-1)!.success, false);
    assert.equal(peer.sink.records.at(-1)!.command, "parse");
  }
  assert.equal(fake.mux.pendingRequestCount, 0);
});

test("dialogs fan out, first answer wins, timeout and aggregate closure remain authoritative", async () => {
  const fake = attach(); const peer = attachPeer(fake);
  fake.pi({ type: "extension_ui_request", id: "d1", method: "select", title: "Pick", options: ["a", "b"] });
  assert.equal(fake.mux.state.status().status, "blocked");
  assert.equal(fake.sink.records.at(-1)!.id, "d1");
  const before = fake.toPi.length;
  fake.mux.clientLine(peer.client, JSON.stringify({ pimuxContext: fake.mux.state.inputContext, type: "extension_ui_response", id: "d1", value: "b" }));
  fake.mux.clientLine(fake.client, JSON.stringify({ pimuxContext: fake.mux.state.inputContext, type: "extension_ui_response", id: "d1", value: "a" }));
  assert.deepEqual(fake.toPi.slice(before), [{ type: "extension_ui_response", id: "d1", value: "b" }]);
  assert.deepEqual(fake.sink.records.at(-1), { type: "pimux_dialog_closed", id: "d1", reason: "answered", clientId: peer.client.id });
  fake.pi({ type: "extension_ui_request", id: "d2", method: "confirm", title: "Soon", timeout: 15 });
  fake.pi({ type: "extension_ui_request", id: "d3", method: "input", title: "Other" });
  await delay(35);
  assert.deepEqual(peer.sink.records.at(-1), { type: "pimux_dialog_closed", id: "d2", reason: "timeout" });
  fake.companion({ kind: "prompts-ended" });
  assert.deepEqual(peer.sink.records.at(-1), { type: "pimux_dialog_closed", id: "d3", reason: "ended" });
  assert.equal(fake.mux.dialogTimerCount, 0);
});

test("evicted or replaced dialogs do not retain timers outside the bounded replay cache", () => {
  const fake = attach({ stateLimits: { tailBytes: 1000, uiEntries: 2, uiBytes: 1000 } });
  for (let index = 0; index < 100; index++) fake.pi({ type: "extension_ui_request", id: `d${index}`, method: "input", timeout: 60_000 });
  assert.equal(fake.mux.state.dialogIds().length, 2);
  assert.equal(fake.mux.dialogTimerCount, 2);
  fake.pi({ type: "extension_ui_request", id: "d99", method: "input" });
  assert.equal(fake.mux.dialogTimerCount, 1);
  fake.mux.finish({ code: 0, signal: null, stderrTail: "" });
  assert.equal(fake.mux.dialogTimerCount, 0);
});

test("uncorrelated editor text is recoverable even with one outstanding prompt; no draft ownership is guessed", () => {
  const fake = attach(); const peer = attachPeer(fake);
  fake.sink.take(); peer.sink.take();
  fake.mux.clientLine(peer.client, JSON.stringify({ pimuxContext: fake.mux.state.inputContext, type: "prompt", message: "/edit" }));
  const request = fake.toPi.at(-1)!;
  fake.pi({ type: "extension_ui_request", id: "edit", method: "set_editor_text", text: "local" });
  for (const sink of [fake.sink, peer.sink]) {
    assert.equal(sink.records.at(-1)!.type, "pimux_editor_text");
    assert.equal(sink.records.at(-1)!.text, "local");
    assert.equal(sink.records.some((record) => record.method === "set_editor_text"), false);
  }
  fake.mux.clientLine(fake.client, JSON.stringify({ pimuxContext: fake.mux.state.inputContext, type: "prompt", message: "/also-edit" }));
  fake.pi({ type: "extension_ui_request", method: "set_editor_text", text: "uncertain" });
  for (const sink of [fake.sink, peer.sink]) {
    assert.equal(sink.records.at(-1)!.type, "pimux_editor_text");
    assert.equal(sink.records.at(-1)!.text, "uncertain");
  }
  fake.pi({ type: "response", id: request.id, command: "prompt", success: true });
  treeChange(fake);
  fake.pi({ type: "extension_ui_request", method: "set_editor_text", text: "old branch" });
  assert.equal(fake.sink.records.at(-1)!.type, "pimux_editor_text");
  const late = attachPeer(fake);
  assert.equal(late.sink.records.some((record) => record.type === "pimux_editor_text" && record.text === "uncertain"), true);
  assert.equal(late.sink.records.some((record) => record.method === "set_editor_text"), false);
});

test("a delayed editor callback from completed A cannot overwrite B's newly pending draft", () => {
  const fake = attach(); const peer = attachPeer(fake);
  fake.mux.clientLine(fake.client, JSON.stringify({ pimuxContext: fake.mux.state.inputContext, type: "prompt", message: "/a" }));
  const requestA = fake.toPi.at(-1)!;
  fake.pi({ type: "response", id: requestA.id, command: "prompt", success: true });
  for (const request of fake.toPi.filter((record) => String(record.id).startsWith("pimux:"))) answerSnapshot(fake, {}, request);
  fake.mux.clientLine(peer.client, JSON.stringify({ pimuxContext: fake.mux.state.inputContext, type: "prompt", message: "/b" }));
  fake.pi({ type: "extension_ui_request", method: "set_editor_text", text: "delayed A" });
  for (const sink of [fake.sink, peer.sink]) {
    assert.equal(sink.records.at(-1)!.type, "pimux_editor_text");
    assert.equal(sink.records.at(-1)!.text, "delayed A");
    assert.equal(sink.records.some((record) => record.method === "set_editor_text"), false);
  }
});

test("unsolicited editor notices survive zero clients within count/encoded-byte bounds and never overwrite drafts", () => {
  const fake = fakeMux();
  for (let index = 0; index < 300; index++) fake.pi({ type: "extension_ui_request", method: "set_editor_text", text: `recover ${index}` });
  const first = attachPeer(fake);
  const notices = first.sink.records.filter((record) => record.type === "pimux_editor_text");
  assert.equal(notices.length, 256);
  assert.equal(notices[0]!.text, "recover 44");
  fake.mux.removeClient(first.client);
  fake.pi({ type: "extension_ui_request", method: "set_editor_text", text: "\u0001".repeat(5 * 1024 * 1024) });
  const late = attachPeer(fake);
  const oversized = late.sink.records.findLast((record) => record.type === "pimux_editor_text")!;
  assert.equal(oversized.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(oversized)) < 4 * 1024 * 1024);
  assert.equal(late.sink.records.some((record) => record.method === "set_editor_text"), false);
});

test("zero-client output still updates state, snapshots readiness and bounded private diagnostics", async () => {
  const snapshots: SnapshotData[] = [];
  const fake = fakeMux({ onSnapshot: (data) => snapshots.push(data) });
  fake.pi({ type: "agent_start" });
  fake.pi({ type: "message_start", message: { role: "assistant" } });
  fake.mux.piLine("not-json".repeat(2000));
  fake.pi({ type: "response", id: "nobody", command: "get_state", success: true });
  assert.equal(fake.mux.clientCount, 0);
  assert.equal(fake.mux.state.runActive, true);
  assert.equal(fake.diagnostics.length, 2);
  assert.ok(fake.diagnostics.every((line) => line.length <= 4096));
  const pending = fake.mux.takeSnapshot();
  answerSnapshot(fake);
  assert.deepEqual(await pending, snapshotData());
  assert.equal(snapshots.length, 1);
  assert.equal(fake.mux.pendingSnapshotCount, 0);
  const peer = attachPeer(fake);
  assert.equal(peer.sink.records.some((record) => record.type === "agent_start"), true);
});

test("startup gate rejects external commands and dialog answers without forwarding, but snapshot control remains available", () => {
  let committed = false;
  const fake = attach({ canAcceptCommands: () => committed });
  const count = fake.toPi.length;
  fake.mux.clientLine(fake.client, JSON.stringify({ pimuxContext: fake.mux.state.inputContext, id: "x", type: "prompt", message: "never sent" }));
  assert.equal(fake.toPi.length, count);
  assert.equal(fake.sink.records.at(-1)!.success, false);
  fake.pi({ type: "extension_ui_request", id: "d", method: "input" });
  fake.mux.clientLine(fake.client, JSON.stringify({ pimuxContext: fake.mux.state.inputContext, type: "extension_ui_response", id: "d", value: "no" }));
  assert.equal(fake.toPi.length, count);
  fake.mux.clientLine(fake.client, JSON.stringify({ type: "pimux_bootstrap" }));
  assert.equal(fake.toPi.length, count + 1);
  answerSnapshot(fake);
  committed = true;
  fake.mux.clientLine(fake.client, JSON.stringify({ id: "yes", type: "get_state" }));
  assert.equal(fake.toPi.at(-1)!.type, "get_state");
  fake.mux.removeClient(fake.client);
  const after = fake.toPi.length;
  fake.mux.clientLine(fake.client, JSON.stringify({ pimuxContext: fake.mux.state.inputContext, type: "prompt", message: "closed client" }));
  assert.equal(fake.toPi.length, after);
});

test("stop control validates protocol, operation and owner identity, and delegates idempotent receipts", async () => {
  const receipts = new Map<string, JsonRecord>();
  let stops = 0;
  const fake = attach({ onStop: async (id) => {
    if (!receipts.has(id)) receipts.set(id, { operationId: id, muxId: "mux", stopped: ++stops });
    return receipts.get(id)!;
  } });
  for (const request of [
    { type: "pimux_stop", expectedMuxId: "other", operationId: "op" },
    { type: "pimux_stop", expectedMuxId: "mux", operationId: "" },
    { type: "pimux_stop", expectedMuxId: "mux", operationId: "op", protocol: 1 },
    { type: "pimux_unknown" },
  ]) {
    fake.mux.clientLine(fake.client, JSON.stringify(request));
    assert.equal(fake.sink.records.at(-1)!.success, false);
  }
  const before = fake.toPi.length;
  for (let index = 0; index < 2; index++) {
    fake.mux.clientLine(fake.client, JSON.stringify({ id: `stop${index}`, type: "pimux_stop", protocol: 2, expectedMuxId: "mux", operationId: "same" }));
    await delay(0);
    assert.deepEqual(fake.sink.records.at(-1)!.data, { operationId: "same", muxId: "mux", stopped: 1 });
  }
  assert.equal(stops, 1);
  assert.equal(fake.toPi.length, before);
});

test("stop errors settle and exit remains the final record when stop resolves after Pi exits", async () => {
  const failed = attach({ onStop: () => { throw new Error("owned shutdown failed"); } });
  failed.mux.clientLine(failed.client, JSON.stringify({ id: "s", type: "pimux_stop", expectedMuxId: "mux", operationId: "op" }));
  await delay(0);
  assert.equal(failed.sink.records.at(-1)!.success, false);
  assert.match(String(failed.sink.records.at(-1)!.error), /owned shutdown failed/);
  let finish!: (data: JsonRecord) => void;
  const fake = attach({ onStop: () => new Promise((resolve) => { finish = resolve; }) });
  fake.mux.clientLine(fake.client, JSON.stringify({ type: "pimux_stop", expectedMuxId: "mux", operationId: "op" }));
  await delay(0);
  fake.mux.clientLine(fake.client, JSON.stringify({ type: "pimux_stop", expectedMuxId: "mux", operationId: "other" }));
  assert.match(String(fake.sink.records.at(-1)!.error), /already has a stop request/);
  fake.mux.finish({ code: 0, signal: null, stderrTail: "" });
  finish({ stopped: true });
  await delay(0);
  assert.equal(fake.sink.records.at(-1)!.type, "pimux_exit");
});

test("bash broadcasts outlive a disconnected sender without retaining its IDs or client ownership", () => {
  const fake = attach(); const peer = attachPeer(fake);
  fake.mux.clientLine(fake.client, JSON.stringify({ pimuxContext: fake.mux.state.inputContext, id: "run", type: "bash", command: "echo hi" }));
  const request = fake.toPi.at(-1)!;
  fake.pi({ type: "bash_execution_update", id: request.id, delta: "hi\n" });
  assert.equal(fake.sink.records.at(-1)!.id, "run");
  assert.equal("id" in peer.sink.records.at(-1)!, false);
  fake.mux.removeClient(fake.client);
  const late = attachPeer(fake);
  assert.equal(late.sink.records.some((record) => record.type === "pimux_bash_start"), true);
  fake.pi({ type: "response", id: request.id, command: "bash", success: true, data: { output: "hi\n", exitCode: 0 } });
  assert.equal(peer.sink.records.at(-1)!.type, "pimux_bash_end");
  assert.equal(fake.mux.state.status().status, "idle");
  assert.equal(fake.mux.pendingRequestCount, 0);
});

test("pending requests are bounded and disconnection purges non-shell request state", () => {
  const fake = attach({ maxPendingRequests: 3 }); const peer = attachPeer(fake);
  for (let index = 0; index < 3; index++) fake.mux.clientLine(fake.client, JSON.stringify({ type: "get_state", id: index }));
  assert.equal(fake.mux.pendingRequestCount, 3);
  const before = fake.toPi.length;
  fake.mux.clientLine(fake.client, JSON.stringify({ pimuxContext: fake.mux.state.inputContext, type: "prompt", message: "not forwarded" }));
  assert.equal(fake.client.closed, true);
  assert.equal(fake.toPi.length, before);
  assert.equal(fake.mux.pendingRequestCount, 0);
  fake.mux.clientLine(peer.client, JSON.stringify({ type: "get_state" }));
  assert.equal(fake.mux.pendingRequestCount, 1);
  fake.mux.removeClient(peer.client);
  assert.equal(fake.mux.pendingRequestCount, 0);
});

test("session/tree changes supersede snapshots for every peer and preserve model/include semantics", () => {
  const fake = attach(); const peer = attachPeer(fake);
  fake.mux.clientLine(peer.client, JSON.stringify({ id: "b", type: "pimux_bootstrap", include: ["entries"] }));
  fake.pi({ type: "agent_start" });
  fake.pi({ type: "extension_ui_request", id: "d", method: "select", title: "Old" });
  fake.sink.take(); peer.sink.take();
  const session = { ...SESSION, file: "/tmp/new-synthetic.jsonl", id: "s2" };
  fake.companion({ kind: "session", reason: "new", previousSessionFile: SESSION.file, data: snapshotData({ session }) });
  assert.deepEqual(fake.sink.types(), ["pimux_dialog_closed", "pimux_session_changed", "pimux_snapshot", "pimux_live"]);
  assert.deepEqual(peer.sink.types(), ["pimux_dialog_closed", "pimux_session_changed", "pimux_snapshot", "pimux_live"]);
  assert.equal("messages" in peer.sink.records[2]!, false);
  const before = peer.sink.records.length;
  answerSnapshot(fake);
  assert.equal(peer.sink.records.length, before);
  treeChange(fake);
  fake.companion({ kind: "model", model: { provider: "p", id: "two" }, previousModel: null, source: "set" });
  assert.equal(peer.sink.records.at(-1)!.type, "pimux_model_changed");
  assert.deepEqual(fake.mux.state.model, { provider: "p", id: "two" });
});

test("superseded client snapshots are bounded and all snapshot failures settle without fake readiness", async () => {
  const fake = attach({ snapshotTimeoutMs: 10 });
  for (let index = 0; index < 100; index++) fake.mux.clientLine(fake.client, JSON.stringify({ type: "pimux_bootstrap" }));
  assert.equal(fake.mux.pendingSnapshotCount, 1);
  await delay(25);
  assert.equal(fake.sink.records.at(-1)!.type, "pimux_snapshot_failed");
  assert.equal(fake.mux.pendingSnapshotCount, 0);
  const internal = assert.rejects(fake.mux.takeSnapshot(), /cannot serialize/);
  const request = fake.toPi.at(-1)!;
  fake.companion({ kind: "snapshot-failed", generation: Number(String(request.id).slice(6)), error: "cannot serialize" });
  await internal;
  const timeout = assert.rejects(fake.mux.takeSnapshot(), /in time/);
  await delay(25); await timeout;
  fake.mux.clientLine(fake.client, JSON.stringify({ type: "pimux_bootstrap", include: ["bogus"] }));
  assert.equal(fake.sink.records.at(-1)!.success, false);
});

test("snapshot safety callback failure rejects readiness and reports failure without a live marker", async () => {
  const fake = fakeMux({ onSnapshot: () => { throw new Error("claim initialization failed"); } });
  const pending = assert.rejects(fake.mux.takeSnapshot(), /claim initialization failed/);
  answerSnapshot(fake);
  await pending;
  const sink = new FakeSink(); fake.mux.addClient(sink);
  answerSnapshot(fake);
  assert.deepEqual(sink.types(), ["pimux_hello", "pimux_snapshot_failed"]);
  assert.match(fake.diagnostics.at(-1)!, /claim initialization failed/);
});

test("a change without history still replaces stale identity for every peer", () => {
  const fake = attach();
  fake.sink.take();
  const { entries: _entries, messages: _messages, ...identity } = snapshotData({ historyError: "too large" });
  fake.companion({ kind: "session", reason: "fork", previousSessionFile: "/tmp/old.jsonl", data: identity });
  assert.deepEqual(fake.sink.types(), ["pimux_session_changed", "pimux_snapshot", "pimux_live"]);
  assert.equal(fake.sink.records[1]!.historyError, "too large");
  assert.equal("entries" in fake.sink.records[1]!, false);
});

test("overflow keeps responses and recovers with a gap; the creator is disconnected like every slow peer", () => {
  const fake = attach({ queueLimits: { queueBytes: 300, totalBytes: 10_000, overflows: 2 } });
  const peer = attachPeer(fake);
  fake.sink.take();
  fake.sink.accepting = false;
  fake.pi({ type: "agent_start" });
  fake.mux.clientLine(fake.client, JSON.stringify({ id: "kept", type: "get_state" }));
  fake.pi({ type: "response", id: fake.toPi.at(-1)!.id, command: "get_state", success: true });
  for (let index = 0; index < 10; index++) fake.pi({ type: "notify-like", text: "x".repeat(50) });
  fake.sink.release();
  assert.deepEqual(fake.sink.types().slice(-3), ["agent_start", "response", "pimux_gap"]);
  answerSnapshot(fake);
  fake.sink.accepting = false;
  fake.pi({ type: "first" });
  for (let index = 0; index < 10; index++) fake.pi({ type: "notify-like", text: "x".repeat(50) });
  answerSnapshot(fake);
  for (let index = 0; index < 10; index++) fake.pi({ type: "notify-like", text: "x".repeat(50) });
  assert.equal(fake.sink.destroyed, true);
  assert.equal(fake.mux.clientCount, 1);
  fake.pi({ type: "still-draining", text: "alive" });
  assert.equal(peer.sink.records.at(-1)!.type, "still-draining");
  fake.mux.removeClient(peer.client);
  fake.pi({ type: "agent_settled" });
  assert.equal(fake.mux.state.runActive, false);
});

test("newer snapshot sequences replace queued state but keep responses without growing", () => {
  const fake = attach({ queueLimits: { queueBytes: 100_000, totalBytes: 100_000, overflows: 3 } });
  fake.sink.take(); fake.sink.accepting = false;
  fake.pi({ type: "first" }); fake.pi({ type: "queued" });
  fake.mux.clientLine(fake.client, JSON.stringify({ id: "kept", type: "get_state" }));
  fake.pi({ type: "response", id: fake.toPi.at(-1)!.id, command: "get_state", success: true });
  treeChange(fake, 1000);
  const bytes = fake.client.queuedBytes;
  for (let index = 0; index < 50; index++) treeChange(fake, 1000);
  assert.ok(fake.client.queuedBytes <= bytes + 100);
  fake.sink.release();
  assert.deepEqual(fake.sink.types(), ["first", "response", "pimux_tree_changed", "pimux_snapshot", "pimux_live"]);
  assert.equal(new Set(fake.sink.records.slice(2).map((record) => record.generation)).size, 1);
});

test("an interrupted snapshot has no old live marker and an oversized blocked peer disconnects", () => {
  const fake = attach({ queueLimits: { queueBytes: 2000, totalBytes: 2000, overflows: 3 } });
  fake.sink.take(); fake.sink.accepting = false;
  treeChange(fake, 10); treeChange(fake, 10);
  fake.sink.release();
  assert.deepEqual(fake.sink.types(), ["pimux_tree_changed", "pimux_tree_changed", "pimux_snapshot", "pimux_live"]);
  fake.sink.accepting = false;
  fake.pi({ type: "first" }); treeChange(fake, 5000);
  assert.equal(fake.client.closed, true);
  assert.equal(fake.client.queuedBytes, 0);
  const again = attachPeer(fake);
  assert.deepEqual(again.sink.types(), ["pimux_hello", "pimux_snapshot", "pimux_live"]);
});

test("finish sends exit to muted peers, rejects internal readiness and purges pending work", async () => {
  const fake = fakeMux(); const sink = new FakeSink(); fake.mux.addClient(sink);
  const internal = assert.rejects(fake.mux.takeSnapshot(), /Pi exited/);
  fake.mux.finish({ code: 0, signal: null, stderrTail: "bye" });
  await internal;
  assert.deepEqual(sink.records.at(-1), { type: "pimux_exit", code: 0, signal: null, stderrTail: "bye" });
  assert.equal(fake.mux.pendingSnapshotCount, 0);
  assert.equal(fake.mux.pendingRequestCount, 0);
  await assert.rejects(fake.mux.takeSnapshot(), /Pi has exited/);
  assert.throws(() => fake.mux.addClient(new FakeSink()), /Pi has exited/);
});

test("model operations use internal handled commands and requester-only structured results", () => {
  const fake = attach();
  const peer = attachPeer(fake);
  fake.sink.take(); peer.sink.take();
  fake.mux.clientLine(fake.client, JSON.stringify({ id: "list", type: "pimux_models", action: "list", force: true }));
  const listed = fake.toPi.at(-1)!;
  const envelope = JSON.parse(String(listed.message).slice(MODELS_COMMAND.length + 2)) as { requestId: string; request: unknown };
  assert.equal(listed.type, "prompt");
  assert.deepEqual(envelope, { requestId: listed.id, request: { action: "list", force: true } });
  assert.equal(fake.sink.records.length, 0);
  const model = { provider: "openai", id: "gpt-6.2-sol", name: "Sol 6.2", reasoning: true, input: ["text"], contextWindow: 10000 };
  fake.companion({ kind: "models-result", requestId: String(listed.id), success: true, data: { models: [model] } });
  fake.pi({ type: "response", id: listed.id, command: "prompt", success: true, data: { disposition: "handled" } });
  assert.deepEqual(fake.sink.take(), [{ type: "response", command: "pimux_models", id: "list", success: true, data: { models: [model] } }]);
  assert.equal(peer.sink.records.length, 0);
  fake.mux.clientLine(fake.client, JSON.stringify({ id: "set", type: "pimux_models", action: "set", provider: "openai", modelId: "gpt-6.2-sol", pimuxContext: fake.mux.state.inputContext }));
  const selected = fake.toPi.at(-1)!;
  fake.companion({ kind: "model", model, previousModel: null, source: "set" });
  fake.companion({ kind: "models-result", requestId: String(selected.id), success: true, data: { model, thinkingLevel: "high" } });
  fake.pi({ type: "response", id: selected.id, command: "prompt", success: true, data: { disposition: "handled" } });
  assert.equal(fake.sink.records.at(-1)!.id, "set");
  assert.equal(peer.sink.records.at(-1)!.type, "pimux_model_changed");
  assert.equal(fake.mux.pendingRequestCount, 0);
  assert.deepEqual(fake.diagnostics, []);
});

test("model mutations require current context, idleness and no previously admitted input", () => {
  const fake = attach();
  const request = { type: "pimux_models", action: "set", provider: "openai", modelId: "sol", pimuxContext: fake.mux.state.inputContext };
  const before = fake.toPi.length;
  for (const invalid of [{ ...request, action: "bogus" }, { ...request, provider: "a/b" }, { ...request, pimuxContext: null }]) {
    fake.mux.clientLine(fake.client, JSON.stringify(invalid));
    assert.equal(fake.sink.records.at(-1)!.success, false);
  }
  fake.pi({ type: "agent_start" });
  fake.mux.clientLine(fake.client, JSON.stringify(request));
  assert.equal((fake.sink.records.at(-1)!.error as { code: string }).code, "agent_working");
  fake.pi({ type: "agent_settled" });
  fake.pi({ type: "extension_ui_request", id: "dialog", method: "input" });
  fake.mux.clientLine(fake.client, JSON.stringify(request));
  assert.equal((fake.sink.records.at(-1)!.error as { code: string }).code, "agent_blocked");
  fake.companion({ kind: "prompts-ended" });
  assert.equal(fake.toPi.length, before);
  fake.pi({ type: "extension_ui_request", method: "setStatus", statusKey: "worker-frame", statusText: "worker:waiting" });
  assert.deepEqual(fake.mux.state.status().blocked, { reason: "worker-waiting" });
  fake.mux.clientLine(fake.client, JSON.stringify(request));
  assert.equal(fake.toPi.length, before + 1, "a waiting worker accepts a model switch");
  fake.pi({ type: "response", id: fake.toPi.at(-1)!.id, command: "prompt", success: true, data: { disposition: "handled" } });
  fake.mux.clientLine(fake.client, JSON.stringify({ type: "prompt", message: "pending", pimuxContext: request.pimuxContext }));
  const admitted = fake.toPi.length;
  fake.mux.clientLine(fake.client, JSON.stringify(request));
  assert.equal(fake.toPi.length, admitted);
  assert.equal((fake.sink.records.at(-1)!.error as { code: string }).code, "agent_working");
});

test("a model switch fences new input through disconnection and rejects direct internal commands", () => {
  const fake = attach(); const peer = attachPeer(fake);
  const context = fake.mux.state.inputContext;
  fake.mux.clientLine(fake.client, JSON.stringify({ type: "pimux_models", action: "set", provider: "openai", modelId: "sol", pimuxContext: context }));
  const request = fake.toPi.at(-1)!;
  assert.equal(fake.mux.pendingInputCount, 1);
  fake.mux.removeClient(fake.client);
  const before = fake.toPi.length;
  for (const command of [
    { type: "prompt", message: "continue" }, { type: "new_session" },
    { type: "pimux_models", action: "set", provider: "openrouter", modelId: "sol" },
    { type: "prompt", message: `/${MODELS_COMMAND} {}` },
  ]) {
    fake.mux.clientLine(peer.client, JSON.stringify({ ...command, pimuxContext: context }));
    assert.equal(peer.sink.records.at(-1)!.success, false);
  }
  assert.equal(fake.toPi.length, before);
  fake.companion({ kind: "models-result", requestId: String(request.id), success: false, error: { code: "model_unavailable", message: "unavailable" } });
  assert.equal(fake.mux.pendingInputCount, 0);
  fake.mux.clientLine(peer.client, JSON.stringify({ type: "prompt", message: "continue", pimuxContext: context }));
  assert.equal(fake.toPi.length, before + 1);
  assert.equal(fake.toPi.at(-1)!.message, "continue");
});

test("a terminal internal prompt acknowledgement releases the fence even without a companion result", () => {
  for (const success of [false, true]) {
    const fake = attach();
    const request = { type: "pimux_models", action: "set", provider: "mistral", modelId: "new", pimuxContext: fake.mux.state.inputContext };
    fake.mux.clientLine(fake.client, JSON.stringify(request));
    const dispatched = fake.toPi.at(-1)!;
    fake.pi({ type: "response", id: dispatched.id, command: "prompt", success, error: "synthetic command failure", data: { disposition: "handled" } });
    assert.equal((fake.sink.records.at(-1)!.error as { code: string }).code, "model_uncertain");
    assert.equal(fake.sink.records.at(-1)!.delivery, "uncertain");
    assert.equal(fake.mux.pendingInputCount, 0);
    assert.equal(fake.mux.pendingRequestCount, 0);
    fake.mux.clientLine(fake.client, JSON.stringify({ type: "prompt", message: "continue", pimuxContext: request.pimuxContext }));
    assert.equal(fake.toPi.at(-1)!.message, "continue");
    fake.mux.finish({ code: 0, signal: null, stderrTail: "" });
  }
});

test("model acknowledgement timeout is uncertain and keeps its fence until terminal evidence", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = attach({ modelTimeoutMs: 10 });
  const request = { id: "set", type: "pimux_models", action: "set", provider: "openai", modelId: "sol", pimuxContext: fake.mux.state.inputContext };
  fake.mux.clientLine(fake.client, JSON.stringify(request));
  const dispatched = fake.toPi.at(-1)!;
  t.mock.timers.tick(10);
  assert.equal((fake.sink.records.at(-1)!.error as { code: string }).code, "model_uncertain");
  assert.equal(fake.mux.pendingInputCount, 1);
  const count = fake.sink.records.length;
  fake.companion({ kind: "models-result", requestId: String(dispatched.id), success: true, data: { model: { provider: "openai", id: "sol", name: "Sol", reasoning: true, input: ["text"], contextWindow: 10000 }, thinkingLevel: "off" } });
  assert.equal(fake.sink.records.length, count, "no late acknowledgement or retry");
  assert.equal(fake.mux.pendingRequestCount, 0);
  fake.mux.clientLine(fake.client, JSON.stringify({ id: "list", type: "pimux_models", action: "list" }));
  t.mock.timers.tick(10);
  assert.equal((fake.sink.records.at(-1)!.error as { code: string }).code, "model_refresh_timeout");
  assert.equal(fake.mux.pendingRequestCount, 0);
});
