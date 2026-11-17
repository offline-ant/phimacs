import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionToolContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import promptHistory from "./prompt-history.ts";

const assistant: AssistantMessage = {
  role: "assistant", content: [{ type: "text", text: "ok" }], api: "faux", provider: "faux", model: "faux",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop", timestamp: 0,
};

function session(): SessionManager {
  const manager = SessionManager.inMemory("/tmp");
  manager.appendMessage({ role: "user", content: "first  \n\tindented", timestamp: 0 });
  manager.appendMessage(assistant);
  manager.appendMessage({ role: "custom", customType: "self-compact", content: "handoff note", display: true, timestamp: 1 });
  manager.appendCompaction("summary", null, 100);
  manager.appendMessage({ role: "user", content: [{ type: "text", text: "second" }, { type: "image", data: "AA==", mimeType: "image/png" }], timestamp: 2 });
  manager.appendMessage(assistant);
  manager.appendMessage({ role: "user", content: "third", timestamp: 3 });
  return manager;
}

async function call(params: { idx?: number }): Promise<{ text: string; structured: unknown }> {
  let tool: ToolDefinition | undefined;
  promptHistory({ registerTool: (definition: ToolDefinition) => { tool = definition; } } as unknown as ExtensionAPI);
  assert.equal(tool?.name, "prompt_history");
  const result = await tool.execute("call", params, undefined, undefined, { sessionManager: session() } as unknown as ExtensionToolContext);
  const block = result.content[0]!;
  assert.equal(block.type, "text");
  return { text: block.text, structured: result.structuredContent };
}

const text = async (params: { idx?: number }) => (await call(params)).text;

test("returns one prompt verbatim by Python index across compaction, skipping custom messages", async () => {
  assert.equal(await text({}), "third");
  assert.equal(await text({ idx: -1 }), "third");
  assert.equal(await text({ idx: 0 }), "first  \n\tindented");
  assert.equal(await text({ idx: -2 }), "second\n[image: image/png]");
  assert.equal(await text({ idx: 1 }), await text({ idx: -2 }));
});

test("structured content carries the text with its position and time", async () => {
  assert.deepEqual((await call({ idx: 0 })).structured, { text: "first  \n\tindented", index: 0, from_end: -3, time: "1970-01-01T00:00:00.000Z" });
  assert.deepEqual((await call({})).structured, { text: "third", index: 2, from_end: -1, time: "1970-01-01T00:00:00.003Z" });
});

test("an out-of-range idx fails explicitly with the valid range", async () => {
  await assert.rejects(call({ idx: 3 }), /idx 3 is out of range: this branch has 3 prompts/);
  await assert.rejects(call({ idx: -4 }), /out of range/);
});
