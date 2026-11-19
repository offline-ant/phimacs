import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readProcessIdentity } from "@phimacs/pimux/process-identity";
import type { RuntimeReceipt } from "@phimacs/pimux/runtime";
import { createEmacsHost, emacsOperation, EmacsUnresponsiveError, type EmacsExec, type EmacsRuntimeServices } from "./emacs.ts";
import type { HostTarget, StartSpec } from "../host-types.ts";
import { PanelStartError, type PanelBinding, type PanelState, type PanelRuntimeServices } from "../panel-runtime.ts";

const NO_ANSWER = Symbol("no answer");
const PI = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
const identity = readProcessIdentity(process.pid)!;
const receipt: RuntimeReceipt = { protocol: 2, muxId: "owned-runtime", operationId: "owned-operation", socket: "/test/runtime.sock", pid: process.pid,
  piPid: process.pid, sessionFile: "/tmp/test.jsonl", state: "committed", outcome: "started" };
const spec: Extract<StartSpec, { kind: "pi" }> = { kind: "pi", name: "worker", cwd: "/tmp", sessionFile: receipt.sessionFile, args: [], placement: "worker",
  env: { PHIMACS_PI: PI, PHIMACS_PARENT_TASK: JSON.stringify({ process: identity, taskId: "task-1" }) } };
const target: HostTarget & { runtime: RuntimeReceipt; process: typeof identity } = { host: "emacs", endpoint: "/test/socket", id: "owned", kind: "pi", name: "worker", runtime: receipt, process: identity };
function fakeEmacs(handler: (data: Record<string, unknown>) => object | typeof NO_ANSWER, endpoint = "/test/socket"): ExtensionAPI {
  return { async exec(command: string, args: string[]) {
    assert.equal(command, "emacsclient");
    assert.deepEqual(args.slice(0, 3), ["--socket-name", endpoint, "--eval"]);
    const encoded = /pi-orchestration-dispatch "([A-Za-z0-9+/=]+)"/.exec(args[3])?.[1];
    assert.ok(encoded);
    const reply = handler(JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Record<string, unknown>);
    return reply === NO_ANSWER ? { code: 0, stdout: "", stderr: "", killed: true }
      : { code: 0, stdout: JSON.stringify(Buffer.from(JSON.stringify(reply)).toString("base64")), stderr: "", killed: false };
  } } as unknown as ExtensionAPI;
}
function runtime(overrides: Partial<EmacsRuntimeServices> = {}): EmacsRuntimeServices {
  return { start: async () => receipt, stop: async (muxId) => ({ protocol: 2, muxId, operationId: "stop", state: "stopped", code: 0, signal: null, stoppedAt: new Date().toISOString() }),
    request: async () => ({ success: true }), identity: () => identity, ...overrides };
}
function normal(data: Record<string, unknown>): object {
  switch (data.operation) {
    case "start": return { target: { ...target, id: data.id }, muxId: receipt.muxId };
    case "state": return { state: "running", ready: true, muxId: receipt.muxId };
    case "close": assert.equal(data.detachOnly, true); return { success: true };
    default: throw new Error(`Unexpected operation: ${String(data.operation)}`);
  }
}

test("killed and empty emacsclient responses are typed uncertainty; bounded query/mutation timeouts", async () => {
  const timeouts = new Map<string, number>();
  const exec: EmacsExec = async (_command, args, { timeout }) => {
    const encoded = /pi-orchestration-dispatch "([A-Za-z0-9+/=]+)"/.exec(args[3])![1];
    timeouts.set(String((JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as { operation: string }).operation), timeout);
    return { code: 0, stdout: "", stderr: "", killed: true };
  };
  for (const operation of ["state", "read", "start", "close", "switch"]) await assert.rejects(emacsOperation(exec, "/test/socket", { operation }), EmacsUnresponsiveError);
  assert.deepEqual(Object.fromEntries(timeouts), { state: 10_000, read: 10_000, start: 60_000, close: 60_000, switch: 60_000 });
  for (const stdout of ["", "\n", '""\n']) await assert.rejects(emacsOperation(async () => ({ code: 0, stdout, stderr: "", killed: false }), "/test/socket", { operation: "state" }), EmacsUnresponsiveError);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(emacsOperation(exec, "/test/socket", { operation: "state" }, controller.signal), /abort/i);
});

test("launches exact owned RPC first, submits once independently of Emacs, then attaches its receipt", async () => {
  const events: string[] = [];
  let states = 0;
  const services = runtime({
    start: async (options) => {
      events.push("launch");
      assert.equal(options.command, PI);
      assert.deepEqual(options.args, ["--mode", "rpc", "--session", receipt.sessionFile]);
      assert.deepEqual(options.parent, { process: identity, taskId: "task-1" });
      return receipt;
    },
    request: async (received, command) => { events.push("prompt"); assert.equal(received.muxId, receipt.muxId); assert.deepEqual(command, { type: "prompt", message: "quotes\"\n你好 (kill-emacs)", streamingBehavior: "steer" }); return { success: true }; },
  });
  const pi = fakeEmacs((data) => {
    events.push(String(data.operation));
    if (data.operation === "start") { const sent = data.spec as { runtime: RuntimeReceipt; process: typeof identity }; assert.deepEqual(sent.runtime, receipt); assert.deepEqual(sent.process, identity); }
    if (data.operation === "state" && ++states < 3) return NO_ANSWER;
    return normal(data);
  });
  const started = await createEmacsHost(pi, "/test/socket", services).start({ ...spec, prompt: "quotes\"\n你好 (kill-emacs)" });
  assert.equal((started as typeof target).process.startTime, identity.startTime);
  assert.deepEqual(events, ["launch", "prompt", "start", "state", "state", "state"], "work starts before the view draws");
});

test("invalid worker parent refuses before launch", async () => {
  let starts = 0;
  const services = runtime({ start: async () => { starts++; return receipt; } });
  await assert.rejects(createEmacsHost(fakeEmacs(normal), "/test/socket", services).start({ ...spec, env: { PHIMACS_PI: PI } }), /parent process identity/);
  assert.equal(starts, 0);
});

test("Pi liveness and send/read do not inspect or require the Emacs view", async () => {
  const services = runtime({ request: async (_runtime, command) => command.type === "get_messages" ? { success: true, data: { messages: [{ role: "assistant", content: "saved" }] } } : { success: true } });
  const host = createEmacsHost(fakeEmacs(() => { throw new Error("frontend unavailable"); }), "/test/socket", services);
  assert.equal(await host.state(target), "running");
  await host.send(target, { kind: "prompt", text: "hello" });
  assert.match(await host.read(target), /saved/);
  const reused: typeof target = { ...target, process: { ...identity, startTime: "0" } };
  assert.equal(await host.state(reused), "exited");
  await assert.rejects(host.state({ host: "emacs", endpoint: "/test/socket", id: "old", kind: "pi", name: "old" }), /process-start identity/);
});

test("explicit task close stops runtime before view detach and tolerates a lost daemon", async () => {
  const events: string[] = [];
  const services = runtime({ stop: async (id) => { events.push(`stop:${id}`); return { protocol: 2, muxId: id, operationId: "stop", state: "stopped", code: 0, signal: null, stoppedAt: "now" }; } });
  await createEmacsHost(fakeEmacs((data) => {
    events.push(String(data.operation));
    assert.equal(data.taskOwned, true, "parent exit precedes final task acknowledgement");
    return normal(data);
  }), "/test/socket", services).close(target);
  assert.deepEqual(events, [`stop:${receipt.muxId}`, "close"]);
  await createEmacsHost(fakeEmacs(() => { throw new Error("daemon lost"); }), "/test/socket", services).close(target);
  const uncertain = runtime({ stop: async () => { throw new Error("owned stop uncertain"); } });
  await assert.rejects(createEmacsHost(fakeEmacs(() => { throw new Error("must preserve view"); }), "/test/socket", uncertain).close(target), /owned stop uncertain/);
});

test("live frontend cleanup failures propagate and preserve the original attachment error", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "emacs-live-cleanup-"));
  const socket = path.join(directory, "server");
  const server = net.createServer(client => client.destroy());
  await new Promise<void>(resolve => server.listen(socket, resolve));
  try {
    const pi = fakeEmacs(data => {
      if (data.operation === "start") return { error: "original attachment failure" };
      if (data.operation === "close") return { error: "live native cleanup failure" };
      return normal(data);
    }, socket);
    const host = createEmacsHost(pi, socket, runtime());
    await assert.rejects(host.close({ ...target, endpoint: socket }), /live native cleanup failure/);
    await assert.rejects(host.start({ ...spec, runtime: receipt }), error => {
      assert.match(String(error), /original attachment failure/);
      assert.match(String(error), /live native cleanup failure/);
      return true;
    });
    let detachCalls = 0;
    const uncertain = createEmacsHost(fakeEmacs(data => {
      if (data.operation === "start") return { error: "original startup failure" };
      if (data.operation === "close") detachCalls++;
      return normal(data);
    }, socket), socket, runtime({ stop: async () => { throw new Error("owned runtime exit uncertain"); } }));
    await assert.rejects(uncertain.start(spec), error => {
      assert.match(String(error), /original startup failure/);
      assert.match(String(error), /owned runtime exit uncertain/);
      return true;
    });
    assert.equal(detachCalls, 0, "uncertain owned-runtime cleanup retains its view");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("task cleanup acknowledgement carries the exact runtime and retained error", async () => {
  const sent: Record<string, unknown>[] = [];
  const host = createEmacsHost(fakeEmacs((data) => { sent.push(data); return { success: true }; }), "/test/socket", runtime());
  await host.taskFinished!(target);
  await host.taskFinished!(target, "Original task error; native cleanup uncertain");
  assert.deepEqual(sent, [
    { operation: "task-finished", id: target.id, muxId: receipt.muxId },
    { operation: "task-finished", id: target.id, muxId: receipt.muxId, error: "Original task error; native cleanup uncertain" },
  ]);
});

test("failed/cancelled worker attachment cleans up only its newly started task, never attached roots", async () => {
  for (const outcome of ["started", "attached"] as const) {
    let stops = 0;
    let detached: unknown;
    const services = runtime({ start: async () => ({ ...receipt, outcome }), stop: async (id) => { stops++; return { protocol: 2, muxId: id, operationId: "stop", state: "stopped", code: 0, signal: null, stoppedAt: "now" }; } });
    const pi = fakeEmacs((data) => {
      if (data.operation === "start") return { error: "view attach failed" };
      if (data.operation === "close") detached = data.muxId;
      return normal(data);
    });
    await assert.rejects(createEmacsHost(pi, "/test/socket", services).start(spec), outcome === "started"
      ? /view attach failed.*no prompt was replayed/ : /already has a live runtime.*no prompt was replayed/);
    assert.equal(stops, outcome === "started" ? 1 : 0);
    assert.equal(detached, receipt.muxId);
  }
  let stops = 0;
  const controller = new AbortController();
  const pi = fakeEmacs((data) => { if (data.operation === "state") controller.abort(); return normal(data); });
  await assert.rejects(createEmacsHost(pi, "/test/socket", runtime({ stop: async (id) => { stops++; return { protocol: 2, muxId: id, operationId: "stop", state: "stopped", code: 0, signal: null, stoppedAt: "now" }; } })).start(spec, controller.signal), /abort/i);
  assert.equal(stops, 1);
});

test("a worker that finishes during frontend attachment returns to its task evidence; other early exits fail", async () => {
  const exited = { ...identity, startTime: "0" };
  const events: string[] = [];
  const services = runtime({
    identity: () => exited,
    request: async () => { events.push("prompt"); return { success: true }; },
    stop: async (muxId) => { events.push("stop"); return { protocol: 2, muxId, operationId: "stop", state: "stopped", code: 0, signal: null, stoppedAt: "now" }; },
  });
  // The view never reports live: the worker's Pi finished and exited first.
  const unready = fakeEmacs((data) => {
    events.push(String(data.operation));
    return data.operation === "state" ? { state: "exited", ready: false, muxId: receipt.muxId } : normal(data);
  });
  const started = await createEmacsHost(unready, "/test/socket", services).start({ ...spec, prompt: "finish at once" });
  assert.deepEqual((started as typeof target).process, exited, "the caller judges the exact exited worker by its result");
  assert.deepEqual(events, ["prompt", "start", "state"], "no stop, detach or replay of a finished worker");

  events.length = 0;
  const fork = { ...spec, placement: "interactive-fork" as const, env: { PHIMACS_PI: PI } };
  await assert.rejects(createEmacsHost(unready, "/test/socket", services).start(fork),
    /Detached Pi exited during frontend attachment.*no prompt was replayed/);
  assert.deepEqual(events, ["start", "state", "close"], "a failed fork detaches its view and never stops a non-worker");

  // A view observed live completed attachment even if Pi exited before this poll.
  const forked = await createEmacsHost(fakeEmacs(normal), "/test/socket", services).start(fork);
  assert.deepEqual((forked as typeof target).process, exited);
});

test("a supplied runtime's historical started receipt never authorizes failed-view cleanup", async () => {
  let stops = 0;
  let starts = 0;
  const services = runtime({
    start: async () => { starts++; return receipt; },
    stop: async (muxId) => { stops++; return { protocol: 2, muxId, operationId: "stop", state: "stopped", code: 0, signal: null, stoppedAt: "now" }; },
  });
  const pi = fakeEmacs((data) => data.operation === "start" ? { error: "view attach failed" } : normal(data));
  await assert.rejects(createEmacsHost(pi, "/test/socket", services).start({ ...spec, runtime: receipt }), /view attach failed/);
  assert.equal(starts, 0);
  assert.equal(stops, 0);
});

test("runtime rejects are not mistaken for acceptance, targets without a runtime binding cannot stop", async () => {
  const host = createEmacsHost(fakeEmacs(normal), "/test/socket", runtime({ request: async () => ({ success: false, error: "Compacting" }) }));
  await assert.rejects(host.send(target, { kind: "prompt", text: "human" }), /Compacting/);
  await assert.rejects(host.send(target, { kind: "keys", keys: ["ctrl+c"] }), /not terminal keys/);
  await assert.rejects(host.close({ host: "emacs", endpoint: "/test/socket", id: "old", kind: "pi", name: "old" }), /unowned Pi/);
});

const shell: Extract<StartSpec, { kind: "shell" }> = {
  kind: "shell", name: "logs", cwd: "/tmp", argv: ["/bin/sh", "-c", "read line; printf '%s' \"$line\""],
  outputPath: "/tmp/synthetic-panel-capture", placement: "worker",
};
const binding: PanelBinding = { id: "exact-panel", directory: "/synthetic/private-panel", creator: identity };

function panelServices(events: string[], overrides: Partial<PanelRuntimeServices> = {}) {
  const state: PanelState = { schema: 1, id: binding.id, process: identity, command: "held", closed: false };
  const services: PanelRuntimeServices = {
    create(options) {
      events.push("create");
      assert.deepEqual(options.argv, shell.argv, "wrapper receives raw argv, not a nested capture PTY");
      assert.equal(options.outputPath, shell.outputPath);
      assert.equal(options.native?.kind, "emacs");
      return binding;
    },
    argv(received) { assert.equal(received, binding); return ["/synthetic/wrapper", received.id]; },
    async ready(received) { events.push("ready"); assert.equal(received, binding); return { ...received, process: identity }; },
    async activate() { assert.fail("native allocation must leave the command held for its observer"); },
    async send(received, input) {
      events.push("input"); assert.equal(received.id, binding.id);
      assert.deepEqual(input, { kind: "text", text: "literal input", enter: true });
    },
    read(received) { events.push("read"); assert.equal(received.id, binding.id); return "captured output"; },
    async status(received) { events.push("status"); assert.equal(received.id, binding.id); return { ...state }; },
    async close(received) { events.push("panel-close"); assert.equal(received.id, binding.id); state.closed = true; state.command = "exited"; },
    async rollback(received) { events.push("rollback"); assert.equal(received.id, binding.id); state.closed = true; state.command = "exited"; },
    ...overrides,
  };
  return { state, services };
}

test("Emacs shell allocation is held and all command operations use exact persistent control", async () => {
  const events: string[] = [];
  const { services, state } = panelServices(events);
  const pi = fakeEmacs(data => {
    if (data.operation === "start") {
      events.push("native-start");
      const forwarded = data.spec as Extract<StartSpec, { kind: "shell" }> & { panel: PanelBinding; panelControl: string[] };
      assert.deepEqual(forwarded.argv, ["/synthetic/wrapper", binding.id]);
      assert.deepEqual(forwarded.panel, binding);
      assert.equal(forwarded.outputPath, shell.outputPath);
      assert.equal(forwarded.panelControl[0], process.execPath);
      assert.match(forwarded.panelControl[1], /dist\/panel-close\.js$/);
      assert.deepEqual(JSON.parse(forwarded.panelControl[2]), binding);
      return { target: { id: data.id } };
    }
    assert.equal(data.operation, "close", "input/read/state cannot reach a reused Emacs target alias");
    events.push("view-close");
    assert.equal(state.closed, true, "wrapper cleanup acknowledgement precedes native disposal");
    assert.equal(data.panelId, binding.id);
    return { success: true };
  });
  const host = createEmacsHost(pi, "/test/socket", runtime(), services);
  const started = await host.start(shell);
  assert.deepEqual(events, ["create", "native-start", "ready"]);
  assert.equal(state.command, "held");
  assert.deepEqual(started.panel, { ...binding, process: identity });
  await host.send(started, { kind: "text", text: "literal input", enter: true });
  assert.equal(await host.read(started), "captured output");
  assert.equal(await host.state(started), "running");
  state.command = "exited";
  assert.equal(await host.state(started), "exited", "command completion is independent of wrapper lifetime");
  assert.equal(state.closed, false);
  await host.close(started);
  assert.deepEqual(events.slice(-2), ["panel-close", "view-close"]);
});

test("an uncertain native panel disposal does not send the Emacs close again", async () => {
  const events: string[] = [];
  const { services } = panelServices(events);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "emacs-panel-close-"));
  const socket = path.join(directory, "server");
  const server = net.createServer(client => client.destroy());
  await new Promise<void>(resolve => server.listen(socket, resolve));
  try {
    const pi = fakeEmacs(data => {
      assert.equal(data.operation, "close");
      assert.equal(data.panelId, binding.id);
      events.push("view-close");
      return { pending: true };
    }, socket);
    const target: HostTarget = { host: "emacs", endpoint: socket, id: "native", kind: "shell", name: "synthetic", panel: binding };
    await assert.rejects(createEmacsHost(pi, socket, runtime(), services).close(target), /did not acknowledge panel Close/);
    assert.deepEqual(events, ["panel-close", "view-close"]);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("acknowledged Emacs shell rollback cleans the exact view and preserves the original failure", async () => {
  const events: string[] = [];
  const { services } = panelServices(events);
  let id: unknown;
  const pi = fakeEmacs(data => {
    if (data.operation === "start") { id = data.id; events.push("native-start"); return { error: "native allocation failed" }; }
    assert.equal(data.operation, "close"); assert.equal(data.id, id); assert.equal(data.panelId, binding.id);
    events.push("view-close"); return { success: true };
  });
  await assert.rejects(createEmacsHost(pi, "/test/socket", runtime(), services).start(shell), error => {
    assert.match(String(error), /native allocation failed/);
    assert.equal(error instanceof PanelStartError, false, "known rollback is not uncertain cleanup");
    return true;
  });
  assert.deepEqual(events, ["create", "native-start", "rollback", "status", "view-close"]);
});

test("uncertain Emacs panel startup keeps its exact target, capture and both errors", async () => {
  const events: string[] = [];
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "emacs-retained-panel-"));
  const outputPath = path.join(directory, "output.log");
  fs.writeFileSync(outputPath, "recovery evidence");
  const { services } = panelServices(events, {
    create(options) { events.push("create"); assert.equal(options.outputPath, outputPath); return binding; },
    async rollback() { events.push("rollback"); throw new Error("wrapper rollback uncertain"); },
  });
  let nativeId: unknown;
  const pi = fakeEmacs(data => {
    assert.equal(data.operation, "start", "uncertain wrapper cleanup cannot dispose its view");
    nativeId = data.id;
    return { error: "original native startup failure" };
  });
  try {
    await assert.rejects(createEmacsHost(pi, "/test/socket", runtime(), services).start({ ...shell, outputPath }), error => {
      assert.ok(error instanceof PanelStartError);
      assert.match(error.message, /original native startup failure/);
      assert.match(error.message, /wrapper rollback uncertain/);
      assert.equal(error.target.id, nativeId);
      assert.equal(error.target.panel, binding);
      assert.equal(error.target.outputPath, outputPath);
      assert.equal(fs.readFileSync(outputPath, "utf8"), "recovery evidence");
      return true;
    });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("cancellation after Emacs allocation rolls back held work without activating it", async () => {
  const controller = new AbortController();
  const events: string[] = [];
  const { services } = panelServices(events, {
    async ready(received) { events.push("ready"); controller.abort(); return { ...received, process: identity }; },
  });
  const pi = fakeEmacs(data => {
    events.push(String(data.operation));
    return data.operation === "start" ? { target: { id: data.id } } : { success: true };
  });
  await assert.rejects(createEmacsHost(pi, "/test/socket", runtime(), services).start(shell, controller.signal), /abort/i);
  assert.deepEqual(events, ["create", "start", "ready", "rollback", "status", "close"]);
  events.length = 0;
  await assert.rejects(createEmacsHost(pi, "/test/socket", runtime(), services).start(shell, controller.signal), /abort/i);
  assert.deepEqual(events, [], "preaborted startup cannot allocate a wrapper or native view");
});

test("unknown shell ownership and uncertain wrapper close never reach a native alias", async () => {
  const events: string[] = [];
  const { services } = panelServices(events, { async close() { throw new Error("wrapper child cleanup uncertain"); } });
  const host = createEmacsHost(fakeEmacs(() => assert.fail("no native alias mutation is authorized")), "/test/socket", runtime(), services);
  const unowned: HostTarget = { host: "emacs", endpoint: "/test/socket", id: "reused", kind: "shell", name: "logs" };
  await assert.rejects(host.state(unowned), /exact persistent panel binding/);
  await assert.rejects(host.read(unowned), /exact persistent panel binding/);
  await assert.rejects(host.send(unowned, { kind: "text", text: "never send", enter: true }), /exact persistent panel binding/);
  await assert.rejects(host.close(unowned), /exact persistent panel binding/);
  await assert.rejects(host.close({ ...unowned, panel: binding }), /wrapper child cleanup uncertain/);
});
