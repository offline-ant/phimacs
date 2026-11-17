import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { Worker } from "node:worker_threads";
import { readProcessIdentity, type ProcessIdentity } from "@phimacs/pimux/process-identity";
import { createParentTask } from "./parent-task.ts";
import type { HostTarget } from "./host-types.ts";
import { finishWorkerTask, publishWorkerTask, readWorkerTask } from "./worker-task.ts";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phimacs-task-evidence-"));
  const lease = path.join(root, "lease");
  fs.mkdirSync(lease, { mode: 0o700 });
  const binding = createParentTask(lease, "task-one");
  const env = { ...process.env, PIMUX_DIR: path.join(root, "mux") };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = (worker: ProcessIdentity, muxId = "worker-one"): HostTarget => ({
    kind: "pi", host: "emacs", endpoint: "/private/disposable", id: muxId, name: muxId, process: worker,
    runtime: { protocol: 2, muxId, operationId: "start", socket: path.join(env.PIMUX_DIR, `${muxId}.sock`), pid: process.pid,
      piPid: worker.pid, sessionFile: path.join(root, "synthetic.jsonl"), state: "committed", outcome: "started" },
  });
  const recordFile = (muxId = "worker-one") => path.join(env.PIMUX_DIR, "task-receipts", `${muxId}.json`);
  return { root, binding, env, target, recordFile };
}

async function worker(t: TestContext) {
  const child = spawn(process.execPath, ["-e", "process.send('ready');setInterval(()=>{},1000)"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  await once(child, "message", { signal: AbortSignal.timeout(5000) });
  const identity = readProcessIdentity(child.pid!)!;
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit", { signal: AbortSignal.timeout(5000) });
    child.kill("SIGTERM");
    await exited;
  };
  t.after(stop);
  return { identity, stop };
}

test("read-only missing evidence is null and does not create a runtime namespace", t => {
  const f = fixture(t);
  assert.equal(readWorkerTask("worker-one", f.env), null);
  assert.equal(fs.existsSync(f.env.PIMUX_DIR), false);
  assert.throws(() => readWorkerTask("../worker-one", f.env), /identity/);
  assert.throws(() => finishWorkerTask("worker-one", { env: f.env }), /missing/);
});

test("pending, ended lease and actual worker exit are distinct; final evidence outlives targets and leases", async t => {
  const f = fixture(t), w = await worker(t);
  const pending = publishWorkerTask(f.target(w.identity), f.binding, f.env);
  assert.equal(pending.state, "pending");
  assert.deepEqual(readWorkerTask("worker-one", f.env), pending);
  assert.equal(fs.statSync(f.recordFile()).mode & 0o777, 0o600);
  assert.throws(() => finishWorkerTask("worker-one", { env: f.env }), /lease has not ended/);
  f.binding.end();
  assert.equal(readWorkerTask("worker-one", f.env)!.state, "pending");
  assert.throws(() => finishWorkerTask("worker-one", { env: f.env }), /exit is not proven/);
  await w.stop();
  const complete = finishWorkerTask("worker-one", { env: f.env });
  assert.equal(complete.state, "complete");
  fs.rmSync(f.binding.file);
  assert.deepEqual(readWorkerTask("worker-one", f.env), complete);
  assert.deepEqual(finishWorkerTask("worker-one", { env: f.env }), complete);
  assert.throws(() => finishWorkerTask("worker-one", { env: f.env, error: "late replacement" }), /cannot be replaced/);
});

test("identity cannot be rebound, even after completion or PID reuse", async t => {
  const f = fixture(t), w = await worker(t);
  const target = f.target(w.identity);
  publishWorkerTask(target, f.binding, f.env);
  assert.deepEqual(publishWorkerTask(target, f.binding, f.env).state, "pending");
  const reused = { ...w.identity, startTime: `${BigInt(w.identity.startTime) + 1n}` };
  assert.throws(() => publishWorkerTask(f.target(reused), f.binding, f.env), /cannot be replaced/);
  assert.throws(() => publishWorkerTask(target, { ...f.binding, parent: { ...f.binding.parent, taskId: "replacement" } }, f.env), /lease identity/);
  assert.throws(() => publishWorkerTask(target, { ...f.binding, parent: { ...f.binding.parent, process: reused } }, f.env), /owning parent/);
  f.binding.end(); await w.stop(); finishWorkerTask("worker-one", { env: f.env });
  assert.equal(publishWorkerTask(target, f.binding, f.env).state, "complete", "republishing never erases terminal evidence");
  assert.throws(() => publishWorkerTask(f.target(reused), f.binding, f.env), /cannot be replaced/);
});

test("changed lease and foreign parent cannot finish another task", async t => {
  const f = fixture(t), w = await worker(t);
  publishWorkerTask(f.target(w.identity), f.binding, f.env);
  f.binding.end(); await w.stop();
  const lease = fs.readFileSync(f.binding.file, "utf8");
  fs.writeFileSync(f.binding.file, JSON.stringify({ ...JSON.parse(lease), taskId: "other-task" }));
  assert.throws(() => finishWorkerTask("worker-one", { env: f.env }), /lease identity/);
  fs.writeFileSync(f.binding.file, lease);
  const value = JSON.parse(fs.readFileSync(f.recordFile(), "utf8"));
  fs.writeFileSync(f.recordFile(), JSON.stringify({ ...value, parent: { ...value.parent, process: { ...value.parent.process, startTime: "0" } } }));
  assert.throws(() => finishWorkerTask("worker-one", { env: f.env }), /owning parent/);
});

test("failed cleanup retains its full error and never becomes complete", async t => {
  const f = fixture(t), w = await worker(t);
  publishWorkerTask(f.target(w.identity), f.binding, f.env);
  f.binding.end(); await w.stop();
  const error = "Original task failure\nNative cleanup failed\nName release uncertain";
  const failed = finishWorkerTask("worker-one", { env: f.env, error });
  assert.equal(failed.state, "failed"); assert.equal(failed.error, error);
  assert.deepEqual(readWorkerTask("worker-one", f.env), failed);
  assert.deepEqual(finishWorkerTask("worker-one", { env: f.env, error }), failed);
  assert.throws(() => finishWorkerTask("worker-one", { env: f.env }), /cannot be replaced/);
});

test("readers follow atomic evidence republication instead of failing on a replaced record", async t => {
  const f = fixture(t), w = await worker(t);
  const pending = publishWorkerTask(f.target(w.identity), f.binding, f.env);
  const record = fs.readFileSync(f.recordFile(), "utf8");
  // Republish as publication does: a complete private file renamed over the old one.
  const publisher = new Worker(`const fs = require("node:fs"); const { workerData } = require("node:worker_threads");
    for (let index = 0;; index++) {
      const temporary = workerData.file + "." + index + ".tmp";
      fs.writeFileSync(temporary, workerData.record, { flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, workerData.file);
    }`, { eval: true, workerData: { file: f.recordFile(), record } });
  try {
    await once(publisher, "online");
    for (let read = 0; read < 20_000; read++) assert.deepEqual(readWorkerTask("worker-one", f.env), pending);
  } finally { await publisher.terminate(); }
});

test("unsafe permissions, symlinks, hardlinks, malformed and oversized receipts fail closed", async t => {
  const f = fixture(t), w = await worker(t);
  publishWorkerTask(f.target(w.identity), f.binding, f.env);
  const original = fs.readFileSync(f.recordFile());
  fs.chmodSync(f.recordFile(), 0o644);
  assert.throws(() => readWorkerTask("worker-one", f.env), /private/);
  fs.chmodSync(f.recordFile(), 0o600);
  const alias = `${f.recordFile()}.saved`;
  fs.renameSync(f.recordFile(), alias); fs.symlinkSync(alias, f.recordFile());
  assert.throws(() => readWorkerTask("worker-one", f.env), /ELOOP/);
  fs.unlinkSync(f.recordFile()); fs.linkSync(alias, f.recordFile());
  assert.throws(() => readWorkerTask("worker-one", f.env), /private/);
  fs.unlinkSync(alias);
  fs.writeFileSync(f.recordFile(), "{");
  assert.throws(() => readWorkerTask("worker-one", f.env), SyntaxError);
  fs.writeFileSync(f.recordFile(), " ".repeat(65537));
  assert.throws(() => readWorkerTask("worker-one", f.env), /bounded/);
  fs.writeFileSync(f.recordFile(), original);
  fs.chmodSync(f.env.PIMUX_DIR, 0o755);
  assert.throws(() => readWorkerTask("worker-one", f.env), /0700/);
  fs.chmodSync(f.env.PIMUX_DIR, 0o700);
  const receipts = path.dirname(f.recordFile());
  fs.renameSync(receipts, `${receipts}-saved`); fs.symlinkSync(`${receipts}-saved`, receipts);
  assert.throws(() => readWorkerTask("worker-one", f.env), /canonical/);
});

test("receipt schema, runtime identity, worker identity and terminal error are validated", async t => {
  const f = fixture(t), w = await worker(t);
  assert.throws(() => publishWorkerTask({ ...f.target(w.identity), process: undefined }, f.binding, f.env), /worker identity/);
  assert.equal(fs.existsSync(f.env.PIMUX_DIR), false);
  const record = publishWorkerTask(f.target(w.identity), f.binding, f.env);
  for (const patch of [
    { schema: 2 }, { muxId: "other-runtime" }, { worker: { ...record.worker, pid: 0 } },
    { parent: { ...record.parent, taskId: "" } }, { state: "failed" },
    { state: "complete", error: "conflicting outcome" }, { state: "unknown" }, { leaseFile: "/tmp/../not-canonical" },
  ]) {
    fs.writeFileSync(f.recordFile(), JSON.stringify({ ...record, ...patch }));
    assert.throws(() => readWorkerTask("worker-one", f.env), /Invalid/);
  }
});

test("lease symlink and unsafe permissions cannot authorize final evidence", async t => {
  const f = fixture(t), w = await worker(t);
  publishWorkerTask(f.target(w.identity), f.binding, f.env);
  f.binding.end(); await w.stop();
  fs.chmodSync(f.binding.file, 0o644);
  assert.throws(() => finishWorkerTask("worker-one", { env: f.env }), /private/);
  fs.chmodSync(f.binding.file, 0o600);
  fs.renameSync(f.binding.file, `${f.binding.file}.saved`); fs.symlinkSync(`${f.binding.file}.saved`, f.binding.file);
  assert.throws(() => finishWorkerTask("worker-one", { env: f.env }), /ELOOP/);
  assert.equal(readWorkerTask("worker-one", f.env)!.state, "pending");
});

test("retention bounds terminal records at 128 without dropping pending tasks", async t => {
  const f = fixture(t), w = await worker(t);
  publishWorkerTask(f.target(w.identity, "pending-task"), f.binding, f.env);
  f.binding.end(); await w.stop();
  for (let i = 0; i < 130; i++) {
    const id = `worker-${i}`;
    publishWorkerTask(f.target(w.identity, id), f.binding, f.env);
    finishWorkerTask(id, { env: f.env });
  }
  const files = fs.readdirSync(path.dirname(f.recordFile())).filter(name => name.endsWith(".json"));
  assert.equal(files.length, 129);
  assert.equal(readWorkerTask("pending-task", f.env)!.state, "pending");
  assert.equal(readWorkerTask("worker-129", f.env)!.state, "complete");
});

test("compiled CLI reads missing, pending and retained terminal evidence without another writer", async t => {
  const f = fixture(t), w = await worker(t);
  const cli = fileURLToPath(new URL("./dist/worker-task-cli.js", import.meta.url));
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { env: f.env, encoding: "utf8", timeout: 5000 });
  const absent = run("--id", "worker-one", "--json");
  assert.equal(absent.status, 0, absent.stderr); assert.equal(JSON.parse(absent.stdout), null);
  publishWorkerTask(f.target(w.identity), f.binding, f.env);
  const pending = run("--json", "--id", "worker-one");
  assert.equal(pending.status, 0, pending.stderr); assert.equal(JSON.parse(pending.stdout).state, "pending");
  f.binding.end(); await w.stop(); finishWorkerTask("worker-one", { env: f.env });
  const done = run("--id", "worker-one", "--json");
  assert.equal(done.status, 0, done.stderr); assert.equal(JSON.parse(done.stdout).state, "complete");
  fs.chmodSync(f.recordFile(), 0o644);
  const unsafe = run("--id", "worker-one", "--json");
  assert.equal(unsafe.status, 1); assert.equal(unsafe.stdout, ""); assert.match(unsafe.stderr, /private/);
  assert.equal(run("--id", "worker-one").status, 1);
});
