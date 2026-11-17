import assert from "node:assert/strict";
import test from "node:test";
import waitingStatusExtension, { WAITING_STATUS_KEY } from "./waiting.ts";

type Handler = (event: Record<string, unknown>, ctx: unknown) => void;

function harness() {
  const handlers = new Map<string, Handler>();
  const statuses: Array<string | undefined> = [];
  const ctx = { ui: { setStatus: (key: string, text: string | undefined) => { assert.equal(key, WAITING_STATUS_KEY); statuses.push(text); } } };
  waitingStatusExtension({ on: (name: string, handler: Handler) => handlers.set(name, handler) } as never);
  return {
    statuses,
    start: (toolCallId: string, toolName: string, parentToolCallId?: string) =>
      handlers.get("tool_execution_start")!({ toolCallId, toolName, ...parentToolCallId ? { parentToolCallId } : {} }, ctx),
    end: (toolCallId: string) => handlers.get("tool_execution_end")!({ toolCallId }, ctx),
  };
}

test("an agent waits only while every running tool waits on other work", () => {
  const h = harness();
  h.start("a", "do");
  h.start("b", "bash");
  assert.deepEqual(h.statuses, ["waiting", undefined], "a working tool in the same batch means working");
  h.end("b");
  assert.deepEqual(h.statuses, ["waiting", undefined, "waiting"]);
  h.start("c", "wait");
  h.end("a");
  assert.deepEqual(h.statuses, ["waiting", undefined, "waiting"], "unchanged state publishes nothing");
  h.end("c");
  assert.deepEqual(h.statuses, ["waiting", undefined, "waiting", undefined]);
});

test("a codemode script waits only while its running calls are waiting tools", () => {
  const h = harness();
  h.start("script", "codemode");
  assert.deepEqual(h.statuses, [], "a script running its own code works");
  h.start("worker", "microdo", "script");
  h.start("delegated", "delegate", "script");
  assert.deepEqual(h.statuses, ["waiting"]);
  h.start("shell", "bash", "script");
  assert.deepEqual(h.statuses, ["waiting", undefined]);
  h.end("shell"); h.end("worker"); h.end("delegated");
  assert.deepEqual(h.statuses, ["waiting", undefined, "waiting", undefined]);
  h.end("script");
  assert.deepEqual(h.statuses, ["waiting", undefined, "waiting", undefined]);
});
