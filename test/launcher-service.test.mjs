// The launcher's start-or-attach and stop of a real pimux service in a disposable namespace.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { listDiscovery } from "../packages/pimux/discovery.ts";
import { processIdentityStatus, readProcessIdentity } from "../packages/pimux/process-identity.ts";
import { startRuntime } from "../packages/pimux/runtime.ts";
import { connectPeer, PI, prepare, until } from "../packages/pimux/test/harness.ts";
import { parseOptions } from "../scripts/emacs-environment.mjs";
import { probe } from "../scripts/emacs-launch.mjs";
import { selectedEmacs } from "../scripts/emacs-packages.mjs";
import { runtimePaths } from "../scripts/runtime.mjs";
import { describeService, ensureService, stopAll } from "../scripts/service.mjs";
import { resumeService, serviceStatus, stopService } from "@phimacs/pimux/service-client";

const PIMUX = path.resolve(import.meta.dirname, "../packages/pimux/bin/pimux");

async function eventually(check, description, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    assert.ok(Date.now() < deadline, `Timed out: ${description}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

/**
 * Why the selected Emacs cannot serve clients as a daemon without a usable display,
 * proven by a bare `emacs -Q --fg-daemon` in a private directory. Some PGTK builds
 * start such a daemon but fail every client evaluation. Undefined when it answers,
 * or when the probe fails another way: the real-daemon tests then report that.
 */
async function displaylessDaemonLimitation(emacs) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "phimacs-daemon-probe-"));
  const socket = path.join(directory, "probe");
  const env = { PATH: emacs.path, HOME: directory, LANG: "C.UTF-8" };
  // `emacs-startup-hook` runs after the daemon's server starts; the startup echo
  // message ("Starting Emacs daemon.") precedes it.
  const ready = "phimacs-probe: server started";
  const daemon = spawn(emacs.emacs, ["-Q", `--fg-daemon=${socket}`, "--eval",
    `(add-hook 'emacs-startup-hook (lambda () (message ${JSON.stringify(ready)})))`], { env, stdio: ["ignore", "ignore", "pipe"] });
  const exited = new Promise(resolve => daemon.once("exit", resolve));
  try {
    const started = await new Promise(resolve => {
      let output = "";
      const timer = setTimeout(() => resolve(false), 15_000);
      daemon.stderr.on("data", chunk => {
        output += chunk;
        if (output.includes(ready)) { clearTimeout(timer); resolve(true); }
      });
      exited.then(() => { clearTimeout(timer); resolve(false); });
    });
    if (!started) return undefined;
    const answer = spawnSync(emacs.client, ["--alternate-editor=false", "--socket-name", socket, "--eval", "t"],
      { encoding: "utf8", env, timeout: 10_000 });
    if (answer.status === 0) return undefined;
    const proof = /Frames are not in use or not initialized/.exec(answer.stderr);
    return proof && `${emacs.emacs} cannot serve clients as a daemon without a usable display: a bare -Q daemon answers "${proof[0]}"`;
  } finally {
    daemon.kill("SIGKILL");
    await exited;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/** Skip reason for the real-daemon tests, or false when they run. */
const realDaemon = process.env.PHIMACS_TEST_EMACS_DIR
  ? await displaylessDaemonLimitation(selectedEmacs(process.env)) ?? false
  : "Set PHIMACS_TEST_EMACS_DIR to prepared disposable Emacs inputs";

/** Run the launcher without blocking the test process, so two can race. */
const launch = (args, env) => new Promise(resolve => {
  const child = spawn(path.resolve(import.meta.dirname, "../bin/phimacs"), args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdout.resume();
  child.once("exit", status => resolve({ status, stderr }));
});

function sandbox(t) {
  const input = prepare();
  const env = { ...input.env, PHIMACS_PI: PI, TMUX: "/foreign/tmux,1,0", PI_ORCHESTRATION_TARGET: "foreign" };
  const state = path.join(input.dir, "state");
  fs.mkdirSync(state, { mode: 0o700 });
  const runtime = runtimePaths(undefined, env);
  const lease = () => {
    const file = path.join(input.dir, "pimux-state", "service.json");
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).process : undefined;
  };
  const children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    const owner = lease();
    if (owner && processIdentityStatus(owner) === "alive") process.kill(owner.pid, "SIGTERM");
    if (owner) await until(() => processIdentityStatus(owner) === "dead", "launcher-started service stopped");
    await until(() => listDiscovery(env.PIMUX_DIR).every(entry =>
      (!entry.ownerIdentity || processIdentityStatus(entry.ownerIdentity) === "dead")
      && (!entry.piIdentity || processIdentityStatus(entry.piIdentity) === "dead")), "all owned writers exited");
    fs.rmSync(input.dir, { recursive: true, force: true });
  });
  const ensure = (options = {}) => ensureService({ runtime, state, env, timeoutMs: 15_000, ...options });
  const stop = options => stopAll({ env, root: runtime.root, ...options });
  const start = () => startRuntime({ command: PI, args: input.piArgs, cwd: input.dir, env });
  return { input, env, state, runtime, lease, children, ensure, start, stop };
}

test("one detached service starts, a concurrent launcher waits for it and later launches attach", { timeout: 20_000 }, async t => {
  const box = sandbox(t);
  const outcomes = (await Promise.all([box.ensure(), box.ensure()])).map(result => result.outcome).sort();
  assert.deepEqual(outcomes, ["attached", "started"]);
  const owner = box.lease();
  assert.equal(processIdentityStatus(owner), "alive");
  assert.equal((await box.ensure()).outcome, "attached");
  assert.equal(box.lease().pid, owner.pid, "attaching never replaces the service");
  const environment = fs.readFileSync(`/proc/${owner.pid}/environ`, "utf8").split("\0");
  assert.ok(environment.includes(`PHIMACS_ROOT=${box.runtime.root}`));
  assert.ok(environment.includes(`PHIMACS_STATE_DIR=${box.state}`));
  for (const name of ["TMUX", "PI_ORCHESTRATION_TARGET"]) {
    assert.equal(environment.some(entry => entry.startsWith(`${name}=`)), false, `${name} is not inherited by the detached service`);
  }
  assert.match(fs.readFileSync(path.join(box.state, "pimux.log"), "utf8"), /pimux service ready/);
  assert.equal((await describeService(box.env)).state, "ready");
});

test("a launcher whose own service lost the race waits for it to exit before attaching", { timeout: 20_000 }, async t => {
  const box = sandbox(t);
  // The losing launcher's service is held before it can contend for the lease.
  let gate;
  let held;
  const spawnHeld = (command, args, options) => {
    held = spawn("/bin/sh", ["-c", 'read release <&3 && exec "$0" "$@"', command, ...args], { ...options, stdio: [...options.stdio, "pipe"] });
    gate = held.stdio[3];
    box.children.push(held);
    return held;
  };
  let paused = () => {};
  const loser = box.ensure({ spawnProcess: spawnHeld, pause: async ms => { paused(); await new Promise(resolve => setTimeout(resolve, ms)); } });
  await until(() => gate, "the losing launcher spawned its service");
  assert.equal((await box.ensure()).outcome, "started");
  // The loser's second poll after readiness follows a probe that saw the ready winner.
  const waited = await Promise.race([loser.then(() => false), new Promise(resolve => {
    let polls = 0;
    paused = () => { if (++polls === 2) resolve(true); };
  })]);
  assert.equal(waited, true, "the launcher attached while its own service could still start later");
  gate.end("release\n");
  assert.equal((await loser).outcome, "attached");
  assert.notEqual(held.exitCode ?? held.signalCode, null, "its own service exited, refused by the winner's lease");
  assert.equal(processIdentityStatus(box.lease()), "alive");
});

test("an endpoint without an owner record or answer, or a rootless, foreign or other-state service is refused and kept", { timeout: 20_000 }, async t => {
  const box = sandbox(t);
  const socket = path.join(box.env.PIMUX_DIR, "service.sock");
  fs.mkdirSync(box.env.PIMUX_DIR, { mode: 0o700 });
  // A listener killed without cleanup leaves a refusing socket and no owner record.
  const holder = spawn(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(socket)}, () => console.log("up"))`],
    { stdio: ["ignore", "pipe", "ignore"] });
  box.children.push(holder);
  await new Promise(resolve => holder.stdout.once("data", resolve));
  fs.chmodSync(socket, 0o600);
  holder.kill("SIGKILL");
  await new Promise(resolve => holder.once("exit", resolve));
  await assert.rejects(box.ensure(), /refuses connections and has no owner record\. It is never replaced or removed automatically/);
  assert.ok(fs.lstatSync(socket).isSocket(), "the refused endpoint is kept");
  fs.rmSync(socket);
  // This state directory's durable identity, so that only the process identity can differ.
  const stateDirectory = path.join(box.input.dir, "pimux-state");
  fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(stateDirectory, "identity.json"), JSON.stringify({ id: "this-state" }), { mode: 0o600 });
  const exited = spawn(process.execPath, ["-e", ""]);
  await new Promise(resolve => exited.once("spawn", resolve));
  const gone = readProcessIdentity(exited.pid) ?? { pid: exited.pid, startTime: "1", bootId: "boot" };
  await new Promise(resolve => exited.once("exit", resolve));
  const greet = fields => ({ type: "pimux_service", protocol: 1, ready: true, root: box.runtime.root, stateId: "this-state",
    process: readProcessIdentity(process.pid), ...fields });
  for (const [greeting, expected] of [[undefined, /accepts connections but does not answer/],
    [greet({ root: "/elsewhere" }), /runs from \/elsewhere, not /],
    [greet({ root: null }), /was not started from a Phimacs checkout/],
    [greet({ stateId: "other-state" }), /keeps its journal in another state directory than this PHIMACS_STATE_DIR/],
    [greet({ process: {} }), /does not report a valid process identity/],
    [greet({ process: gone }), new RegExp(`reports process ${gone.pid}, which is not running`)],
    [greet({}), new RegExp(`reports process ${process.pid}, which does not hold this state's service leases`)]]) {
    const server = net.createServer(peer => { if (greeting) peer.write(`${JSON.stringify(greeting)}\n`); });
    await new Promise(resolve => server.listen(socket, resolve));
    fs.chmodSync(socket, 0o600);
    try { await assert.rejects(box.ensure(), expected); }
    finally { await new Promise(resolve => server.close(() => resolve())); }
  }
  assert.equal(box.lease(), undefined, "no service was started");
});

test("a supervised service starts through its supervisor once and stops through it", { timeout: 20_000 }, async t => {
  const box = sandbox(t);
  const calls = path.join(box.input.dir, "supervisor-calls");
  const supervisor = path.join(box.input.dir, "supervisor");
  // A minimal supervisor: start runs the service detached, stop terminates it and waits.
  fs.writeFileSync(supervisor, `#!/usr/bin/env node
const fs = require("node:fs"); const { spawn } = require("node:child_process");
fs.appendFileSync(${JSON.stringify(calls)}, process.argv[2] + "\\n");
const pidFile = ${JSON.stringify(path.join(box.input.dir, "supervised.pid"))};
if (process.argv[2] === "fail") process.exit(3);
if (process.argv[2] === "start") {
  const child = spawn(process.execPath, [${JSON.stringify(PIMUX)}, "serve"], { detached: true, stdio: "ignore",
    env: ${JSON.stringify({ ...box.env, PHIMACS_ROOT: box.runtime.root })} });
  fs.writeFileSync(pidFile, String(child.pid)); child.unref();
} else {
  const pid = Number(fs.readFileSync(pidFile, "utf8")); process.kill(pid, "SIGTERM");
  const wait = () => { try { process.kill(pid, 0); setTimeout(wait, 20); } catch { process.exit(0); } }; wait();
}
`, { mode: 0o700 });
  await assert.rejects(box.ensure({ supervisor: { command: supervisor, start: ["fail"], stop: ["stop"] } }),
    /supervisor start failed .*no unmanaged service was started/s);
  assert.equal(box.lease(), undefined);
  const configured = { supervisor: { command: supervisor, start: ["start"], stop: ["stop"] } };
  assert.equal((await box.ensure(configured)).outcome, "supervisor-started");
  assert.equal((await box.ensure(configured)).outcome, "attached", "a responsive service is never restarted");
  const owner = box.lease();
  let frontends = 0;
  const result = await box.stop({ force: false, stopFrontends: async () => { frontends++; }, ...configured });
  assert.deepEqual(result, { service: "stopped", roots: 0 });
  assert.equal(frontends, 1);
  assert.equal(processIdentityStatus(owner), "dead");
  assert.deepEqual(fs.readFileSync(calls, "utf8").trim().split("\n"), ["fail", "start", "stop"]);
});

test("stop refuses a busy agent before touching frontends; a failed frontend stop resumes the service; --force stops", { timeout: 20_000 }, async t => {
  const box = sandbox(t);
  await box.ensure();
  const root = await box.start();
  const peer = await connectPeer(root);
  t.after(() => peer.socket.destroy());
  peer.send({ type: "prompt", message: "tool" });
  await until(() => fs.existsSync(path.join(box.input.dir, "tool.pid")), "faux tool running");
  let frontends = 0;
  await assert.rejects(box.stop({ force: false, stopFrontends: async () => { frontends++; } }),
    new RegExp(`stop refused: root ${root.muxId} is working.*; pimux was not changed`));
  assert.equal(frontends, 0, "frontends are untouched by a refused stop");
  await assert.rejects(box.stop({ force: true, checkFrontends: async () => { throw new Error("Unsaved changes in /draft"); },
    stopFrontends: async () => { frontends++; } }), /^Error: Unsaved changes in \/draft$/);
  assert.equal((await serviceStatus(box.env)).stopping, false, "a frontend refusal precedes any drain");
  await assert.rejects(box.stop({ force: true, stopFrontends: async () => { throw new Error("Emacs refused to stop"); } }),
    /Emacs refused to stop; pimux was resumed and accepts agents again/);
  assert.equal((await describeService(box.env)).state, "ready");
  const owner = box.lease();
  const pi = readProcessIdentity(root.piPid);
  assert.deepEqual(await box.stop({ force: true, stopFrontends: async () => { frontends++; } }), { service: "stopped", roots: 1 });
  assert.equal(frontends, 1);
  assert.equal(processIdentityStatus(owner), "dead");
  assert.equal(processIdentityStatus(pi), "dead");
  assert.equal((await box.ensure()).outcome, "started");
  const restored = await describeService(box.env);
  assert.deepEqual([restored.roots.length, restored.counts], [1, { idle: 1 }], "the root is restored idle, without replay");
});

test("stop gates agent input while frontends stop, and resumes a drain whose reply was lost", { timeout: 20_000 }, async t => {
  const box = sandbox(t);
  await box.ensure();
  const root = await box.start();
  const peer = await connectPeer(root);
  t.after(() => peer.socket.destroy());
  const lost = { stop: async operation => { await stopService(operation); throw new Error("Service disconnected; outcome uncertain"); },
    resume: resumeService };
  await assert.rejects(box.stop({ force: false, stopFrontends: async () => assert.fail("a failed drain stops no frontend"), request: lost }),
    /Service disconnected; outcome uncertain; pimux was resumed and accepts agents again/);
  const resumed = await serviceStatus(box.env);
  assert.deepEqual([resumed.stopping, resumed.stop], [false, null]);
  await peer.run("accepted after the resume");
  let during;
  const result = await box.stop({ force: false, stopFrontends: async () => {
    during = await peer.request({ type: "prompt", message: "while frontends stop" });
  } });
  assert.equal(during.success, false);
  assert.match(String(during.error), /^pimux service stopping; input was not forwarded/);
  assert.deepEqual(result, { service: "stopped", roots: 1 });
});

test("attaching recovers a stop whose caller has died, never a live caller's", { timeout: 20_000 }, async t => {
  const box = sandbox(t);
  await box.ensure();
  const service = (await serviceStatus(box.env)).process;
  const interrupted = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  box.children.push(interrupted);
  await new Promise(resolve => interrupted.once("spawn", resolve));
  const caller = readProcessIdentity(interrupted.pid);
  await stopService({ service, operationId: "interrupted", caller, force: false, phase: "drain", exit: false, env: box.env });
  await assert.rejects(box.ensure(), new RegExp(`is stopping \\(by running process ${interrupted.pid}\\); wait for`));
  assert.equal((await serviceStatus(box.env)).stop?.operationId, "interrupted", "a live caller's stop is untouched");
  interrupted.kill("SIGKILL");
  await until(() => processIdentityStatus(caller) === "dead", "interrupted caller died");
  assert.equal((await box.ensure()).outcome, "attached");
  const recovered = await serviceStatus(box.env);
  assert.deepEqual([recovered.stopping, recovered.stop], [false, null]);
  assert.ok(await box.start(), "agents start again after recovery");
});

test("stop refuses a service this checkout and state did not start", { timeout: 20_000 }, async t => {
  const box = sandbox(t);
  const rootless = spawn(process.execPath, [PIMUX, "serve"], { env: box.env, stdio: "ignore" });
  box.children.push(rootless);
  await eventually(async () => (await describeService(box.env)).state === "ready", "rootless service ready");
  let frontends = 0;
  await assert.rejects(box.stop({ force: true, stopFrontends: async () => { frontends++; } }),
    /was not started from a Phimacs checkout; this checkout does not stop it/);
  assert.equal(frontends, 0);
  assert.equal((await serviceStatus(box.env)).stopping, false);
  assert.equal(rootless.exitCode, null);
});

test("a failed Emacs preflight starts nothing; a later Emacs failure names the pimux it left running", { timeout: 20_000 }, async t => {
  const box = sandbox(t);
  const emacs = selectedEmacs(process.env);
  const env = { ...box.env, PATH: `${path.dirname(process.execPath)}:${emacs.path}`, PHIMACS_EMACS: emacs.emacs,
    PHIMACS_EMACSCLIENT: emacs.client, PHIMACS_USER_FILE: path.join(box.input.dir, "user.el") };
  const launcher = path.resolve(import.meta.dirname, "../bin/phimacs");
  const missing = spawnSync(launcher, ["--no-frame"], { encoding: "utf8", env, timeout: 15_000 });
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stderr, /Setup is incomplete \(missing Emacs packages.*\); run phimacs setup/);
  assert.equal(box.lease(), undefined, "no pimux was started");
  assert.equal(fs.existsSync(path.join(box.env.PIMUX_DIR, "service.sock")), false);
  for (const file of ["elpa/dash/dash.el", "ghostel/ghostel-module.so", "tree-sitter/libtree-sitter-markdown.so",
    "tree-sitter/libtree-sitter-markdown-inline.so"]) {
    fs.mkdirSync(path.dirname(path.join(box.state, "emacs", file)), { recursive: true });
    fs.writeFileSync(path.join(box.state, "emacs", file), "");
  }
  const failing = path.join(box.input.dir, "failing-emacs");
  fs.writeFileSync(failing, `#!/bin/sh\ncase " $* " in *" --batch "*) exec ${JSON.stringify(emacs.emacs)} "$@" ;; esac\necho "synthetic daemon failure" >&2\nexit 3\n`, { mode: 0o755 });
  const late = spawnSync(launcher, ["--no-frame"], { encoding: "utf8", env: { ...env, PHIMACS_EMACS: failing }, timeout: 15_000 });
  assert.equal(late.status, 1, late.stderr);
  const owner = box.lease();
  assert.match(late.stderr, new RegExp(`Emacs exited before[^]*The pimux service this command started is still running \\(pid ${owner.pid}\\); \`phimacs stop\` stops it`));
  assert.equal(processIdentityStatus(owner), "alive");
});

test("concurrent `phimacs` launches start one pimux and one Emacs; stop keeps unsaved edits; `phimacs stop` ends both", {
  skip: realDaemon,
  timeout: 20_000,
}, async t => {
  const box = sandbox(t);
  const emacs = selectedEmacs(process.env);
  fs.cpSync(process.env.PHIMACS_TEST_EMACS_DIR, path.join(box.state, "emacs"), { recursive: true });
  const env = { ...box.env, PATH: `${path.dirname(process.execPath)}:${emacs.path}`, PHIMACS_STATE_DIR: box.state,
    PHIMACS_EMACS: emacs.emacs, PHIMACS_EMACSCLIENT: emacs.client, PHIMACS_USER_FILE: path.join(box.input.dir, "user.el"),
    PHIMACS_SHARE_DIR: path.join(box.input.dir, "share") };
  const launcher = path.resolve(import.meta.dirname, "../bin/phimacs");
  const phimacs = (...args) => spawnSync(launcher, args, { encoding: "utf8", env, timeout: 15_000 });
  const status = () => JSON.parse(phimacs("status", "--json").stdout);
  t.after(() => {
    const pid = status().emacs.pid;
    if (pid) process.kill(pid, "SIGKILL");
  });
  const both = await Promise.all([launch(["--no-frame"], env), launch(["--no-frame"], env)]);
  for (const result of both) assert.equal(result.status, 0, result.stderr + fs.readFileSync(path.join(box.state, "emacs-start.log"), "utf8"));
  assert.equal(both.filter(result => /Started pimux .*Journaled root agents are restored idle; nothing is replayed/.test(result.stderr)).length, 1);
  const running = status();
  assert.deepEqual([running.service.state, running.emacs.state], ["ready", "running"]);
  assert.equal(fs.existsSync(path.join(box.state, "emacs-start.lock")), false, "the winning startup released its lock");
  const started = Date.now();
  const again = phimacs("--no-frame");
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stderr, "", "attaching starts nothing and says nothing");
  assert.ok(Date.now() - started < 2000, `attach took ${Date.now() - started} ms`);
  assert.equal(status().emacs.pid, running.emacs.pid);
  const draft = path.join(box.input.dir, "draft.txt");
  fs.writeFileSync(draft, "saved\n");
  const socket = path.join(box.state, "sockets/phimacs");
  const evaluate = form => spawnSync(emacs.client, ["--alternate-editor=false", "--socket-name", socket, "--eval", form], { encoding: "utf8", env });
  assert.equal(evaluate(`(with-current-buffer (find-file-noselect ${JSON.stringify(draft)}) (insert "unsaved ") t)`).status, 0);
  for (const args of [["stop"], ["stop", "--force"]]) {
    const refused = phimacs(...args);
    assert.equal(refused.status, 1, refused.stdout);
    assert.match(refused.stderr, /Unsaved changes in .*draft\.txt; save or revert them before stopping Emacs/);
  }
  assert.deepEqual([status().service.state, status().emacs.pid], ["ready", running.emacs.pid], "nothing stopped or drained");
  assert.equal(evaluate(`(with-current-buffer (get-file-buffer ${JSON.stringify(draft)}) (save-buffer) t)`).status, 0);
  const stopped = phimacs("stop");
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(stopped.stdout, new RegExp(`Saved and quit Emacs \\(pid ${running.emacs.pid}\\); stopped pimux`));
  assert.ok(fs.existsSync(path.join(box.state, "deck/state.eld")), "the deck saved its state before quitting");
  const after = status();
  assert.deepEqual([after.service.state, after.emacs.state], ["absent", "absent"]);
});

test("`phimacs service emacs` execs the profile daemon in place for a supervisor", {
  skip: realDaemon,
  timeout: 20_000,
}, async t => {
  const box = sandbox(t);
  const emacs = selectedEmacs(process.env);
  fs.cpSync(process.env.PHIMACS_TEST_EMACS_DIR, path.join(box.state, "emacs"), { recursive: true });
  const env = { ...box.env, PATH: `${path.dirname(process.execPath)}:${emacs.path}`, PHIMACS_STATE_DIR: box.state,
    PHIMACS_EMACS: emacs.emacs, PHIMACS_EMACSCLIENT: emacs.client, PHIMACS_USER_FILE: path.join(box.input.dir, "user.el"),
    DISPLAY: ":phimacs-supervisor-choice", WAYLAND_DISPLAY: "phimacs-supervisor-choice" };
  const daemon = spawn(path.resolve(import.meta.dirname, "../bin/phimacs"), ["service", "emacs"], { env, stdio: "ignore" });
  box.children.push(daemon);
  const options = parseOptions([], env);
  const identity = await until(() => { try { return probe(options); } catch { return null; } }, "supervised daemon answers");
  assert.equal(identity.pid, daemon.pid, "the supervisor's child is the daemon itself");
  assert.equal(fs.realpathSync(identity.root), fs.realpathSync(box.runtime.root));
  const environment = fs.readFileSync(`/proc/${daemon.pid}/environ`, "utf8").split("\0");
  for (const name of ["DISPLAY", "WAYLAND_DISPLAY"]) {
    assert.ok(environment.some(entry => entry.startsWith(`${name}=`) && entry.endsWith("phimacs-supervisor-choice")), `the supervisor's ${name} is kept`);
  }
  daemon.kill("SIGTERM");
  const [, signal] = await new Promise(resolve => daemon.once("exit", (code, killed) => resolve([code, killed])));
  assert.equal(signal, null, "Emacs itself handled the supervisor's SIGTERM and exited");
});

test("the Bash launcher reports a missing checkout instead of guessing one", () => {
  const directory = fs.mkdtempSync("/tmp/phimacs-test-client-");
  try {
    const copy = path.join(directory, "phimacs");
    fs.copyFileSync(path.resolve(import.meta.dirname, "../bin/phimacs"), copy);
    fs.chmodSync(copy, 0o755);
    const result = spawnSync(copy, ["status"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: directory } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no Phimacs checkout around .*; set PHIMACS_HOST to use one over SSH/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
