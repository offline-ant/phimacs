import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { listDiscovery } from "./discovery.ts";
import { lookupClaim } from "./ownership.ts";
import { processIdentityStatus, readProcessIdentity, type ProcessIdentity } from "./process-identity.ts";
import { stopRuntime } from "./runtime.ts";
import { type MuxRun, startMux, until } from "./test/harness.ts";

async function runningTool(run: MuxRun): Promise<ProcessIdentity> {
  run.first.send({ type: "prompt", message: "tool" });
  const pidFile = path.join(run.dir, "tool.pid");
  const tool = await until(() => {
    const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, "utf8")) : NaN;
    return Number.isInteger(pid) && pid > 0 ? readProcessIdentity(pid) : undefined;
  }, "faux bash tool started");
  // The owner captures tool groups before forwarding each Pi output chunk, so an
  // update carrying the tool's own output proves the running tool was observed.
  await run.first.waitFor((record) => record.type === "tool_execution_update" && JSON.stringify(record.partialResult ?? null).includes("tick"), "tool streams output");
  assert.equal(processIdentityStatus(tool), "alive");
  return tool;
}
function signalOwned(identity: ProcessIdentity, signal: NodeJS.Signals): void {
  assert.equal(processIdentityStatus(identity), "alive", "signal only this test's exact live owner");
  process.kill(identity.pid, signal);
}

test("all clients can disconnect during work; explicit stop ends the owned Pi and tool", { timeout: 60_000 }, async (t) => {
  const run = await startMux(t);
  const other = await run.connect();
  const tool = await runningTool(run);
  run.first.socket.destroy(); other.socket.destroy();
  await until(() => run.discovery()?.status === "working", "zero-client runtime keeps draining work");
  assert.equal(processIdentityStatus(run.ownerIdentity), "alive");
  assert.equal(processIdentityStatus(run.piIdentity), "alive");
  assert.equal(processIdentityStatus(tool), "alive");
  const reconnected = await run.connect();
  assert.ok(reconnected.records.some((record) => record.type === "tool_execution_start"));
  const stopped = await stopRuntime(run.receipt.muxId, { env: run.env });
  assert.equal(stopped.state, "stopped");
  await until(() => processIdentityStatus(tool) === "dead", "owned tool exited");
  await run.stop();
  assert.deepEqual(listDiscovery(run.env.PIMUX_DIR!), []);
  assert.equal(lookupClaim(run.sessionFile, run.isolation.options), undefined);
});

test("TERM of the detached owner stops its Pi and tool without frontend authority", { timeout: 60_000 }, async (t) => {
  const run = await startMux(t);
  const tool = await runningTool(run);
  signalOwned(run.ownerIdentity, "SIGTERM");
  await until(() => processIdentityStatus(run.ownerIdentity) === "dead" && processIdentityStatus(run.piIdentity) === "dead" && processIdentityStatus(tool) === "dead", "owner, Pi and tool exited");
});

test("a SIGKILLed mux leaves no idle Pi, active tool or discovery entry", { timeout: 60_000 }, async (t) => {
  const run = await startMux(t);
  const other = await run.connect();
  const tool = await runningTool(run);
  signalOwned(run.ownerIdentity, "SIGKILL");
  await until(() => processIdentityStatus(run.ownerIdentity) === "dead" && processIdentityStatus(run.piIdentity) === "dead" && processIdentityStatus(tool) === "dead", "orphan guard cleaned Pi and tool", 15_000);
  assert.equal(other.records.some((record) => record.type === "pimux_exit"), false);
  assert.deepEqual(listDiscovery(run.env.PIMUX_DIR!), []);
  assert.equal(lookupClaim(run.sessionFile, run.isolation.options), undefined);
});

test("a Pi crash ends the owner, releases ownership and cleans observed tool groups", { timeout: 60_000 }, async (t) => {
  const run = await startMux(t);
  const tool = await runningTool(run);
  signalOwned(run.piIdentity, "SIGKILL");
  const exit = await run.first.waitFor((record) => record.type === "pimux_exit", "Pi crash announcement");
  assert.equal(exit.signal, "SIGKILL");
  await until(() => processIdentityStatus(tool) === "dead", "identity-proven tool group was cleaned");
  await run.stop();
  assert.equal(lookupClaim(run.sessionFile, run.isolation.options), undefined);
});

test("worker runtime remains task-owned and stops on verified parent death", { timeout: 60_000 }, async (t) => {
  const parent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await new Promise<void>((resolve, reject) => { parent.once("spawn", resolve); parent.once("error", reject); });
  const identity = readProcessIdentity(parent.pid!)!;
  t.after(() => { if (processIdentityStatus(identity) === "alive") parent.kill("SIGKILL"); });
  const run = await startMux(t, { env: { PI_ORCHESTRATION_PLACEMENT: "worker" }, parent: { process: identity, taskId: "synthetic-task" } });
  run.first.socket.destroy();
  assert.equal(processIdentityStatus(run.piIdentity), "alive", "view loss does not promote or end the task");
  parent.kill("SIGTERM");
  await until(() => processIdentityStatus(identity) === "dead" && processIdentityStatus(run.piIdentity) === "dead" && processIdentityStatus(run.ownerIdentity) === "dead", "dead parent ended its subordinate runtime");
});
