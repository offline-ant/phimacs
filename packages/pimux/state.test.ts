import assert from "node:assert/strict";
import test from "node:test";
import { LineSplitter } from "./jsonl.ts";
import type { JsonRecord } from "./protocol.ts";
import { MuxState } from "./state.ts";

function feed(state: MuxState, ...records: JsonRecord[]): void {
  for (const record of records) {
    if (record.type === "extension_ui_request") state.observeUi(record, JSON.stringify(record).length);
    else state.observeEvent(record, JSON.stringify(record).length);
  }
}

const delta = (text: string, contentIndex = 0, type = "text_delta"): JsonRecord =>
  ({ type: "message_update", usage: { output: text.length }, assistantMessageEvent: { type, contentIndex, delta: text } });

test("the tail keeps only in-flight work and ends with the run", () => {
  const state = new MuxState();
  state.session = { file: null, id: "s", name: null, cwd: "/" };
  feed(state,
    { type: "agent_start" }, { type: "turn_start" },
    { type: "message_start", message: { role: "user" } }, { type: "message_end", message: { role: "user" } },
    { type: "message_start", message: { role: "assistant" } }, delta("a"), delta("b"), delta("t", 1, "thinking_delta"), delta("c", 1, "thinking_delta"),
    { type: "message_end", message: { role: "assistant" } },
    { type: "tool_execution_start", toolCallId: "t1" }, { type: "tool_execution_update", toolCallId: "t1", partialResult: 1 },
    { type: "tool_execution_start", toolCallId: "t2" }, { type: "tool_execution_end", toolCallId: "t2" },
    { type: "message_start", message: { role: "toolResult", toolCallId: "t2" } }, { type: "message_end", message: { role: "toolResult", toolCallId: "t2" } },
    { type: "agent_start" }, { type: "auto_retry_start", attempt: 1 },
    { type: "message_start", message: { role: "assistant" } }, delta("x"), delta("y"));
  assert.equal(state.status().status, "working");
  const replay = state.replay();
  assert.deepEqual(replay.map((record) => record.type), [
    "agent_start", "turn_start", "tool_execution_start", "tool_execution_update", "auto_retry_start", "message_start", "message_update",
  ]);
  assert.equal((replay.at(-1)!.assistantMessageEvent as { delta: string }).delta, "xy");
  assert.deepEqual(replay.at(-1)!.usage, { output: 1 }, "a merged delta carries the latest usage");
  feed(state, { type: "agent_settled", aborted: false });
  assert.deepEqual(state.replay(), []);
  assert.equal(state.status().status, "idle");
});

test("merging keeps separate blocks apart and a full tail drops a whole stream, never a middle part", () => {
  const state = new MuxState({ tailBytes: 1000, uiEntries: 10, uiBytes: 10_000 });
  feed(state, { type: "message_start", message: { role: "assistant" } }, delta("a"), delta("b", 1), delta("c"));
  assert.deepEqual(state.replay().map((record) => (record.assistantMessageEvent as { delta?: string } | undefined)?.delta), [undefined, "a", "b", "c"]);
  feed(state, delta("x".repeat(1000)));
  assert.equal(state.tailTruncated, true);
  feed(state, delta("small"));
  assert.equal(state.replay().length, 4, "nothing after the dropped part is kept");
  feed(state, { type: "message_end", message: { role: "assistant" } });
  assert.equal(state.tailTruncated, false);
});

test("UI state keeps the last record per key within bounds, in the contract's replay order", () => {
  const state = new MuxState({ tailBytes: 1000, uiEntries: 2, uiBytes: 10_000 });
  feed(state,
    { type: "extension_ui_request", id: "1", method: "setStatus", statusKey: "a", statusText: "one" },
    { type: "extension_ui_request", id: "2", method: "setStatus", statusKey: "b", statusText: "two" },
    { type: "extension_ui_request", id: "3", method: "setStatus", statusKey: "a", statusText: "three" },
    { type: "extension_ui_request", id: "4", method: "setStatus", statusKey: "c", statusText: "four" },
    { type: "extension_ui_request", id: "5", method: "setStatus", statusKey: "c" },
    { type: "extension_ui_request", id: "6", method: "setWidget", widgetKey: "w", widgetLines: ["x"] },
    { type: "extension_ui_request", id: "7", method: "setTitle", title: "T" },
    { type: "queue_update", steering: ["s"], followUp: [] },
    { type: "compaction_start", reason: "manual" });
  state.openDialog({ type: "extension_ui_request", id: "d", method: "select", title: "Q" });
  // "b" was evicted when a third key arrived; "c" was cleared.
  assert.deepEqual(state.replay().map((record) => record.id ?? record.type), ["7", "3", "6", "queue_update", "compaction_start", "d"]);
  feed(state, { type: "compaction_end", reason: "manual" }, { type: "thinking_level_changed", level: "high" });
  assert.equal(state.thinkingLevel, "high");
  assert.equal(state.status().status, "starting", "no session identity yet");
});

test("JSONL framing splits on LF only and bounds line length", () => {
  const lines: string[] = [];
  let overflowed = false;
  const splitter = new LineSplitter((line) => lines.push(line), 20, () => { overflowed = true; });
  const text = "{\"a\":\"x\u2028y\"}\r\n{\"b\":1}\n";
  const bytes = Buffer.from(text);
  splitter.push(bytes.subarray(0, 5));
  splitter.push(bytes.subarray(5));
  assert.deepEqual(lines, ["{\"a\":\"x\u2028y\"}", "{\"b\":1}"]);
  splitter.push(Buffer.from("x".repeat(30)));
  assert.equal(overflowed, true);
});
