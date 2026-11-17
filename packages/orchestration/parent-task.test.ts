import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import { processIdentityStatus, readProcessIdentity, type ProcessIdentity } from "@phimacs/pimux/process-identity";
import { setTimeout as delay } from "node:timers/promises";
import { createWorkerArtifacts, writeWorkerRequest, type WorkerArtifactPaths } from "./worker-frame.ts";
import { createParentTask, endParentTask, parentTaskEnded, parentTaskEnvironment, readParentTaskBinding, watchParentTask } from "./parent-task.ts";

/** Every leased worker finds its request beside the lease. */
function writeRequest(paths: WorkerArtifactPaths, id: string): void {
  writeWorkerRequest(paths, { id, task: "Hold", tools: [], model: { provider: "fake", id: "fake" }, thinkingLevel: "high",
    resultPolicy: "brief", resultPath: paths.resultPath, statusPath: paths.statusPath });
}

function fixture(t: TestContext) {
  const paths = createWorkerArtifacts();
  t.after(() => fs.rmSync(paths.artifactDir, { recursive: true, force: true }));
  writeRequest(paths, "task-one");
  return { paths, task: createParentTask(paths.artifactDir, "task-one") };
}

test("parent task lease is private, exclusive and terminal even while the parent process lives", (t) => {
  const { paths, task } = fixture(t);
  assert.deepEqual(task.parent.process, readProcessIdentity(process.pid));
  assert.equal(parentTaskEnded(task), undefined);
  assert.equal(fs.statSync(task.file).mode & 0o777, 0o600);
  assert.throws(() => createParentTask(paths.artifactDir, "second-task"), /EEXIST/);
  const env = parentTaskEnvironment(task);
  const binding = readParentTaskBinding(env)!;
  assert.deepEqual(binding, { parent: task.parent, file: task.file });
  task.end(); task.end();
  assert.match(parentTaskEnded(binding)!, /task-one ended/);
  assert.equal(fs.existsSync(task.file), true, "late children retain authoritative terminal evidence");
});

test("explicit worker cancellation and parent cleanup share one identity-bound idempotent ending", (t) => {
  const { task } = fixture(t);
  const binding = readParentTaskBinding(parentTaskEnvironment(task))!;
  const active = fs.readFileSync(task.file, "utf8");
  for (const parent of [
    { ...task.parent, taskId: "another-task" },
    { ...task.parent, process: { ...task.parent.process, startTime: `${BigInt(task.parent.process.startTime) + 1n}` } },
  ]) assert.throws(() => endParentTask({ ...binding, parent }), /identity changed/);
  assert.equal(fs.readFileSync(task.file, "utf8"), active);
  endParentTask(binding);
  const ended = fs.readFileSync(task.file, "utf8");
  endParentTask(binding); task.end();
  assert.equal(fs.readFileSync(task.file, "utf8"), ended);
  assert.match(parentTaskEnded(task)!, /task-one ended/);
  fs.writeFileSync(task.file, JSON.stringify({ schema: 1, ...task.parent, taskId: "different", state: "active" }));
  assert.throws(() => endParentTask(binding), /identity changed/, "a terminal stale binding cannot end a substituted task");
  assert.throws(() => task.end(), /identity changed/, "parent cleanup revalidates instead of trusting a cached end flag");
});

test("explicit task ending rejects missing, malformed, unprivate and symlink bindings", (t) => {
  const { paths, task } = fixture(t);
  const active = fs.readFileSync(task.file, "utf8");
  fs.chmodSync(task.file, 0o644);
  assert.throws(() => endParentTask(task), /private same-user/);
  fs.chmodSync(task.file, 0o600);
  const alias = path.join(paths.artifactDir, "alias.json");
  fs.symlinkSync(task.file, alias);
  assert.throws(() => endParentTask({ ...task, file: alias }), /ELOOP/);
  assert.equal(fs.readFileSync(task.file, "utf8"), active);
  fs.writeFileSync(task.file, "{");
  assert.throws(() => endParentTask(task), SyntaxError);
  fs.rmSync(task.file);
  assert.throws(() => endParentTask(task), /ENOENT/);
});

test("concurrent parent and worker endings leave exactly one terminal task identity", async (t) => {
  const { task, paths } = fixture(t);
  const entry = path.join(paths.artifactDir, "end-task.mjs");
  fs.writeFileSync(entry, [
    `import {endParentTask} from ${JSON.stringify(new URL("./parent-task.ts", import.meta.url).href)};`,
    `endParentTask(${JSON.stringify({ parent: task.parent, file: task.file })});`,
  ].join("\n"));
  const children = Array.from({ length: 4 }, () => spawn(process.execPath, [entry], { stdio: ["ignore", "ignore", "pipe"] }));
  t.after(() => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill(); });
  await Promise.all(children.map(async (child) => {
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const [code, signal] = await once(child, "exit", { signal: AbortSignal.timeout(10_000) });
    assert.equal(code, 0, stderr); assert.equal(signal, null, stderr);
  }));
  assert.deepEqual(JSON.parse(fs.readFileSync(task.file, "utf8")), { schema: 1, ...task.parent, state: "ended" });
  assert.deepEqual(fs.readdirSync(paths.artifactDir).filter((file) => file.endsWith(".tmp")), []);
});

test("task ID, process-start identity, malformed lease and unavailable file all fail closed", (t) => {
  const { task } = fixture(t);
  assert.match(parentTaskEnded({ ...task, parent: { ...task.parent, taskId: "other-task" } })!, /identity changed/);
  const reused = { ...task.parent.process, startTime: `${BigInt(task.parent.process.startTime) + 1n}` };
  assert.match(parentTaskEnded({ ...task, parent: { ...task.parent, process: reused } })!, /identity changed/);
  const payload = JSON.parse(fs.readFileSync(task.file, "utf8"));
  fs.writeFileSync(task.file, JSON.stringify({ ...payload, process: reused }));
  assert.match(parentTaskEnded({ ...task, parent: { ...task.parent, process: reused } })!, /process is dead/);
  assert.throws(() => task.end(), /identity changed/);
  fs.writeFileSync(task.file, "{");
  assert.match(parentTaskEnded(task)!, /unavailable or uncertain/);
  fs.rmSync(task.file);
  assert.match(parentTaskEnded(task)!, /unavailable or uncertain/);
});

test("unsafe permissions and symlink leases never authorize continuing", (t) => {
  const { paths, task } = fixture(t);
  fs.chmodSync(task.file, 0o644);
  assert.match(parentTaskEnded(task)!, /private same-user/);
  fs.chmodSync(task.file, 0o600);
  const alias = path.join(paths.artifactDir, "alias.json");
  fs.symlinkSync(task.file, alias);
  assert.match(parentTaskEnded({ ...task, file: alias })!, /unavailable or uncertain/);
  fs.chmodSync(paths.artifactDir, 0o755);
  assert.match(parentTaskEnded(task)!, /must be a canonical directory owned by this user with mode 0700/);
  fs.chmodSync(paths.artifactDir, 0o700);
});

test("managed partial/invalid binding refuses instead of falling back to a root runtime", () => {
  assert.equal(readParentTaskBinding({}), undefined);
  for (const env of [
    { PHIMACS_MANAGED_CLAIM: "managed", PI_ORCHESTRATION_PLACEMENT: "worker" },
    { PHIMACS_PARENT_TASK: "{}" },
    { PHIMACS_PARENT_TASK_FILE: "/tmp/private/lease" },
    { PHIMACS_PARENT_TASK: "{}", PHIMACS_PARENT_TASK_FILE: "/tmp/private/lease" },
  ]) assert.throws(() => readParentTaskBinding(env), /requires|Invalid/);
});

test("task watcher survives frontend disappearance, stops once on task end and cleans its timer", (t) => {
  const { task } = fixture(t);
  t.mock.timers.enable({ apis: ["setInterval"] });
  const stopped: string[] = [];
  const cleanup = watchParentTask(task, (reason) => stopped.push(reason));
  t.mock.timers.tick(1000);
  assert.deepEqual(stopped, [], "no frontend/socket/buffer is consulted");
  task.end();
  t.mock.timers.tick(250);
  assert.match(stopped[0], /ended/);
  t.mock.timers.tick(1000);
  assert.equal(stopped.length, 1);
  cleanup(); cleanup();
});

test("an ended lease stops at initialization, before the first prompt can arrive", (t) => {
  const { task } = fixture(t);
  task.end();
  const stopped: string[] = [];
  watchParentTask(task, (reason) => stopped.push(reason))();
  assert.equal(stopped.length, 1);
});

for (const beforeStartup of [false, true]) {
  test(`real idle child exits on parent task end ${beforeStartup ? "before startup" : "without a frontend"}`, async (t) => {
    const { paths, task } = fixture(t);
    if (beforeStartup) task.end();
    const entry = path.join(paths.artifactDir, "child.mjs");
    fs.writeFileSync(entry, [
      `import workerFrame from ${JSON.stringify(new URL("./worker-frame.ts", import.meta.url).href)};`,
      'const handlers = new Map();',
      'process.on("message", () => {});',
      'workerFrame({on: (name, handler) => handlers.set(name, handler), registerCommand: () => {}, events: {on: () => () => {}, emit: () => {}}});',
      'const ctx = {shutdown: () => process.send({type:"shutdown"}), ui: {setStatus: () => {}, setWidget: () => {}}};',
      'await handlers.get("session_start")({}, ctx);',
      'process.send({type:"ready"});',
    ].join("\n"), { mode: 0o600 });
    const env = { ...process.env, ...parentTaskEnvironment(task) };
    const child = spawn(process.execPath, [entry], { env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    const exited = once(child, "exit", { signal: AbortSignal.timeout(5000) });
    if (!beforeStartup) {
      const [message] = await once(child, "message", { signal: AbortSignal.timeout(5000) });
      assert.deepEqual(message, { type: "ready" }, stderr);
      assert.equal(child.exitCode, null);
      task.end();
    }
    const [code, signal] = await exited;
    assert.equal(code, null, stderr);
    assert.equal(signal, "SIGTERM", stderr);
  });
}

test("a worker stops when its owning parent process dies while the task lease remains active", { timeout: 15_000 }, async (t) => {
  const paths = createWorkerArtifacts();
  writeRequest(paths, "orphan-test");
  const report = path.join(paths.artifactDir, "parent-death.json");
  const workerEntry = path.join(paths.artifactDir, "worker.mjs");
  const parentEntry = path.join(paths.artifactDir, "parent.mjs");
  fs.writeFileSync(workerEntry, [
    'import fs from "node:fs";',
    `import workerFrame from ${JSON.stringify(new URL("./worker-frame.ts", import.meta.url).href)};`,
    'const handlers = new Map();',
    'setInterval(() => {}, 1000);',
    'workerFrame({on: (name, handler) => handlers.set(name, handler), registerCommand: () => {}, events: {on: () => () => {}, emit: () => {}}});',
    `const ctx = {shutdown: () => fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({pid:process.pid})), ui: {setStatus: () => {}, setWidget: () => {}}};`,
    'await handlers.get("session_start")({}, ctx);',
    'process.send({type:"ready"});',
  ].join("\n"), { mode: 0o600 });
  fs.writeFileSync(parentEntry, [
    'import {spawn} from "node:child_process";',
    `import {createParentTask, parentTaskEnvironment} from ${JSON.stringify(new URL("./parent-task.ts", import.meta.url).href)};`,
    `import {readProcessIdentity} from ${JSON.stringify(import.meta.resolve("@phimacs/pimux/process-identity"))};`,
    `const task = createParentTask(${JSON.stringify(paths.artifactDir)}, "orphan-test");`,
    `const child = spawn(process.execPath, [${JSON.stringify(workerEntry)}], {env:{...process.env,...parentTaskEnvironment(task)},stdio:["ignore","ignore","inherit","ipc"]});`,
    'child.once("message", () => process.send({worker:readProcessIdentity(child.pid)}));',
  ].join("\n"), { mode: 0o600 });
  const parent = spawn(process.execPath, [parentEntry], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  parent.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  let worker: ProcessIdentity | undefined;
  t.after(async () => {
    if (parent.exitCode === null && parent.signalCode === null) {
      const exited = once(parent, "exit"); parent.kill("SIGKILL"); await exited;
    }
    if (worker && processIdentityStatus(worker) === "alive") process.kill(worker.pid, "SIGKILL");
    fs.rmSync(paths.artifactDir, { recursive: true, force: true });
  });
  const [message] = await once(parent, "message", { signal: AbortSignal.timeout(8000) });
  worker = (message as { worker: ProcessIdentity }).worker;
  assert.ok(worker, stderr);
  assert.equal(processIdentityStatus(worker), "alive");
  const exited = once(parent, "exit"); parent.kill("SIGTERM"); await exited;
  const deadline = Date.now() + 5000;
  while (processIdentityStatus(worker) !== "dead") {
    assert.ok(Date.now() < deadline, `worker stopped after parent death: ${stderr}`);
    await delay(25);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(report, "utf8")), { pid: worker.pid });
  assert.equal(JSON.parse(fs.readFileSync(path.join(paths.artifactDir, "parent-task.json"), "utf8")).state, "active",
    "process-start identity, not a terminal lease write or frontend, ended this worker");
});

test("explicit watcher cleanup removes all later task-end reactions", (t) => {
  const { task } = fixture(t);
  t.mock.timers.enable({ apis: ["setInterval"] });
  const stopped: string[] = [];
  watchParentTask(task, (reason) => stopped.push(reason))();
  task.end(); t.mock.timers.tick(1000);
  assert.deepEqual(stopped, []);
});
