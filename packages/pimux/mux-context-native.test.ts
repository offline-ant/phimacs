import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { parseInputContext } from "./protocol.ts";
import { startMux } from "./test/harness.ts";

test("real faux Pi rejects a delayed peer's old context after file replacement", { timeout: 90_000 }, async (t) => {
  const run = await startMux(t);
  const peer = await run.connect();
  const old = parseInputContext(peer.records.findLast((record) => record.type === "pimux_snapshot")?.inputContext);
  assert.ok(old);
  const other = path.join(run.isolation.sessions, "other.jsonl");
  fs.writeFileSync(other, `${JSON.stringify({ type: "session", version: 3, id: "context-b", timestamp: new Date().toISOString(), cwd: run.dir })}\n`, { mode: 0o600 });
  const mark = peer.mark();
  const switched = await run.first.request({ type: "switch_session", sessionPath: other });
  assert.equal(switched.success, true, String(switched.error));
  const next = await peer.waitFor((record) => record.type === "pimux_snapshot"
    && parseInputContext(record.inputContext)?.sessionFile === other, "replacement file snapshot", mark);
  await peer.waitFor((record) => record.type === "pimux_live" && record.generation === next.generation, "replacement live", mark);
  const rejected = await peer.request({ type: "prompt", message: "must not enter B", pimuxContext: old });
  assert.equal(rejected.success, false);
  assert.equal(rejected.delivery, "rejected");
  for (const type of ["clear_queue", "abort"]) {
    const response = await peer.request({ type, pimuxContext: old });
    assert.equal(response.success, false, type);
    assert.equal(response.delivery, "rejected", type);
  }
  const count = peer.mark();
  const accepted = await peer.request({ type: "prompt", message: "intended for B", pimuxContext: next.inputContext });
  assert.equal(accepted.success, true, String(accepted.error));
  await peer.waitFor((record) => record.type === "agent_settled", "faux reply completed", count);
  const persisted = fs.readFileSync(other, "utf8");
  assert.doesNotMatch(persisted, /must not enter B/);
  assert.match(persisted, /intended for B/);
});

test("real faux Pi rejects an old branch token after same-file navigation and accepts its dialog response", { timeout: 90_000 }, async (t) => {
  const run = await startMux(t, { entries: 4 });
  const peer = await run.connect();
  const old = parseInputContext(peer.records.findLast((record) => record.type === "pimux_snapshot")?.inputContext)!;
  const mark = peer.mark();
  const changed = await run.first.request({ type: "prompt", message: "/fx-tree" });
  assert.equal(changed.success, true, String(changed.error));
  const next = await peer.waitFor((record) => record.type === "pimux_snapshot"
    && parseInputContext(record.inputContext)?.contextId !== old.contextId, "same-file tree context", mark);
  await peer.waitFor((record) => record.type === "pimux_live" && record.generation === next.generation, "tree live", mark);
  const rejected = await peer.request({ type: "prompt", message: "old branch instruction", pimuxContext: old });
  assert.equal(rejected.success, false);
  const dialogStart = peer.mark();
  const pending = run.first.request({ type: "prompt", message: "/fx-select" });
  const dialog = await peer.waitFor((record) => record.type === "extension_ui_request" && record.method === "select", "shared dialog", dialogStart);
  peer.send({ type: "extension_ui_response", id: dialog.id, value: "apple" });
  await peer.waitFor((record) => record.type === "pimux_dialog_closed" && record.id === dialog.id, "context-bound dialog closure", dialogStart);
  const result = await pending;
  assert.equal(result.success, true, String(result.error));
});
