import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { TSchemaOptions } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@phimacs/orchestration/bash-tool";
import { setSessionRemote } from "../../orchestration/test/ssh-stub.ts";
import bashExtension from "./bash.ts";

type BashTool = ReturnType<typeof createBashToolDefinition>;
type ToolContext = Parameters<BashTool["execute"]>[4];

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
}

function extension(): BashTool[] {
  const tools: BashTool[] = [];
  bashExtension({ registerTool: (tool: BashTool) => tools.push(tool) } as unknown as ExtensionAPI);
  return tools;
}

function workspace(t: TestContext): { root: string; agent: string; context(cwd?: string, trusted?: boolean): ToolContext } {
  setSessionRemote(t, undefined);
  const root = mkdtempSync(join(tmpdir(), "phimacs-local-bash-"));
  const agent = join(root, "agent");
  mkdirSync(agent);
  const previous = new Map(["PI_CODING_AGENT_DIR", "HOME", "BASH_ENV", "ENV"].map((name) => [name, process.env[name]]));
  process.env.PI_CODING_AGENT_DIR = agent;
  process.env.HOME = root;
  delete process.env.BASH_ENV;
  delete process.env.ENV;
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, agent, context: (cwd = root, trusted = true) => ({
    cwd,
    isProjectTrusted: () => trusted,
    model: undefined,
    sessionManager: { getSessionId: () => "bash-fixture", getSessionFile: () => undefined },
  } as unknown as ToolContext) };
}

test("local registration advertises and applies the optional timeout policy", async (t) => {
  const fixture = workspace(t);
  const [tool] = extension();
  assert.equal(tool.name, "bash");
  assert.match(tool.description, /Usually omit `timeout`; it defaults to 900 seconds \(15 minutes\)/);
  assert.equal((tool.parameters.properties.timeout as unknown as TSchemaOptions).description, "Timeout in seconds. Optional; defaults to 900 (15 minutes).");
  assert.deepEqual(tool.parameters.required, ["command"]);
  const timer = t.mock.method(globalThis, "setTimeout");
  const result = await tool.execute("default", { command: "printf default" }, undefined, undefined, fixture.context());
  assert.equal(text(result), "default");
  assert.ok(timer.mock.calls.some((call) => call.arguments[1] === 900_000));
  timer.mock.resetCalls();
  const explicit = await tool.execute("explicit", { command: "printf explicit", timeout: 42 }, undefined, undefined, fixture.context());
  assert.equal(text(explicit), "explicit");
  assert.ok(timer.mock.calls.some((call) => call.arguments[1] === 42_000));
  assert.ok(!timer.mock.calls.some((call) => call.arguments[1] === 900_000));
});

test("remote sessions, including invalid targets, do not register a local fallback", (t) => {
  setSessionRemote(t, "invalid:relative");
  assert.deepEqual(extension(), []);
});

test("each call respects current cwd, shell settings, prefix and project trust", async (t) => {
  const fixture = workspace(t);
  const shell = (label: string) => {
    const file = join(fixture.root, `${label}.sh`);
    writeFileSync(file, `#!/bin/sh\nexport PHIMACS_SHELL=${label}\nexec /bin/bash "$@"\n`, { mode: 0o700 });
    return file;
  };
  writeFileSync(join(fixture.agent, "settings.json"), JSON.stringify({
    shellPath: shell("global"), shellCommandPrefix: "export PHIMACS_PREFIX=global",
  }));
  const [tool] = extension();
  const command = 'printf "%s|%s|%s|%s" "$PWD" "$PHIMACS_SHELL" "$PHIMACS_PREFIX" "$PI_SESSION_ID"';
  for (const label of ["first", "second"]) {
    const cwd = join(fixture.root, label);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({
      shellPath: shell(label), shellCommandPrefix: `export PHIMACS_PREFIX=${label}`,
    }));
    const result = await tool.execute(label, { command }, undefined, undefined, fixture.context(cwd));
    assert.equal(text(result), `${cwd}|${label}|${label}|bash-fixture`);
    const untrusted = await tool.execute("untrusted", { command }, undefined, undefined, fixture.context(cwd, false));
    assert.equal(text(untrusted), `${cwd}|global|global|bash-fixture`);
  }
});

test("local streaming, failure status, native timeout and cancellation stay intact", async (t) => {
  const fixture = workspace(t);
  const [tool] = extension();
  const ctx = fixture.context();
  const failed = await tool.execute("failure", { command: "printf out; exit 7" }, undefined, undefined, ctx);
  assert.equal(failed.isError, true);
  assert.match(text(failed), /out\n+Command exited with code 7/);
  assert.equal((failed.structuredContent as { exit_code: number }).exit_code, 7);
  await assert.rejects(tool.execute("invalid", { command: "exit 0", timeout: 0 }, undefined, undefined, ctx), /Invalid timeout/);

  const command = `printf started; exec ${JSON.stringify(process.execPath)} -e 'setInterval(() => {}, 1000)'`;
  await assert.rejects(tool.execute("timeout", { command, timeout: 0.05 }, undefined, undefined, ctx), /started\n+Command timed out after 0.05 seconds/);
  const controller = new AbortController();
  const updates: string[] = [];
  await assert.rejects(tool.execute("abort", { command }, controller.signal, (update) => {
    const output = text(update);
    updates.push(output);
    if (output.includes("started")) controller.abort();
  }, ctx), /started\n+Command aborted/);
  assert.ok(updates.some((output) => output.includes("started")));
});
