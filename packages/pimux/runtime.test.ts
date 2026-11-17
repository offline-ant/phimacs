import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { listDiscovery, writeDiscovery } from "./discovery.ts";
import { acquireClaim, lookupClaim, releaseClaim } from "./ownership.ts";
import { processIdentityStatus, readProcessIdentity, type ProcessIdentity } from "./process-identity.ts";
import { startRuntime, stopRuntime, type RuntimeReceipt } from "./runtime.ts";
import { BIN, connectPeer, PI, prepare, startMux, startTestService, until, type Prepared } from "./test/harness.ts";

const SLOW = fileURLToPath(new URL("./test/slow-start.ts", import.meta.url));
const BROKEN_GUARD = fileURLToPath(new URL("./test/broken-guard.ts", import.meta.url));
const IDENTITY_FAULT = fileURLToPath(new URL("./test/identity-fault.mjs", import.meta.url));
async function prepared(t: TestContext): Promise<Prepared> {
  const input = prepare();
  await startTestService(t, input);
  t.after(async () => {
    for (const entry of listDiscovery(input.env.PIMUX_DIR!)) {
      if (entry.ownerIdentity && processIdentityStatus(entry.ownerIdentity) === "alive") {
        try { await stopRuntime(entry.muxId, { env: input.env }); }
        catch { if (processIdentityStatus(entry.ownerIdentity) === "alive") process.kill(entry.ownerIdentity.pid, "SIGTERM"); }
        await until(() => processIdentityStatus(entry.ownerIdentity!) === "dead" && (!entry.piIdentity || processIdentityStatus(entry.piIdentity) === "dead"), "test-owned startup cleanup", 15_000);
      }
    }
    fs.rmSync(input.dir, { recursive: true, force: true });
  });
  return input;
}
async function launchCli(input: Prepared, extraArgs: string[] = []): Promise<{ code: number | null; receipt?: RuntimeReceipt; stderr: string }> {
  const child = spawn(process.execPath, [BIN, "start", "--json", "--", PI, ...input.piArgs, ...extraArgs], { cwd: input.dir, env: input.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  return { code, stderr, ...stdout.trim() ? { receipt: JSON.parse(stdout.trim()) as RuntimeReceipt } : {} };
}

test("separate concurrent launchers elect one runtime and the other attaches", { timeout: 20_000 }, async (t) => {
  const input = await prepared(t);
  const results = await Promise.all([launchCli(input), launchCli(input)]);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(results.map((result) => result.receipt!.outcome).sort(), ["attached", "started"]);
  assert.equal(results[0]!.receipt!.muxId, results[1]!.receipt!.muxId);
  assert.equal(results[0]!.receipt!.piPid, results[1]!.receipt!.piPid);
  assert.equal(listDiscovery(input.env.PIMUX_DIR!).length, 1);
  const peer = await connectPeer(results[0]!.receipt!);
  await peer.run("one writer"); peer.socket.destroy();
});

test("symlink and hardlink launch aliases attach to the same claimed runtime", { timeout: 20_000 }, async (t) => {
  const run = await startMux(t);
  const symlink = path.join(run.isolation.sessions, "linked.jsonl");
  const hardlink = path.join(run.isolation.sessions, "hard.jsonl");
  fs.symlinkSync(run.sessionFile, symlink); fs.linkSync(run.sessionFile, hardlink);
  for (const file of [symlink, hardlink]) {
    const args = [...run.piArgs]; args[args.indexOf("--session") + 1] = file;
    const receipt = await startRuntime({ command: PI, args, cwd: run.dir, env: run.env });
    assert.equal(receipt.outcome, "attached"); assert.equal(receipt.muxId, run.receipt.muxId);
  }
});

test("committed idle runtime survives no clients and a failed frontend attachment", { timeout: 20_000 }, async (t) => {
  const run = await startMux(t);
  run.first.socket.destroy();
  await delay(200);
  assert.equal(processIdentityStatus(run.ownerIdentity), "alive");
  assert.equal(processIdentityStatus(run.piIdentity), "alive");
  const peer = await run.connect();
  await peer.run("after reconnect"); peer.socket.destroy();
  const again = await startRuntime({ command: PI, args: run.piArgs, cwd: run.dir, env: run.env });
  assert.equal(again.outcome, "attached"); assert.equal(again.muxId, run.receipt.muxId);
});

test("a retained old reservation cannot attach a caller to a different conversation", { timeout: 20_000 }, async (t) => {
  const run = await startMux(t);
  await run.first.request({ type: "new_session" });
  const current = await until(() => {
    const file = run.discovery()?.session?.file;
    return file && file !== run.sessionFile ? file : undefined;
  }, "runtime moved to another file");
  await assert.rejects(startRuntime({ command: PI, args: run.piArgs, cwd: run.dir, env: run.env }), /retained.*another conversation/);
  const args = [...run.piArgs]; args[args.indexOf("--session") + 1] = current;
  const attached = await startRuntime({ command: PI, args, cwd: run.dir, env: run.env });
  assert.equal(attached.muxId, run.receipt.muxId);
  assert.equal(attached.sessionFile, current);
  assert.equal(attached.outcome, "attached");
  await stopRuntime(run.receipt.muxId, { env: run.env });
  assert.equal(lookupClaim(run.sessionFile, run.isolation.options), undefined);
  assert.equal(lookupClaim(current, run.isolation.options), undefined);
});

test("post-spawn identity failure waits for actual owned Pi exit before releasing a claim", { timeout: 20_000 }, async (t) => {
  const input = await prepared(t);
  let identity: ProcessIdentity | undefined;
  t.after(async () => {
    if (identity && processIdentityStatus(identity) === "alive") {
      process.kill(identity.pid, "SIGTERM");
      await until(() => processIdentityStatus(identity!) === "dead", "test-owned fault child cleanup");
    }
  });
  await assert.rejects(startRuntime({ command: PI, args: input.piArgs, cwd: input.dir,
    env: { ...input.env, NODE_OPTIONS: `${input.env.NODE_OPTIONS ?? ""} --import ${IDENTITY_FAULT}` } }), /identity.*process|identity.*established|exited/i);
  identity = JSON.parse(fs.readFileSync(path.join(input.dir, "identity-fault.json"), "utf8")) as ProcessIdentity;
  assert.equal(processIdentityStatus(identity), "dead", "stopped receipt requires actual child exit, not failed /proc inspection");
  assert.equal(lookupClaim(input.sessionFile, input.isolation.options), undefined);
});

test("stop is confirmed and its retained identity-bound receipt is idempotent", { timeout: 20_000 }, async (t) => {
  const run = await startMux(t);
  const first = await stopRuntime(run.receipt.muxId, { env: run.env, operationId: randomUUID() });
  assert.equal(first.state, "stopped");
  assert.equal(processIdentityStatus(run.piIdentity), "dead");
  const second = await stopRuntime(run.receipt.muxId, { env: run.env });
  assert.deepEqual(second, first);
  assert.equal(lookupClaim(run.sessionFile, run.isolation.options), undefined);
});

test("a relative host fails before a writer claim", async (t) => {
  const input = await prepared(t);
  await assert.rejects(startRuntime({ command: "pi", args: input.piArgs, env: input.env }), /absolute runtime executable/);
  assert.equal(lookupClaim(input.sessionFile, input.isolation.options), undefined);
});

test("a launch through an updated Pi attaches to the runtime still on its original host", { timeout: 20_000 }, async (t) => {
  const run = await startMux(t);
  const other = path.join(run.dir, "other-host");
  fs.mkdirSync(other, { mode: 0o700 });
  fs.writeFileSync(path.join(other, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "9.9.9" }));
  const command = path.join(other, "pi.js");
  fs.writeFileSync(command, `${fs.readFileSync(PI, "utf8")}\n// updated global host\n`, { mode: 0o700 });
  const attached = await startRuntime({ command, args: run.piArgs, cwd: run.dir, env: run.env });
  assert.equal(attached.outcome, "attached");
  assert.equal(attached.muxId, run.receipt.muxId);
  assert.equal(processIdentityStatus(run.piIdentity), "alive");
  assert.equal(listDiscovery(run.env.PIMUX_DIR!).length, 1);
});

test("attachment rejects missing or mismatched advertised owner process identity", { timeout: 20_000 }, async (t) => {
  const run = await startMux(t);
  const file = path.join(run.env.PIMUX_DIR!, `${run.receipt.muxId}.json`);
  const original = run.discovery()!;
  try {
    writeDiscovery(file, { ...original, piIdentity: null });
    await assert.rejects(startRuntime({ command: PI, args: run.piArgs, cwd: run.dir, env: run.env }), /no supported exact owner identity/);
    writeDiscovery(file, { ...original, ownerIdentity: { ...run.ownerIdentity, startTime: `${BigInt(run.ownerIdentity.startTime) + 1n}` } });
    await assert.rejects(startRuntime({ command: PI, args: run.piArgs, cwd: run.dir, env: run.env }), /no supported exact owner identity/);
  } finally { writeDiscovery(file, original); }
  await run.first.run("still exact owner");
});

test("a native TUI owner is refused rather than treated as an attachable RPC agent", async (t) => {
  const input = await prepared(t);
  const claim = acquireClaim(input.sessionFile, { id: "native-test", kind: "tui", wrapper: readProcessIdentity(process.pid)!, pi: null }, input.isolation.options);
  try { await assert.rejects(startRuntime({ command: PI, args: input.piArgs, cwd: input.dir, env: input.env }), /nonattachable tui/); }
  finally { releaseClaim(claim); }
});

test("managed existing-file replacement returns cancellation while another runtime owns the target", { timeout: 20_000 }, async (t) => {
  const run = await startMux(t);
  const target = path.join(run.isolation.sessions, "other.jsonl");
  const header = JSON.parse(fs.readFileSync(run.sessionFile, "utf8").split("\n")[0]!) as Record<string, unknown>;
  fs.writeFileSync(target, `${JSON.stringify({ ...header, id: randomUUID() })}\n`, { mode: 0o600 });
  const args = [...run.piArgs]; args[args.indexOf("--session") + 1] = target;
  const other = await startRuntime({ command: PI, args, cwd: run.dir, env: run.env });
  try {
    const response = await run.first.request({ type: "switch_session", sessionPath: target });
    assert.deepEqual(response.data, { cancelled: true });
    assert.equal(run.discovery()!.session!.file, run.sessionFile);
    await run.first.run("still original");
  } finally {
    await stopRuntime(other.muxId, { env: run.env });
    await until(() => !readProcessIdentity(other.pid), "second owned runtime exited");
  }
});

test("cancelling a provisional start cleans only its owned Pi and claims", { timeout: 20_000 }, async (t) => {
  const input = await prepared(t);
  const controller = new AbortController();
  const promise = startRuntime({ command: PI, args: [...input.piArgs, "-e", SLOW], cwd: input.dir, env: input.env, signal: controller.signal });
  // Register rejection before intentionally aborting, avoiding unhandled rejection.
  const rejected = assert.rejects(promise, /cancel|exited|failed|readiness/i);
  const owner = await until(() => listDiscovery(input.env.PIMUX_DIR!).find((entry) => entry.phase === "provisional" && entry.piIdentity), "provisional owned Pi");
  controller.abort(); await rejected;
  await until(() => processIdentityStatus(owner.ownerIdentity!) === "dead" && processIdentityStatus(owner.piIdentity!) === "dead", "cancelled startup exited", 15_000);
  assert.equal(lookupClaim(input.sessionFile, input.isolation.options), undefined);
});

test("required guard failure cannot commit readiness even when Pi starts", { timeout: 20_000 }, async (t) => {
  const input = await prepared(t);
  await assert.rejects(startRuntime({ command: PI, args: [...input.piArgs, "-e", BROKEN_GUARD], cwd: input.dir, env: input.env }), /ownership|guard|ready|exited|JSON/i);
  await until(() => listDiscovery(input.env.PIMUX_DIR!).length === 0, "failed safety startup removed discovery");
  assert.equal(lookupClaim(input.sessionFile, input.isolation.options), undefined);
});

test("detached workers cannot start without a parent process identity and task", { timeout: 20_000 }, async (t) => {
  const input = await prepared(t);
  await assert.rejects(startRuntime({ command: PI, args: input.piArgs, cwd: input.dir,
    env: { ...input.env, PI_ORCHESTRATION_PLACEMENT: "worker" } }), /live parent process identity and task ID/);
  assert.equal(lookupClaim(input.sessionFile, input.isolation.options), undefined);
});

test("wrong stop identity/protocol cannot signal the live runtime", { timeout: 20_000 }, async (t) => {
  const run = await startMux(t);
  for (const record of [
    { type: "pimux_stop", expectedMuxId: "wrong", operationId: randomUUID() },
    { type: "pimux_stop", expectedMuxId: run.receipt.muxId, operationId: randomUUID(), protocol: 1 },
  ]) {
    assert.equal((await run.first.request(record)).success, false);
    assert.equal(processIdentityStatus(run.piIdentity), "alive");
  }
  await run.first.run("still owned");
});

test("a caller-chosen launch operation is discoverable before its receipt and cannot be reused", { timeout: 20_000 }, async (t) => {
  const input = await prepared(t);
  const operationId = randomUUID();
  const child = spawn(process.execPath, [BIN, "start", "--json", "--operation-id", operationId, "--", PI, ...input.piArgs, "-e", SLOW],
    { cwd: input.dir, env: input.env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  let stdout = ""; let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  // The slow session start holds the launch provisional: no receipt exists yet.
  const provisional = await until(() => listDiscovery(input.env.PIMUX_DIR!).find((entry) => entry.phase === "provisional"), "provisional discovery");
  assert.equal(provisional.operationId, operationId);
  assert.equal(child.exitCode, null);
  assert.equal(stdout, "");
  assert.equal(await exited, 0, stderr);
  const receipt = JSON.parse(stdout) as RuntimeReceipt;
  assert.equal(receipt.outcome, "started");
  assert.equal(receipt.operationId, operationId);
  assert.equal(receipt.muxId, provisional.muxId);
  const refused = async (id: string): Promise<string> => {
    const launch = spawn(process.execPath, [BIN, "start", "--json", "--operation-id", id, "--", PI, ...input.piArgs],
      { cwd: input.dir, env: input.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; let error = "";
    launch.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    launch.stderr.setEncoding("utf8").on("data", (chunk: string) => { error += chunk; });
    assert.equal(await new Promise<number | null>((resolve, reject) => { launch.once("error", reject); launch.once("exit", resolve); }), 1);
    assert.equal(output, "");
    return error;
  };
  // The operation is retained while its runtime lives: a reused ID neither
  // starts nor attaches anything.
  assert.match(await refused(operationId), /Launch identity already used/);
  assert.match(await refused("not-a-uuid"), /--operation-id must be a new lowercase UUID/);
  assert.deepEqual(listDiscovery(input.env.PIMUX_DIR!).map((entry) => entry.muxId), [receipt.muxId]);
});

test("losing the initial launcher before commit cleans the provisional owner and Pi", { timeout: 20_000 }, async (t) => {
  const input = await prepared(t);
  const launcher = spawn(process.execPath, [BIN, "start", "--json", "--", PI, ...input.piArgs, "-e", SLOW], { cwd: input.dir, env: input.env, stdio: "ignore" });
  t.after(() => { if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill("SIGKILL"); });
  const owner = await until(() => listDiscovery(input.env.PIMUX_DIR!).find((entry) => entry.phase === "provisional" && entry.piIdentity), "launcher started owned Pi");
  launcher.kill("SIGKILL");
  await until(() => processIdentityStatus(owner.ownerIdentity!) === "dead" && processIdentityStatus(owner.piIdentity!) === "dead", "launcher-loss cleanup completed", 15_000);
  assert.equal(lookupClaim(input.sessionFile, input.isolation.options), undefined);
});
