import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { after, before, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HostTarget } from "../host-types.ts";
import { removePanelOutput } from "../panel-output.ts";
import { activatePanel, closePanel, readPanelConfig, savedPanelState, type PanelBinding } from "../panel-runtime.ts";
import { claimName, readTarget, removeTarget } from "../workers.ts";
import panelsExtension, { panelArgv } from "./panels.ts";

interface Params { name: string; command?: string; folder?: string; lines?: number; text?: string; keys?: string[] }
interface Result { content: Array<{ type: string; text: string }>; details: { target: HostTarget }; structuredContent?: Record<string, unknown> }
type Execute = (id: string, params: Params, signal: AbortSignal | undefined, update: undefined, ctx: ExtensionContext) => Promise<Result>;
const execute = promisify(execFile);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "panels-tools-test-"));
const endpoint = path.join(root, "tmux.sock");
const agent = path.join(root, "agent");
const directories = new Set<string>();
const captures = new Set<string>();
const keys = ["PI_ORCHESTRATION_HOST", "PI_ORCHESTRATION_ENDPOINT", "TMUX_PANE", "PI_CODING_AGENT_DIR"];
const previous = keys.map(key => process.env[key]);
const hostKey = Symbol.for("pi-ant.orchestration.host");
const previousHost = Reflect.get(globalThis, hostKey);
let parent = "";
let next = 0;
async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!await predicate()) { assert.ok(Date.now() < deadline, "observed the expected lifecycle event"); await delay(10); }
}
before(async () => {
  fs.mkdirSync(agent, { mode: 0o700 });
  await execute("tmux", ["-S", endpoint, "-f", "/dev/null", "new-session", "-d", "-s", "panels-tools"]);
  parent = (await execute("tmux", ["-S", endpoint, "display-message", "-p", "#{pane_id}"])).stdout.trim();
  process.env.PI_ORCHESTRATION_HOST = "tmux";
  process.env.PI_ORCHESTRATION_ENDPOINT = endpoint;
  process.env.TMUX_PANE = parent;
  process.env.PI_CODING_AGENT_DIR = agent;
  Reflect.deleteProperty(globalThis, hostKey);
});
after(async () => {
  await execute("tmux", ["-S", endpoint, "kill-server"]).catch(() => undefined);
  for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
  for (const output of captures) removePanelOutput(output);
  keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
  if (previousHost === undefined) Reflect.deleteProperty(globalThis, hostKey); else Reflect.set(globalThis, hostKey, previousHost);
  fs.rmSync(root, { recursive: true, force: true });
});

function fixture(t: TestContext) {
  const name = `tools-${process.pid}-${next++}`;
  const tools = new Map<string, { execute: Execute; outputSchema?: object; renderCall(args: Partial<Params>): { render(width: number): string[] } }>();
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
  const notifications: string[] = [];
  const bindings: PanelBinding[] = [];
  const calls: string[][] = [];
  const controls = { failAllocate: false, failCapture: false, failObserve: false,
    onObserve: (_target: HostTarget, _signal?: AbortSignal) => {} };
  const pi = {
    registerTool: (tool: { name: string; execute: Execute; outputSchema?: object; renderCall(args: Partial<Params>): { render(width: number): string[] } }) => tools.set(tool.name, tool),
    registerCommand: (name: string, spec: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => commands.set(name, spec.handler),
    exec: async (command: string, args: string[]) => {
      assert.equal(command, "tmux"); calls.push(args);
      if (args[2] === "new-window") {
        const serialized = /'(\{"id":[^']+\})'/.exec(args.at(-1)!)?.[1];
        assert.ok(serialized, "native argv launches only the persistent wrapper");
        const binding = JSON.parse(serialized) as PanelBinding;
        bindings.push(binding); directories.add(binding.directory);
        const output = readPanelConfig(binding).outputPath;
        captures.add(output);
        if (controls.failAllocate) return { code: 1, stdout: "", stderr: "native allocation uncertain", killed: false };
      }
      if (controls.failCapture && args[2] === "display-message" && args.at(-1)?.includes("pane_pid")) {
        return { code: 1, stdout: "", stderr: "native capture failed", killed: false };
      }
      try { return { ...await execute(command, args, { timeout: 10_000 }), code: 0, killed: false }; }
      catch (error) {
        const failure = error as { code?: number; stdout?: string; stderr?: string };
        return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? String(error), killed: false };
      }
    },
  } as unknown as ExtensionAPI;
  const ctx = { cwd: root, isProjectTrusted: () => false, ui: { notify: (text: string) => notifications.push(text) } } as unknown as ExtensionContext;
  panelsExtension(pi, 50, async (target, signal) => {
    assert.ok(target.panel, "all hosts return held persistent ownership");
    assert.equal(savedPanelState(target.panel)?.command, "held");
    controls.onObserve(target, signal);
    if (controls.failObserve) throw new Error("observer startup failed");
    await activatePanel(target.panel, signal);
  });
  t.after(async () => {
    const target = readTarget(name);
    if (target?.panel && savedPanelState(target.panel)) await closePanel(target.panel).catch(() => undefined);
    removePanelOutput(target?.outputPath); removeTarget(name);
    for (const binding of bindings) if (savedPanelState(binding)) await closePanel(binding).catch(() => undefined);
  });
  return { name, controls, bindings, calls, notifications, tools,
    run: (tool: string, params: Partial<Params> = {}, signal?: AbortSignal) => tools.get(tool)!.execute("call", { name, ...params }, signal, undefined, ctx),
    list: () => commands.get("panels")!("", ctx) };
}

test("collapsed tool calls retain literal streaming arguments", t => {
  const f = fixture(t);
  const rendered = f.tools.get("panel-send")!.renderCall({ name: f.name, text: "Enter ctrl+c" }).render(100).join("\n");
  assert.match(rendered, /Enter ctrl\+c/);
});

test("raw argv is captured exactly once; ordinary finished output stays readable and closes", async t => {
  const f = fixture(t);
  const result = await f.run("panel-start", { command: "printf 'finished output'" });
  assert.equal(result.content[0].text, f.name);
  assert.deepEqual(result.structuredContent, { name: f.name, host: "tmux", cwd: root });
  const target = readTarget(f.name)!;
  assert.ok(target.panel && target.outputPath);
  const config = readPanelConfig(target.panel);
  assert.deepEqual(config.argv, panelArgv("printf 'finished output'", { cwd: root, isProjectTrusted: () => false }));
  assert.equal(config.outputPath, target.outputPath);
  await until(() => savedPanelState(target.panel!)?.command === "exited");
  const read = await f.run("panel-read");
  assert.match(read.content[0].text, /^finished output/, "the screen comes first, without an identity header");
  assert.deepEqual({ ...read.structuredContent, output: undefined }, { output: undefined, truncated: false, state: "exited", name: f.name, host: "tmux" });
  assert.match(String(read.structuredContent?.output), /^finished output/);
  await assert.rejects(f.run("panel-send", { text: "never inference" }), /exited/);
  await assert.rejects(f.run("panel-start", { command: "true" }), /Close it explicitly/);
  await f.run("panel-close");
  assert.equal(readTarget(f.name), undefined);
  assert.equal(fs.existsSync(target.outputPath), false);
});

test("text and keys reach only the owned PTY relay, never native send-keys", async t => {
  const f = fixture(t);
  await f.run("panel-start", { command: "printf READY; read line; printf 'VALUE:%s\\n' \"$line\"; read line" });
  const output = readTarget(f.name)!.outputPath!;
  await until(() => fs.readFileSync(output, "utf8").includes("READY"));
  const sent = await f.run("panel-send", { text: "literal Enter ctrl+c" });
  assert.equal(sent.structuredContent?.state, "sent", "text to a program without prompt marks is not followed");
  assert.match(String(sent.structuredContent?.output), /^VALUE:literal Enter ctrl\+c$/m, "output since the input");
  const read = await f.run("panel-read");
  assert.match(read.content[0].text, /VALUE:literal Enter ctrl\+c/);
  assert.equal(read.structuredContent?.state, "running", "a command without prompt marks counts as running");
  await f.run("panel-send", { keys: ["Escape"] });
  assert.equal(f.calls.some(args => args[2] === "send-keys"), false);
  await assert.rejects(f.run("panel-send"), /exactly one/);
});

test("same-batch starts/reads and closes/restarts serialize through the name claim", async t => {
  const f = fixture(t);
  const [started, read] = await Promise.all([f.run("panel-start", { command: "read line" }), f.run("panel-read")]);
  assert.equal(started.content[0].text, f.name);
  assert.equal(read.details.target.name, f.name);
  const [closed, restarted] = await Promise.all([f.run("panel-close"), f.run("panel-start", { command: "read line" })]);
  assert.deepEqual([closed.content[0].text, closed.structuredContent], [f.name, undefined], "close returns only the name, without a schema");
  assert.equal(f.tools.get("panel-close")!.outputSchema, undefined);
  for (const tool of ["panel-start", "panel-read", "panel-send"]) assert.ok(f.tools.get(tool)!.outputSchema, `${tool} declares its structured fields`);
  assert.equal(restarted.content[0].text, f.name);
});

test("panel-start forwards cancellation and never activates work cancelled in observer setup", async t => {
  const f = fixture(t);
  const abort = new AbortController();
  const marker = path.join(root, f.name);
  f.controls.onObserve = (_target, signal) => { assert.equal(signal, abort.signal); abort.abort(); };
  await assert.rejects(f.run("panel-start", { command: `touch '${marker}'` }, abort.signal), /abort|cancel/i);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(readTarget(f.name), undefined);
  assert.equal(savedPanelState(f.bindings[0])?.closed, true);
  const count = f.calls.length;
  await assert.rejects(f.run("panel-start", { command: "true" }, abort.signal), /abort/i);
  assert.equal(f.calls.length, count);
});

test("observer failure awaits acknowledged wrapper cleanup and releases capture/name", async t => {
  const f = fixture(t); f.controls.failObserve = true;
  await assert.rejects(f.run("panel-start", { command: "printf NEVER" }), /observer startup failed/);
  assert.equal(readTarget(f.name), undefined);
  assert.equal(savedPanelState(f.bindings[0])?.closed, true);
  assert.equal(fs.existsSync(readPanelConfig(f.bindings[0]).outputPath), false);
  claimName(f.name)();
});

test("uncertain host.start rollback retains the recoverable binding, capture and original errors", async t => {
  const f = fixture(t); f.controls.failAllocate = true;
  await assert.rejects(f.run("panel-start", { command: "printf NEVER" }), /native allocation uncertain[\s\S]*startup cleanup uncertain/);
  const retained = readTarget(f.name)!;
  assert.ok(retained.panel && retained.outputPath);
  assert.equal(retained.panel.id, f.bindings[0].id);
  assert.ok(fs.existsSync(retained.outputPath));
  assert.match(retained.closeError!, /native allocation uncertain/);
  assert.ok(fs.existsSync(path.join(retained.panel.directory, "cancelled")));
  await f.list(); assert.match(f.notifications[0], /native allocation uncertain/);
});

test("acknowledged host.start rollback removes capture instead of retaining a false live target", async t => {
  const f = fixture(t); f.controls.failCapture = true;
  await assert.rejects(f.run("panel-start", { command: "printf NEVER" }), /Cannot capture/);
  assert.equal(readTarget(f.name), undefined);
  assert.equal(savedPanelState(f.bindings[0])?.closed, true);
  assert.equal(fs.existsSync(readPanelConfig(f.bindings[0]).outputPath), false);
});

test("shell configuration retains bash login semantics without wrapping the command in script", () => {
  const context = { cwd: agent, isProjectTrusted: () => false };
  const argv = panelArgv('false | true; printf "%s" "${PIPESTATUS[0]}"', context);
  assert.deepEqual(argv.slice(1, 3), ["-l", "-c"]);
  assert.equal(execFileSync(argv[0], argv.slice(1), { encoding: "utf8" }), "1");
});
