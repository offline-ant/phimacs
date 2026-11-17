import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { HostTarget } from "./host-types.ts";
import { observePanelOwner, runPanelObserver, retainPanelObserverFailure } from "./panel-owner.ts";

const owner = { pid: 123, startTime: "456", bootId: "test-boot" };
function fixture() {
  const target: HostTarget = { name: "owned-panel", host: "emacs", endpoint: "/isolated/host", id: "panel-id", kind: "shell", owner, outputPath: "/isolated/output" };
  let current: HostTarget | undefined = target;
  const events: string[] = [];
  const services: NonNullable<Parameters<typeof observePanelOwner>[1]> = {
    read: () => current,
    status: () => "dead",
    claim: async () => { events.push("claim"); return () => { events.push("release"); }; },
    close: async (closed) => { assert.equal(closed, current); events.push(`close ${closed.host} ${closed.endpoint} ${closed.id}`); },
    removeOutput: (output) => { assert.equal(output, target.outputPath); events.push("remove output"); },
    remove: () => { events.push("remove target"); current = undefined; },
    save: (saved) => { current = saved; },
    wait: async () => { throw new Error("Unexpected wait"); },
  };
  return { target, services, events, get current() { return current; }, set current(value) { current = value; } };
}

test("native panel ownership survives frontend loss and closes only after exact creating Pi death", async () => {
  const f = fixture();
  const states = ["alive", "unknown", "alive", "dead"] as const;
  let index = 0;
  f.services.status = (identity) => { assert.deepEqual(identity, owner); return states[index]; };
  f.services.wait = async () => { assert.deepEqual(f.events, []); index++; };
  await observePanelOwner(f.target, f.services);
  assert.equal(index, 3, "unknown liveness and frontend disconnect never authorize cleanup");
  assert.deepEqual(f.events, ["claim", "close emacs /isolated/host panel-id", "remove output", "remove target", "release"]);
  assert.equal(f.current, undefined);
});

test("a name replaced during claim acquisition never closes the replacement", async () => {
  const f = fixture();
  const replacement = { ...f.target, owner: { ...owner, startTime: "789" } };
  f.services.claim = async () => { f.current = replacement; return () => { f.events.push("release"); }; };
  await observePanelOwner(f.target, f.services);
  assert.equal(f.current, replacement);
  assert.deepEqual(f.events, ["release"]);
});

test("a reused native ID with a new output capture is not the old owned panel", async () => {
  const f = fixture();
  f.current = { ...f.target, outputPath: "/isolated/replacement-output" };
  await observePanelOwner(f.target, f.services);
  assert.deepEqual(f.events, []);
});

test("failed native close retains diagnostics, name and output, including earlier errors", async () => {
  const f = fixture();
  f.current = { ...f.target, closeError: "Earlier close acknowledgement was lost" };
  f.services.close = async () => { throw new Error("Host did not acknowledge close"); };
  await assert.rejects(observePanelOwner(f.target, f.services), /Host did not acknowledge/);
  assert.match(f.current!.closeError!, /Earlier close acknowledgement was lost\nNative panel cleanup failed: Host did not acknowledge close/);
  assert.deepEqual(f.events, ["claim", "release"]);
});

test("failed diagnostic retention preserves the native failure and record failure", async () => {
  const f = fixture();
  const closeError = new Error("Native close failed");
  const recordError = new Error("Registry unavailable");
  f.services.close = async () => { throw closeError; };
  f.services.save = () => { throw recordError; };
  await assert.rejects(observePanelOwner(f.target, f.services), (failure: unknown) => {
    assert.ok(failure instanceof AggregateError);
    assert.deepEqual(failure.errors, [closeError, recordError]);
    return true;
  });
  assert.equal(f.current, f.target);
  assert.deepEqual(f.events, ["claim", "release"]);
});

test("worker/root/fork Pi targets cannot be stopped through native-panel cleanup", async () => {
  const f = fixture();
  await assert.rejects(observePanelOwner({ ...f.target, kind: "pi" }, f.services), /exact creating process identity/);
  assert.deepEqual(f.events, []);
});

test("detached native cleanup survives creator death with no frontend and preserves independent forks", { timeout: 20_000 }, async (t) => {
  const execute = promisify(execFile);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "panel-owner-test-"));
  const endpoint = path.join(root, "host.sock");
  const registry = path.join(root, "pi-orchestration-targets");
  await execute("tmux", ["-S", endpoint, "new-session", "-d", "-s", "owned-test"]);
  const parent = (await execute("tmux", ["-S", endpoint, "display-message", "-p", "-t", "owned-test", "#{pane_id}"])).stdout.trim();
  const entry = path.join(root, "creator.mjs");
  fs.writeFileSync(entry, [
    'import {execFile} from "node:child_process"; import {promisify} from "node:util";',
    `import { createTmuxHost } from ${JSON.stringify(new URL("./dist/hosts/tmux.js", import.meta.url).href)};`,
    `import { saveTarget } from ${JSON.stringify(new URL("./dist/workers.js", import.meta.url).href)};`,
    `import { ownPanel, panelOwner } from ${JSON.stringify(new URL("./dist/panel-lifetime.js", import.meta.url).href)};`,
    'const execute=promisify(execFile); const pi={exec: async(command,args,options)=>({...await execute(command,args,options),code:0,killed:false})};',
    `const endpoint=${JSON.stringify(endpoint)}; const parent={host:"tmux",endpoint,id:${JSON.stringify(parent)},kind:"pi",name:"parent"};`,
    'const target = {...await createTmuxHost(pi,endpoint).start({name:"owned",kind:"shell",placement:"worker",parent,cwd:"/tmp",argv:["/bin/sh","-c","read line"]}),owner:panelOwner()};',
    'saveTarget(target);',
    'saveTarget({name:"independent-fork",host:"tmux",endpoint,id:parent.id,kind:"pi"});',
    'await ownPanel(target);',
    'process.send({ready:true,id:target.id});',
    'setInterval(() => {}, 1000);',
  ].join("\n"), { mode: 0o600 });
  const child = spawn(process.execPath, [entry], { env: { ...process.env, TMPDIR: root }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  child.stderr!.on("data", (data: Buffer) => { stderr += data.toString(); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
    await execute("tmux", ["-S", endpoint, "kill-server"]).catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const [message] = await once(child, "message", { signal: AbortSignal.timeout(10_000) }).catch((error: unknown) => {
    throw new Error(`Native panel creator did not report readiness (exit ${child.exitCode}, signal ${child.signalCode}): ${stderr}`, { cause: error });
  }) as [{ ready: boolean; id: string }];
  assert.equal(message.ready, true, stderr);
  assert.equal(fs.existsSync(path.join(registry, "owned.json")), true);
  const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
  const deadline = Date.now() + 5000;
  while (fs.existsSync(path.join(registry, "owned.json"))) {
    assert.ok(Date.now() < deadline, `native cleanup finished after root exit: ${stderr}`);
    await delay(20);
  }
  const panes = (await execute("tmux", ["-S", endpoint, "list-panes", "-a", "-F", "#{pane_id}"])).stdout.trim().split("\n");
  assert.ok(!panes.includes(message.id));
  assert.ok(panes.includes(parent));
  assert.equal(fs.existsSync(path.join(registry, "independent-fork.json")), true);
});

test("diagnostic fallback cannot overwrite a replacement between ownership read and save", () => {
  const f = fixture();
  const replacement = { ...f.target, id: "replacement", outputPath: "/replacement/output" };
  let reads = 0;
  let saves = 0;
  f.target.observerErrorPath = "/isolated/error.log";
  f.services.read = () => { reads++; f.current = replacement; return f.target; };
  f.services.save = () => { saves++; throw new Error("must never overwrite a replacement"); };
  f.services.diagnostic = () => { f.current = replacement; };
  assert.throws(() => retainPanelObserverFailure(f.target, new Error("bootstrap failed"), f.services), /bootstrap failed/);
  assert.equal(reads, 0, "there is no unlocked read/check/save window");
  assert.equal(saves, 0);
  assert.equal(f.current, replacement);
});

test("observer validates initial registry before readiness and retains read failures privately", async () => {
  const f = fixture();
  f.target.observerErrorPath = "/isolated/observer-error.log";
  const diagnostics: string[] = [];
  f.services.read = () => { throw new Error("Initial registry unavailable"); };
  f.services.diagnostic = (_file, detail) => { diagnostics.push(detail); };
  let ready = false;
  await assert.rejects(runPanelObserver(f.target, async () => { ready = true; }, async () => {}, Promise.resolve(), f.services), /Initial registry unavailable/);
  assert.equal(ready, false);
  assert.match(diagnostics[0], /Initial registry unavailable/);
  assert.deepEqual(f.events, []);
});

test("creator death before startup cannot race readiness against completed cleanup", async () => {
  const f = fixture();
  let start: () => void = () => {};
  const gate = new Promise<void>((resolve) => { start = resolve; });
  let ready = false;
  let started = false;
  const observing = runPanelObserver(f.target, async () => { ready = true; }, async () => { started = true; }, gate, f.services);
  await Promise.resolve();
  assert.equal(ready, true);
  assert.equal(started, false);
  assert.equal(f.events.length, 0);
  start();
  await observing;
  assert.equal(started, true);
  assert.ok(f.events.includes("remove target"));
});

test("late observer failures outside destructive cleanup retain diagnostics", async () => {
  for (const failure of ["read", "claim", "wait", "release"] as const) {
    const f = fixture();
    f.target.observerErrorPath = "/isolated/observer-error.log";
    const diagnostics: string[] = [];
    f.services.diagnostic = (_file, detail) => { diagnostics.push(detail); };
    if (failure === "read") { let reads = 0; f.services.read = () => { if (++reads === 2) throw new Error("late read"); return f.current; }; f.services.status = () => "alive"; f.services.wait = async () => {}; }
    if (failure === "claim") f.services.claim = async () => { throw new Error("late claim"); };
    if (failure === "wait") { f.services.status = () => "alive"; f.services.wait = async () => { throw new Error("late wait"); }; }
    if (failure === "release") f.services.claim = async () => () => { throw new Error("late release"); };
    await assert.rejects(observePanelOwner(f.target, f.services), new RegExp(`late ${failure}`));
    assert.match(diagnostics[0], new RegExp(`late ${failure}`));
    if (f.current) assert.equal(f.current.closeError, undefined, "out-of-claim diagnostic retention never writes the registry");
  }
});
