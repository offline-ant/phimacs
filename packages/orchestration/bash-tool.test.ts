import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TSchemaOptions } from "typebox";
import { createBashToolDefinition as createPiBashToolDefinition, type BashToolInput } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "./bash-tool.ts";

type ToolContext = Parameters<ReturnType<typeof createBashToolDefinition>["execute"]>[4];

const description = "Usually omit `timeout`; it defaults to 900 seconds (15 minutes). Set it explicitly when a command needs a different limit.";
const timeoutDescription = "Timeout in seconds. Optional; defaults to 900 (15 minutes).";

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
}

test("bash policy clones only its timeout metadata and retains native contracts", () => {
  const native = createPiBashToolDefinition(process.cwd());
  const original = JSON.stringify(native.parameters);
  const tool = createBashToolDefinition(process.cwd());
  assert.ok(tool.description.endsWith(description));
  assert.equal((tool.parameters.properties.timeout as unknown as TSchemaOptions).description, timeoutDescription);
  assert.equal(tool.parameters.properties.timeout.type, "number");
  assert.deepEqual(tool.parameters.required, ["command"]);
  assert.notEqual(tool.parameters, native.parameters);
  assert.notEqual(tool.parameters.properties.timeout, native.parameters.properties.timeout);
  assert.equal(JSON.stringify(native.parameters), original);
  assert.match((createPiBashToolDefinition(process.cwd()).parameters.properties.timeout as unknown as TSchemaOptions).description!, /no default timeout/);
  assert.equal(tool.parameters.properties.command, native.parameters.properties.command);
  assert.equal(tool.outputSchema, native.outputSchema);
  assert.equal(tool.name, native.name);
  assert.equal(tool.label, native.label);
  assert.equal(tool.promptSnippet, native.promptSnippet);
  assert.deepEqual(tool.promptGuidelines, native.promptGuidelines);
  assert.equal(typeof tool.renderCall, "function");
  assert.equal(typeof tool.renderResult, "function");
});

test("omission passes 900 to native execution; explicit values and caller arguments stay unchanged", async () => {
  const seen: Array<number | undefined> = [];
  const tool = createBashToolDefinition("/unused", {
    exposeSessionEnvironment: false,
    operations: { exec: async (_command, _cwd, options) => {
      seen.push(options.timeout);
      return { exitCode: 0 };
    } },
  });
  const ctx = { cwd: "/unused" } as ToolContext;
  const omitted = Object.freeze({ command: "ignored" });
  await tool.execute("omitted", omitted, undefined, undefined, ctx);
  assert.deepEqual(omitted, { command: "ignored" });
  await tool.execute("undefined", { command: "ignored", timeout: undefined }, undefined, undefined, ctx);
  for (const timeout of [5, 1800, 0, -1, NaN, Infinity, null]) {
    const params = Object.freeze({ command: "ignored", timeout }) as BashToolInput;
    await tool.execute("explicit", params, undefined, undefined, ctx);
    assert.equal(params.timeout, timeout);
  }
  assert.deepEqual(seen, [900, 900, 5, 1800, 0, -1, NaN, Infinity, null]);
});

test("native execution still validates explicit timeout values", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "phimacs-bash-policy-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const tool = createBashToolDefinition(cwd, { exposeSessionEnvironment: false });
  const ctx = { cwd } as ToolContext;
  for (const timeout of [0, -1, NaN, Infinity, null, 2_147_484]) {
    await assert.rejects(tool.execute("invalid", { command: "exit 88", timeout } as BashToolInput, undefined, undefined, ctx), /Invalid timeout/);
  }
});

test("streaming, command options, signals and structured failure results remain native", async () => {
  const controller = new AbortController();
  const updates: string[] = [];
  const tool = createBashToolDefinition("/initial", {
    commandPrefix: "export EXAMPLE=prefix",
    exposeSessionEnvironment: false,
    operations: { exec: async (command, cwd, options) => {
      assert.equal(command, "export EXAMPLE=prefix\nprintf example");
      assert.equal(cwd, "/current");
      assert.equal(options.signal, controller.signal);
      assert.equal(options.timeout, 900);
      options.onData(Buffer.from("example\n"));
      return { exitCode: 3 };
    } },
  });
  const result = await tool.execute("stream", { command: "printf example" }, controller.signal,
    (update) => updates.push(text(update)), { cwd: "/current" } as ToolContext);
  assert.ok(updates.some((update) => update.includes("example")));
  assert.equal(result.isError, true);
  assert.match(text(result), /example\n+Command exited with code 3/);
  const structured = result.structuredContent as { output: string; truncated: boolean; exit_code: number; wall_time_seconds: number };
  assert.equal(structured.output, "example\n");
  assert.equal(structured.truncated, false);
  assert.equal(structured.exit_code, 3);
  assert.equal(typeof structured.wall_time_seconds, "number");
});

test("native timeout and cancellation errors retain partial output", async () => {
  for (const [error, expected] of [["aborted", /partial\n+Command aborted/], ["timeout:900", /partial\n+Command timed out after 900 seconds/]] as const) {
    const tool = createBashToolDefinition("/unused", {
      exposeSessionEnvironment: false,
      operations: { exec: async (_command, _cwd, options) => {
        options.onData(Buffer.from("partial\n"));
        throw new Error(error);
      } },
    });
    await assert.rejects(tool.execute("failure", { command: "ignored" }, undefined, undefined, { cwd: "/unused" } as ToolContext), expected);
  }
});
