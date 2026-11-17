import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import type { ExtensionAPI, ExtensionContext, ExecResult } from "@earendil-works/pi-coding-agent";
import { acquireClaim, createClaimTestEnvironment, releaseClaim } from "@phimacs/pimux/ownership";
import { readProcessIdentity } from "@phimacs/pimux/process-identity";
import type { HostTarget } from "../host-types.ts";
import terminalInput from "../extensions/terminal-input.ts";
import { createHerdrHost } from "./herdr.ts";
import { createTmuxHost } from "./tmux.ts";
import { createEmacsHost } from "./emacs.ts";
import { PANEL_RUNTIME, createPanelBinding } from "../panel-runtime.ts";
import { terminalRequest } from "../terminal-input.ts";

const PI = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
const oldPi = process.env.PHIMACS_PI;
const nativeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hosts-native-fixture-"));
const nativeServers = [net.createServer((client) => client.destroy()), net.createServer((client) => client.destroy())];
before(async () => {
  process.env.PHIMACS_PI = PI;
  await Promise.all(nativeServers.map((server, index) => new Promise<void>((resolve) => server.listen(path.join(nativeRoot, index ? "herdr.sock" : "tmux.sock"), resolve))));
});
function reply(payload: unknown = "", code = 0): ExecResult {
  return { code, stdout: typeof payload === "string" ? payload : JSON.stringify(payload), stderr: "", truncated: false, killed: false };
}
const controls = new Map<string, net.Server>();
const sockets = new Set<net.Socket>();
const children = new Set<ChildProcess>();
after(async () => {
  await Promise.all(nativeServers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  fs.rmSync(nativeRoot, { recursive: true, force: true });
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "close"); child.kill(); await exited; }
  }
  for (const socket of sockets) socket.destroy();
  for (const [socketPath, server] of controls) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(path.dirname(socketPath), { recursive: true, force: true });
  }
  if (oldPi === undefined) delete process.env.PHIMACS_PI; else process.env.PHIMACS_PI = oldPi;
});
function fake(responses: ExecResult[]): { pi: ExtensionAPI; calls: string[][]; prompts: unknown[] } {
  const calls: string[][] = [];
  const prompts: unknown[] = [];
  const pi = { exec: async (command: string, args: string[]) => {
    calls.push([command, ...args]);
    const response = responses.shift();
    assert.ok(response, `Unexpected command ${command} ${args.join(" ")}`);
    const launch = args.at(-1) ?? "";
    if (response.code === 0 && launch.includes("'tui' '--'")) {
      const assignment = calls.flat().find((arg) => arg.startsWith("PI_ORCHESTRATION_CONTROL="));
      assert.ok(assignment);
      const socketPath = assignment.slice("PI_ORCHESTRATION_CONTROL=".length);
      const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
      children.add(child);
      await once(child, "spawn");
      const identity = readProcessIdentity(child.pid!)!;
      const server = net.createServer((client) => {
        sockets.add(client); client.on("close", () => sockets.delete(client));
        client.once("data", (chunk) => {
          const request = JSON.parse(chunk.toString()) as { kind: string };
          prompts.push(request);
          client.end(`${JSON.stringify({ dispatched: true, process: identity })}\n`);
          if (request.kind === "stop") child.stdin?.end();
        });
      });
      controls.set(socketPath, server);
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    }
    return response;
  } } as unknown as ExtensionAPI;
  return { pi, calls, prompts };
}
const tmuxParent: HostTarget = { host: "tmux", endpoint: path.join(nativeRoot, "tmux.sock"), id: "%4", paneId: "%4", name: "parent", kind: "pi" };
const herdrParent: HostTarget = { host: "herdr", endpoint: path.join(nativeRoot, "herdr.sock"), id: "w1:p4", paneId: "w1:p4", name: "parent", kind: "pi" };

test("native shell send/state/Close use exact persistent control, never pane aliases", async () => {
  const binding = createPanelBinding({ argv: ["true"], cwd: "/tmp" });
  const identity = readProcessIdentity(process.pid)!;
  const received: unknown[] = [];
  let closed = false;
  const panels = { ...PANEL_RUNTIME,
    send: async (panel: typeof binding, input: unknown) => { assert.equal(panel, binding); received.push(input); },
    status: async () => ({ schema: 1 as const, id: binding.id, process: identity, command: "exited" as const, closed: false }),
    close: async (panel: typeof binding) => { assert.equal(panel, binding); closed = true; },
    read: () => "finished output",
  };
  try {
    for (const kind of ["tmux", "herdr"] as const) {
      const pi = { exec: async () => { throw new Error("Reusable native aliases must not receive shell mutations"); } } as unknown as ExtensionAPI;
      const host = kind === "tmux" ? createTmuxHost(pi, tmuxParent.endpoint, panels) : createHerdrHost(pi, herdrParent.endpoint, panels);
      const target: HostTarget = { host: kind, endpoint: "replacement", id: "reused-alias", name: "owned", kind: "shell", panel: binding };
      await host.send(target, { kind: "text", text: "literal", enter: true });
      await host.send(target, { kind: "keys", keys: ["ctrl+c"] });
      assert.equal(await host.state(target), "exited");
      assert.equal(await host.read(target), "finished output");
      await host.close(target);
      assert.equal(closed, true);
    }
    assert.equal(received.length, 4);
  } finally { fs.rmSync(binding.directory, { recursive: true, force: true }); }
});

test("native control operations cap output and reject truncated successful replies", async () => {
  for (const kind of ["tmux", "herdr", "emacs"] as const) {
    const pi: Pick<ExtensionAPI, "exec"> = { exec: async (_command, _args, options) => {
      assert.equal(options?.maxBuffer, 1024 * 1024);
      return { ...reply("partial"), truncated: true };
    } };
    const host = kind === "tmux" ? createTmuxHost(pi, tmuxParent.endpoint)
      : kind === "herdr" ? createHerdrHost(pi, herdrParent.endpoint) : createEmacsHost(pi, tmuxParent.endpoint);
    if (kind === "emacs") {
      await assert.rejects(host.start({ kind: "pi", name: "truncated", cwd: "/tmp", sessionFile: "/tmp/unused-session.jsonl", placement: "worker", args: [] }), /truncated/);
    } else {
      const parent = kind === "tmux" ? tmuxParent : herdrParent;
      await assert.rejects(host.state(parent), /truncated/);
      await assert.rejects(host.close(parent), /truncated/);
      await assert.rejects(host.read(parent), /truncated/);
    }
  }
});

test("tmux Pi fork placement never uses the focused pane", async () => {
  const { pi, calls } = fake([reply("%8\n"), reply("%8"), reply()]);
  const host = createTmuxHost(pi, tmuxParent.endpoint);
  const target = await host.start({ kind: "pi", name: "fork", cwd: "/tmp", placement: "interactive-fork", parent: tmuxParent, sessionFile: "/tmp/fake-session", args: [] });
  assert.deepEqual(calls[0].slice(3, 8), ["split-window", "-d", "-t", "%4", "-P"]);
  await host.close(target);
  await assert.rejects(host.start({ kind: "shell", name: "bad", cwd: "/tmp", placement: "worker", argv: ["true"] }), /explicit parent/);
});

test("tmux missing process is not completion and prompt text is not terminal keys", async () => {
  const { pi } = fake([reply("missing", 1), reply("")]);
  const host = createTmuxHost(pi, tmuxParent.endpoint);
  assert.equal(await host.state(tmuxParent), "missing");
  assert.equal(await host.state(tmuxParent), "missing");
  await assert.rejects(host.send({ ...tmuxParent, kind: "shell" }, { kind: "prompt", text: "Enter" }), /owned control endpoint/);
});

test("native tmux and Herdr start an absolute managed wrapper before Pi and keep drafts untouched", async () => {
  for (const kind of ["tmux", "herdr"] as const) {
    const responses = kind === "tmux" ? [reply("$1"), reply("%8"), reply("%8"), reply()]
      : [reply({ result: { pane: { workspace_id: "w1" } } }), reply({ result: { root_pane: { pane_id: "w1:p8" } } }), reply(), reply(), reply()];
    const { pi, calls, prompts } = fake(responses);
    const host = kind === "tmux" ? createTmuxHost(pi, tmuxParent.endpoint) : createHerdrHost(pi, herdrParent.endpoint);
    const sessionFile = "/tmp/synthetic-session.jsonl";
    const target = await host.start({ kind: "pi", name: "worker-one", cwd: "/tmp", sessionFile, args: ["--model", "test-model"], prompt: "Worker task", placement: "worker", parent: kind === "tmux" ? tmuxParent : herdrParent });
    assert.equal(target.id, kind === "tmux" ? "%8" : "w1:p8");
    const launch = calls.find((call) => call.at(-1)?.includes("'tui' '--'"))!.at(-1)!;
    assert.ok(launch.includes(`'${process.execPath}'`));
    assert.ok(launch.includes(`'${fs.realpathSync(PI)}'`));
    assert.match(launch, /\/pimux' 'tui' '--'/);
    assert.equal(calls.some((call) => call.includes("agent") && call.includes("start")), false, "Herdr's PATH-pi entry is not used");
    assert.deepEqual(prompts, [{ kind: "ping", sessionFile }, { kind: "prompt", text: "Worker task", process: target.process }]);
    if (kind === "herdr") assert.ok(calls.some((call) => call.includes("rename") && call.includes("worker-one")), "native agent names are preserved after managed launch");
    assert.ok(target.process?.startTime);
    const callsBeforeState = calls.length;
    assert.equal(await host.state(target), "running");
    assert.equal(calls.length, callsBeforeState, "actual Pi identity, not the pane/server, decides liveness");
    await host.close(target);
    assert.equal(await host.state(target), "exited");
  }
});

test("Herdr fork uses explicit parent rectangle even if another pane is focused", async () => {
  const { pi, calls } = fake([
    reply({ result: { layout: { focused_pane_id: "w1:p9", panes: [{ pane_id: "w1:p4", rect: { width: 100, height: 20 } }, { pane_id: "w1:p9", rect: { width: 20, height: 80 } }] } } }),
    reply({ result: { pane: { pane_id: "w1:p8" } } }), reply(), reply(), reply(),
  ]);
  const host = createHerdrHost(pi, herdrParent.endpoint);
  const target = await host.start({ kind: "pi", name: "fork", cwd: "/tmp", sessionFile: "/tmp/herdr-fork-session", args: [], placement: "interactive-fork", parent: herdrParent });
  await host.close(target);
  assert.deepEqual(calls[1].slice(3, 8), ["pane", "split", "w1:p4", "--direction", "right"]);
});

async function listeningSocket(): Promise<{ endpoint: string; stop: () => Promise<void> }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-socket-"));
  const endpoint = path.join(dir, "herdr.sock");
  const server = net.createServer((client) => client.destroy());
  await new Promise<void>((resolve) => server.listen(endpoint, resolve));
  return { endpoint, stop: async () => { await new Promise<void>((resolve) => server.close(() => resolve())); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test("process-start identities detect reuse without querying a surviving Herdr shell", async () => {
  const { pi, calls } = fake([]);
  const self = readProcessIdentity(process.pid)!;
  const target: HostTarget = { ...herdrParent, process: { ...self, startTime: `${BigInt(self.startTime) + 1n}` } };
  assert.equal(await createHerdrHost(pi, target.endpoint).state(target), "exited");
  assert.equal(calls.length, 0);
});

test("native Pi surface cleanup distinguishes a stopped Herdr server from live failures", async () => {
  const notRunning = () => reply({ error: { code: "server_not_running" } }, 1);
  const server = await listeningSocket();
  const target = { ...herdrParent, endpoint: server.endpoint };
  try {
    const { pi } = fake([notRunning(), notRunning()]);
    const host = createHerdrHost(pi, server.endpoint);
    await assert.rejects(host.state(target), /server_not_running/);
    await assert.rejects(host.close(target), /server_not_running/);
  } finally { await server.stop(); }
  const { pi } = fake([notRunning(), notRunning()]);
  const host = createHerdrHost(pi, server.endpoint);
  assert.equal(await host.state(target), "missing");
  await host.close(target);
});

test("native host validation refuses before allocating control paths or creating surfaces", async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "phimacs-native-validation-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = temporary;
  t.after(() => { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; });
  for (const kind of ["tmux", "herdr"] as const) {
    const { pi, calls } = fake([reply("$1"), reply({ result: { pane: { workspace_id: "w1" } } })]);
    const host = kind === "tmux" ? createTmuxHost(pi, tmuxParent.endpoint) : createHerdrHost(pi, herdrParent.endpoint);
    await assert.rejects(host.start({ kind: "pi", name: "invalid-host", cwd: temporary,
      sessionFile: path.join(temporary, "session.jsonl"), args: [], env: { PHIMACS_PI: "pi" },
      placement: "worker", parent: kind === "tmux" ? tmuxParent : herdrParent }), /absolute/);
    assert.equal(calls.length, 0, "an invalid release must not create or query a native surface");
    assert.deepEqual(fs.readdirSync(temporary), [], "invalid launches must not leak private control directories");
  }
});

test("Herdr failed startup closes only the newly created target", async () => {
  const { pi, calls } = fake([reply({ result: { pane: { workspace_id: "w1" } } }), reply({ result: { root_pane: { pane_id: "w1:p8" } } }), reply("could not start", 1), reply()]);
  await assert.rejects(createHerdrHost(pi, herdrParent.endpoint).start({ kind: "pi", name: "worker", cwd: "/tmp", sessionFile: "/tmp/session", args: [], placement: "worker", parent: herdrParent }), /could not start/);
  assert.deepEqual(calls.at(-1)?.slice(3), ["pane", "close", "w1:p8"]);
});

test("cancellation during native creation closes only its returned surface", async () => {
  for (const kind of ["tmux", "herdr"] as const) {
    const controller = new AbortController();
    const responses = kind === "tmux" ? [reply("$1"), reply("%8"), reply("%8"), reply()]
      : [reply({ result: { pane: { workspace_id: "w1" } } }), reply({ result: { root_pane: { pane_id: "w1:p8" } } }), reply()];
    const { pi, calls } = fake(responses);
    const original = pi.exec;
    pi.exec = async (command, args, options) => { const response = await original(command, args, options); if (args.includes("new-window") || args.includes("create")) controller.abort(); return response; };
    const host = kind === "tmux" ? createTmuxHost(pi, tmuxParent.endpoint) : createHerdrHost(pi, herdrParent.endpoint);
    await assert.rejects(host.start({ kind: "pi", name: "cancelled", cwd: "/tmp", sessionFile: "/tmp/session", args: [], placement: "worker", parent: kind === "tmux" ? tmuxParent : herdrParent }, controller.signal));
    assert.ok(calls.at(-1)?.includes(kind === "tmux" ? "kill-pane" : "close"));
  }
});

test("terminal input requires a real guard capability and never reads or edits the human draft", async (t) => {
  const sandbox = createClaimTestEnvironment();
  const keys = ["PHIMACS_TEST_ROOT", "PHIMACS_MANAGED_CLAIM", "PI_ORCHESTRATION_CONTROL"];
  const previous = keys.map((key) => process.env[key]);
  const socketPath = path.join(sandbox.root, "input.sock");
  const self = readProcessIdentity(process.pid)!;
  const source = acquireClaim(path.join(sandbox.sessions, "source.jsonl"), { id: "terminal-test", kind: "rpc", wrapper: self, pi: self, protocol: 2 }, sandbox.options);
  process.env.PHIMACS_TEST_ROOT = sandbox.root;
  process.env.PHIMACS_MANAGED_CLAIM = JSON.stringify(source);
  process.env.PI_ORCHESTRATION_CONTROL = socketPath;
  const hooks = new Map<string, (event?: unknown, ctx?: ExtensionContext) => Promise<void>>();
  t.after(async () => {
    await hooks.get("session_shutdown")?.();
    delete (globalThis as typeof globalThis & { [key: symbol]: unknown })[Symbol.for("phimacs:managed-session-guard")];
    releaseClaim(source);
    keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
    fs.rmSync(sandbox.root, { recursive: true, force: true });
  });
  const sent: unknown[][] = [];
  terminalInput({ on: (name: string, handler: (event?: unknown, ctx?: ExtensionContext) => Promise<void>) => hooks.set(name, handler), sendUserMessage: (...args: unknown[]) => sent.push(args) } as unknown as ExtensionAPI);
  await hooks.get("session_start")!(undefined, { sessionManager: { getSessionFile: () => source.file } } as unknown as ExtensionContext);
  assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
  const receipt = await terminalRequest(socketPath, { kind: "ping", sessionFile: source.file });
  assert.deepEqual(receipt.process, self);
  await assert.rejects(terminalRequest(socketPath, { kind: "ping", sessionFile: path.join(sandbox.sessions, "wrong") }), /expected session/);
  await terminalRequest(socketPath, { kind: "prompt", text: '/example "a\nb"\u2028literal' });
  assert.deepEqual(sent, [['/example "a\nb"\u2028literal', { deliverAs: "followUp", expandPromptTemplates: true }]]);
  await assert.rejects(terminalRequest(socketPath, { kind: "prompt", text: "wrong owner", process: { ...self, startTime: `${self.startTime}0` } }), /identity mismatch/);
  assert.equal(sent.length, 1);
  const next = path.join(sandbox.sessions, "next.jsonl");
  await hooks.get("session_start")!(undefined, { sessionManager: { getSessionFile: () => next } } as unknown as ExtensionContext);
  await assert.rejects(terminalRequest(socketPath, { kind: "ping", sessionFile: source.file }), /expected session/);
  assert.equal((await terminalRequest(socketPath, { kind: "ping", sessionFile: next })).sessionFile, next);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(async () => terminalRequest(socketPath, { kind: "ping" }, controller.signal));
});
