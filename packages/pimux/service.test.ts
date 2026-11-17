import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { listDiscovery } from "./discovery.ts";
import { processIdentityStatus, readProcessIdentity, type ProcessIdentity } from "./process-identity.ts";
import { resolveRuntime, RuntimeOperationError, startRuntime, stopRuntime } from "./runtime.ts";
import { expectedStateId, probeService, resumeService, serviceRequest, serviceStatus, stopService } from "./service-client.ts";
import { BIN, connectPeer, PI, prepare, serviceReady, until } from "./test/harness.ts";

const SELF = readProcessIdentity(process.pid)!;
const HELD_INPUT = fileURLToPath(new URL("./test/held-input.ts", import.meta.url));
const BIND_MODE = fileURLToPath(new URL("./test/bind-mode.mjs", import.meta.url));

function sandbox(t: TestContext) {
  const input = prepare();
  const services: ChildProcess[] = [];
  t.after(async () => {
    for (const child of services) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await until(() => child.exitCode !== null || child.signalCode !== null, "owned service stopped");
    }
    await until(() => listDiscovery(input.env.PIMUX_DIR!).every(entry =>
      (!entry.ownerIdentity || processIdentityStatus(entry.ownerIdentity) === "dead") &&
      (!entry.piIdentity || processIdentityStatus(entry.piIdentity) === "dead")), "all owned writers exited");
    fs.rmSync(input.dir, { recursive: true, force: true });
  });
  /** A service that may refuse to start; `serve` waits for one that must become ready. */
  const spawnService = (env = input.env, executable = BIN): ChildProcess => {
    const child = spawn(process.execPath, [executable, "serve"], { cwd: input.dir, env, stdio: ["ignore", "pipe", "pipe"] });
    services.push(child); child.stdout!.resume(); child.stderr!.resume();
    return child;
  };
  const serve = async (env = input.env, executable = BIN): Promise<ChildProcess> => {
    const child = spawnService(env, executable);
    await serviceReady(child);
    return child;
  };
  const start = (extra: Partial<Parameters<typeof startRuntime>[0]> = {}) => startRuntime({ command: PI, args: input.piArgs, cwd: input.dir, env: input.env, ...extra });
  const own = (child: ChildProcess): ChildProcess => { services.push(child); return child; };
  return { ...input, serve, spawnService, start, own };
}

test("the service endpoint is private from the moment it is bound, whatever the caller's umask", { timeout: 20_000 }, async t => {
  const input = sandbox(t);
  const modes = path.join(input.dir, "bind-modes.jsonl");
  const env = { ...input.env, NODE_OPTIONS: `--import=${BIND_MODE}`, PIMUX_TEST_BIND_MODES: modes };
  // A permissive umask, as an ordinary login shell can have one.
  const service = input.own(spawn("/bin/sh", ["-c", 'umask 002 && exec "$0" "$@"', process.execPath, BIN, "serve"],
    { cwd: input.dir, env, stdio: ["ignore", "pipe", "pipe"] }));
  await serviceReady(service);
  const bound = fs.readFileSync(modes, "utf8").trim().split("\n").map(line => JSON.parse(line) as { path: string; mode: number })
    .filter(entry => path.basename(entry.path) === "service.sock");
  assert.equal(bound.length, 1, "the preload observed the service's bind");
  // A concurrent launcher's probe rejects a wider endpoint as unsafe instead of waiting.
  assert.equal(bound[0]!.mode & 0o077, 0, `bound with mode ${bound[0]!.mode.toString(8)}`);
  assert.equal(fs.lstatSync(path.join(input.env.PIMUX_DIR!, "service.sock")).mode & 0o777, 0o600);
  assert.equal((await probeService(input.env)).state, "answering");
});

for (const signal of ["SIGTERM", "SIGKILL"] as const) test(`${signal} service restart recreates roots idle, without replay or worker resurrection`, { timeout: 20_000 }, async t => {
  const input = sandbox(t);
  const service = await input.serve();
  const root = await input.start();
  const peer = await connectPeer(root);
  t.after(() => peer.socket.destroy());
  peer.send({ type: "prompt", message: "tool" });
  const tool = await until(() => {
    const file = path.join(input.dir, "tool.pid");
    return fs.existsSync(file) && readProcessIdentity(Number(fs.readFileSync(file, "utf8")));
  }, "faux tool running");
  const pi = readProcessIdentity(root.piPid)!;
  const workerFile = path.join(input.isolation.sessions, "worker.jsonl");
  const args = [...input.piArgs]; args[args.indexOf("--session") + 1] = workerFile;
  const worker = await input.start({ args, env: { ...input.env, PI_ORCHESTRATION_PLACEMENT: "worker" },
    parent: { process: pi, taskId: "service-restart-test" } });
  const workerPi = readProcessIdentity(worker.piPid)!;
  const oldOwner = readProcessIdentity(root.pid)!;
  service.kill(signal);
  await until(() => service.exitCode !== null || service.signalCode !== null, "old service exited");
  await input.serve();
  const replacement = await resolveRuntime(root.muxId, input.env);
  assert.ok(replacement);
  assert.notEqual(replacement.muxId, root.muxId);
  assert.notEqual(replacement.piPid, root.piPid);
  assert.equal(replacement.sessionFile, root.sessionFile);
  assert.equal(processIdentityStatus(oldOwner), "dead");
  assert.equal(processIdentityStatus(pi), "dead");
  assert.equal(processIdentityStatus(workerPi), "dead");
  assert.equal(processIdentityStatus(tool), "dead");
  assert.equal(await resolveRuntime(worker.muxId, input.env), null);
  const recovered = await connectPeer(replacement);
  t.after(() => recovered.socket.destroy());
  const state = await recovered.request({ type: "get_state" });
  assert.equal((state.data as { isStreaming: boolean }).isStreaming, false);
  assert.equal(recovered.records.some(record => record.type === "tool_execution_start"), false);
  // Old identity-bound Close cannot stop a new process serving the same history.
  await stopRuntime(root.muxId, { env: input.env });
  assert.equal(processIdentityStatus(readProcessIdentity(replacement.piPid)!), "alive");
  await recovered.run("fresh explicit prompt");
});

test("restored root reloads extensions without submitting a prompt", { timeout: 20_000 }, async t => {
  const input = sandbox(t);
  const versionFile = path.join(input.dir, "extension-version");
  fs.writeFileSync(versionFile, "before");
  const service = await input.serve();
  const root = await input.start({ args: [...input.piArgs, "-e", fileURLToPath(new URL("./test/service-version.ts", import.meta.url))] });
  const peer = await connectPeer(root);
  t.after(() => peer.socket.destroy());
  assert.ok(peer.records.some(record => record.method === "setStatus" && record.statusKey === "service-version" && record.statusText === "before"));
  assert.equal((await peer.request({ type: "set_model", provider: "fx", modelId: "two" })).success, true);
  assert.equal((await peer.request({ type: "set_thinking_level", level: "high" })).success, true);
  fs.writeFileSync(versionFile, "after");
  service.kill("SIGTERM");
  await until(() => service.exitCode !== null || service.signalCode !== null, "old service stopped");
  fs.rmSync(input.env.PIMUX_DIR!, { recursive: true, force: true });
  assert.ok(fs.existsSync(path.join(input.dir, "pimux-state", "roots.json")), "root intent survives ephemeral socket loss");
  await input.serve();
  const replacement = await resolveRuntime(root.muxId, input.env);
  assert.ok(replacement);
  const current = await connectPeer(replacement);
  t.after(() => current.socket.destroy());
  assert.ok(current.records.some(record => record.method === "setStatus" && record.statusKey === "service-version" && record.statusText === "after"));
  const state = await current.request({ type: "get_state" });
  assert.equal((state.data as { model: { id: string } }).model.id, "two");
  assert.equal((state.data as { thinkingLevel: string }).thinkingLevel, "high");
  const messages = await current.request({ type: "get_messages" });
  assert.deepEqual((messages.data as { messages: unknown[] }).messages, []);
});

test("explicit Close removes root restoration intent before a service restart", { timeout: 20_000 }, async t => {
  const input = sandbox(t);
  const first = await input.serve();
  const root = await input.start();
  await stopRuntime(root.muxId, { env: input.env });
  first.kill("SIGTERM");
  await until(() => first.exitCode !== null || first.signalCode !== null, "first service stopped");
  await input.serve();
  assert.equal(await resolveRuntime(root.muxId, input.env), null);
  assert.deepEqual(listDiscovery(input.env.PIMUX_DIR!), []);
});

test("service absence has a bounded actionable error and never starts a daemon", { timeout: 2000 }, async t => {
  const input = sandbox(t);
  await assert.rejects(serviceRequest({ type: "resolve", muxId: "missing" }, { env: input.env, availabilityMs: 25 }), /pimux unavailable; start it with `phimacs` or its supervisor/);
  assert.equal(fs.existsSync(path.join(input.env.PIMUX_DIR!, ".service.json")), false);
});

test("service errors retain the actual existing operation identity for reconciliation", { timeout: 2000 }, async t => {
  const input = sandbox(t);
  const operationId = "11111111-1111-4111-8111-111111111111";
  const muxId = "22222222-2222-4222-8222-222222222222";
  fs.mkdirSync(input.env.PIMUX_DIR!, { recursive: true, mode: 0o700 });
  const file = path.join(input.env.PIMUX_DIR!, "service.sock");
  const server = net.createServer(socket => {
    socket.write(JSON.stringify({ type: "pimux_service", protocol: 1, ready: true }) + "\n");
    socket.once("data", () => socket.end(JSON.stringify({ type: "service_response", success: false,
      error: "Existing operation is uncertain", operationId, muxId }) + "\n"));
  });
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  await new Promise<void>(resolve => server.listen(file, resolve));
  fs.chmodSync(file, 0o600);
  await assert.rejects(input.start(), error => error instanceof RuntimeOperationError
    && error.operationId === operationId && error.muxId === muxId);
});

test("`phimacs service pimux` keeps the supervised service PID and binds it to the checkout", { timeout: 20_000 }, async t => {
  const input = sandbox(t);
  const state = path.join(input.dir, "state");
  const env = { ...input.env, PHIMACS_PI: PI, PHIMACS_STATE_DIR: state, TMUX: "/foreign/tmux,1,0" };
  const service = input.own(spawn(fileURLToPath(new URL("../../bin/phimacs", import.meta.url)), ["service", "pimux"],
    { cwd: input.dir, env, stdio: ["ignore", "pipe", "pipe"] }));
  service.stderr!.resume();
  await serviceReady(service);
  const root = await input.start();
  assert.equal(root.service?.pid, service.pid);
  assert.equal((await resolveRuntime(root.muxId, input.env))?.service?.pid, service.pid);
  const status = await serviceStatus(input.env);
  assert.equal(status.root, fs.realpathSync(fileURLToPath(new URL("../..", import.meta.url))));
  const environment = fs.readFileSync(`/proc/${service.pid}/environ`, "utf8").split("\0");
  assert.ok(environment.includes(`PHIMACS_STATE_DIR=${state}`));
  assert.equal(environment.some(entry => entry.startsWith("TMUX=")), false, "the terminal's identity is not inherited");
});

test("stop drains atomically: busy and unrestorable agents refuse, and a forced stop keeps idle roots journaled", { timeout: 20_000 }, async t => {
  const input = sandbox(t);
  const service = await input.serve();
  const root = await input.start();
  const peer = await connectPeer(root);
  t.after(() => peer.socket.destroy());
  peer.send({ type: "prompt", message: "tool" });
  await until(() => fs.existsSync(path.join(input.dir, "tool.pid")), "faux tool running");
  await until(() => listDiscovery(input.env.PIMUX_DIR!).find(entry => entry.muxId === root.muxId)?.status === "working", "published working status");
  const pi = readProcessIdentity(root.piPid)!;
  const identity = (await serviceStatus(input.env)).process;
  const operation = (operationId: string, force: boolean, phase: "drain" | "commit", exit = false) =>
    stopService({ service: identity, operationId, caller: SELF, force, phase, exit, env: input.env });
  await assert.rejects(operation("busy", false, "drain"), new RegExp(`stop refused: root ${root.muxId} is working`));
  const workerFile = path.join(input.isolation.sessions, "worker.jsonl");
  const args = [...input.piArgs]; args[args.indexOf("--session") + 1] = workerFile;
  const worker = await input.start({ args, env: { ...input.env, PI_ORCHESTRATION_PLACEMENT: "worker" },
    parent: { process: pi, taskId: "service-stop-test" } });
  await assert.rejects(operation("worker", false, "drain"), new RegExp(`worker ${worker.muxId} is not restored after a stop`));
  const before = await serviceStatus(input.env);
  assert.deepEqual([before.stopping, before.stop], [false, null], "a refused stop leaves the service accepting agents");
  assert.deepEqual(before.agents.map(agent => [agent.muxId, agent.placement, agent.status]).sort(),
    [[root.muxId, "root", "working"], [worker.muxId, "worker", "idle"]].sort());
  await assert.rejects(operation("undrained", true, "commit", true), /pimux stop undrained was not drained; nothing was committed/);
  assert.deepEqual((await operation("forced", true, "drain")).stop, { operationId: "forced", committed: false, caller: SELF });
  assert.deepEqual((await operation("forced", true, "commit", true)).stop, { operationId: "forced", committed: true, caller: SELF });
  assert.equal(await new Promise(resolve => service.once("exit", resolve)), 0);
  assert.equal(processIdentityStatus(pi), "dead", "the forced stop interrupted the busy root");
  await input.serve();
  const restored = await serviceStatus(input.env, 10_000);
  assert.deepEqual(restored.roots.map(item => [item.sessionFile, item.error]), [[root.sessionFile, null]]);
  assert.deepEqual(restored.agents.map(agent => [agent.placement, agent.status]), [["root", "idle"]]);
});

test("an unforced drain closes agent input before its idle check, and only its own resume reopens it", { timeout: 20_000 }, async t => {
  const input = sandbox(t);
  await input.serve();
  const root = await input.start();
  const peer = await connectPeer(root);
  t.after(() => peer.socket.destroy());
  const status = await serviceStatus(input.env);
  const service = status.process;
  assert.equal(status.stateId, expectedStateId(input.env), "the service journals in this environment's state directory");
  const drain = (operationId: string, identity = service, caller = SELF) =>
    stopService({ service: identity, operationId, caller, force: false, phase: "drain", exit: false, env: input.env });
  await assert.rejects(drain("foreign", { ...service, startTime: "1" }), /bound to another pimux service process; nothing was changed/);
  assert.deepEqual((await drain("first")).stop, { operationId: "first", committed: false, caller: SELF });
  assert.deepEqual((await drain("first")).stop, { operationId: "first", committed: false, caller: SELF }, "a repeated drain reconciles, not repeats");
  await assert.rejects(drain("first", service, { ...SELF, startTime: "1" }), /pimux stop first belongs to another caller; nothing was changed/);
  const refused = await peer.request({ type: "prompt", message: "after the gate" });
  assert.equal(refused.success, false);
  assert.match(String(refused.error), /^pimux service stopping; input was not forwarded/);
  assert.equal((await peer.request({ type: "abort" })).success, true, "existing work can still be aborted");
  await assert.rejects(drain("second"), new RegExp(`pimux stop first by live process ${SELF.pid} is already in progress`));
  assert.equal((await resumeService({ service, operationId: "second", caller: SELF, env: input.env })).resumed, false);
  await assert.rejects(input.start(), /pimux service stopping; no agent was started/);
  const probe = await probeService(input.env);
  assert.ok(probe.state === "answering");
  assert.deepEqual([probe.greeting.stopping, probe.greeting.stateId, probe.greeting.process], [true, status.stateId, service]);
  const resumed = await resumeService({ service, operationId: "first", caller: SELF, env: input.env });
  assert.deepEqual([resumed.resumed, resumed.stopping, resumed.stop], [true, false, null]);
  await peer.run("after the resume");
  assert.ok(await input.start());
});

test("a disconnected frontend's prompt held in an input hook keeps an unforced drain from committing", { timeout: 20_000 }, async t => {
  const input = sandbox(t);
  await input.serve();
  const held = path.join(input.dir, "held");
  fs.mkdirSync(held);
  const root = await input.start({ args: [...input.piArgs, "-e", HELD_INPUT], env: { ...input.env, PIMUX_HELD_INPUT_DIR: held } });
  const peer = await connectPeer(root);
  peer.send({ type: "prompt", message: "held" });
  await until(() => fs.existsSync(path.join(held, "holding")), "prompt held in its async input hook");
  const closed = new Promise(resolve => peer.socket.once("close", resolve));
  peer.socket.destroy();
  await closed;
  const service = (await serviceStatus(input.env)).process;
  const stop = (phase: "drain" | "commit") =>
    stopService({ service, operationId: "held", caller: SELF, force: false, phase, exit: true, env: input.env });
  await assert.rejects(stop("drain"), new RegExp(`stop refused: root ${root.muxId} did not settle idle behind the input gate`),
    "an accepted prompt without its frontend still counts as work Pi may start");
  await assert.rejects(stop("commit"), /pimux stop held was not drained; nothing was committed/);
  const observer = await connectPeer(root);
  t.after(() => observer.socket.destroy());
  const start = observer.mark();
  fs.writeFileSync(path.join(held, "release"), "");
  await observer.waitFor(record => record.type === "agent_settled", "the held prompt runs once released", start);
  assert.equal((await serviceStatus(input.env)).stopping, false);
});

test("an operation whose caller is proven dead is recoverable by a later stop or resume; a live caller's is not", { timeout: 20_000 }, async t => {
  const input = sandbox(t);
  await input.serve();
  const root = await input.start();
  const peer = await connectPeer(root);
  t.after(() => peer.socket.destroy());
  const service = (await serviceStatus(input.env)).process;
  const callers: ReturnType<typeof spawn>[] = [];
  t.after(() => { for (const caller of callers) caller.kill("SIGKILL"); });
  const caller = async (): Promise<{ identity: ProcessIdentity; die(): Promise<void> }> => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    callers.push(child);
    await new Promise(resolve => child.once("spawn", resolve));
    const identity = readProcessIdentity(child.pid!)!;
    return { identity, async die() { child.kill("SIGKILL"); await until(() => processIdentityStatus(identity) === "dead", "caller died"); } };
  };
  const drain = (operationId: string, by: ProcessIdentity) =>
    stopService({ service, operationId, caller: by, force: false, phase: "drain", exit: false, env: input.env });
  const prompt = async (): Promise<unknown> => (await peer.request({ type: "prompt", message: "gate probe" })).error;
  const first = await caller();
  await drain("abandoned", first.identity);
  await assert.rejects(drain("successor", SELF), new RegExp(`pimux stop abandoned by live process ${first.identity.pid} is already in progress`));
  assert.equal((await resumeService({ service, operationId: "successor", caller: SELF, env: input.env })).resumed, false,
    "a live caller's operation is never taken over");
  assert.match(String(await prompt()), /^pimux service stopping/);
  await first.die();
  const recovered = await drain("successor", SELF);
  assert.deepEqual(recovered.stop, { operationId: "successor", committed: false, caller: SELF }, "the dead caller's drain was undone, then this one drained");
  assert.match(String(await prompt()), /^pimux service stopping/, "the successor's gate is closed, not the abandoned one's");
  assert.equal((await resumeService({ service, operationId: "successor", caller: SELF, env: input.env })).resumed, true);
  await peer.run("after the successor resumed");
  const second = await caller();
  await drain("abandoned-again", second.identity);
  await second.die();
  const resumed = await resumeService({ service, operationId: "anyone", caller: SELF, env: input.env });
  assert.deepEqual([resumed.resumed, resumed.stopping, resumed.stop], [true, false, null]);
  await peer.run("after recovering the abandoned drain");
});

test("status reports a root whose restoration failed instead of hiding it behind readiness", { timeout: 20_000 }, async t => {
  const input = sandbox(t);
  const first = await input.serve();
  const root = await input.start();
  first.kill("SIGTERM");
  await until(() => first.exitCode !== null || first.signalCode !== null, "first service stopped");
  const journal = path.join(input.dir, "pimux-state", "roots.json");
  const roots = JSON.parse(fs.readFileSync(journal, "utf8")) as { command: string }[];
  roots[0]!.command = path.join(input.dir, "missing-pi");
  fs.writeFileSync(journal, JSON.stringify(roots), { mode: 0o600 });
  await input.serve();
  const status = await serviceStatus(input.env, 10_000);
  assert.equal(status.roots.length, 1);
  assert.equal(status.roots[0]!.sessionFile, root.sessionFile);
  assert.match(status.roots[0]!.error ?? "", /^Root restoration failed: /);
  assert.deepEqual(status.agents, []);
});

test("a second service refuses without disturbing the current owner", { timeout: 20_000 }, async t => {
  const input = sandbox(t);
  await input.serve();
  const root = await input.start();
  const duplicate = input.spawnService();
  const code = await new Promise<number | null>(resolve => duplicate.once("exit", resolve));
  assert.equal(code, 1);
  assert.equal((await resolveRuntime(root.muxId, input.env))?.muxId, root.muxId);
  const other = prepare();
  t.after(() => fs.rmSync(other.dir, { recursive: true, force: true }));
  const alternate = input.spawnService({ ...other.env, PIMUX_DIR: input.env.PIMUX_DIR });
  assert.equal(await new Promise<number | null>(resolve => alternate.once("exit", resolve)), 1);
  assert.equal((await resolveRuntime(root.muxId, input.env))?.muxId, root.muxId);
});
