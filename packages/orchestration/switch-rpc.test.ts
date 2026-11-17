import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createClaimTestEnvironment, lookupClaim } from "@phimacs/pimux/ownership";
import { startRuntime, stopRuntime, type RuntimeReceipt } from "@phimacs/pimux/runtime";
import { LineSplitter } from "@phimacs/pimux/jsonl";
import { startTestService } from "../pimux/test/harness.ts";
import { isReadOnlyCommand, parseInputContext, type InputContext } from "@phimacs/pimux/protocol";
import { processIdentityStatus, readProcessIdentity } from "@phimacs/pimux/process-identity";

async function until(check: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!check()) { assert.ok(Date.now() < deadline, `Timed out: ${description}`); await delay(20); }
}
async function attach(receipt: RuntimeReceipt) {
  const socket = net.connect(receipt.socket);
  const records: Record<string, unknown>[] = [];
  socket.on("error", () => {});
  let context: InputContext | undefined;
  const splitter = new LineSplitter(line => {
    const record = JSON.parse(line) as Record<string, unknown>;
    if (record.type === "pimux_snapshot") context = parseInputContext(record.inputContext);
    records.push(record);
  }, 128 * 1024 * 1024, () => {});
  socket.on("data", (chunk: Buffer) => splitter.push(chunk));
  await until(() => records.some(record => record.type === "pimux_live"), "socket snapshot/live");
  return { socket, records, send: (record: Record<string, unknown>) => {
    const mutates = typeof record.type !== "string" || !isReadOnlyCommand(record.type);
    if (mutates) assert.ok(context, "authoritative socket input context");
    socket.write(`${JSON.stringify({ ...record, ...(mutates ? { pimuxContext: context } : {}) })}\n`);
  } };
}

test("real managed RPC switch retains one writer through delayed attachment and all-client detach", { timeout: 20_000 }, async (t) => {
  const isolation = createClaimTestEnvironment();
  const directory = isolation.root;
  const agentDir = path.join(directory, "agent");
  const home = path.join(directory, "home");
  const temporary = path.join(directory, "tmp");
  for (const dir of [agentDir, home, temporary]) fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "switch-rpc-fixture", defaultModel: "one", compaction: { enabled: false }, retry: { enabled: false } }));
  const sessionFile = path.join(isolation.sessions, "original.jsonl");
  fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd: directory })}\n`, { mode: 0o600 });
  const fixture = fileURLToPath(new URL("./test/switch-rpc-fixture.ts", import.meta.url));
  const command = fs.realpathSync(fileURLToPath(new URL("../../node_modules/.bin/pi", import.meta.url)));
  const env: NodeJS.ProcessEnv = { ...process.env, ...isolation.env, HOME: home, TMPDIR: temporary, PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: isolation.sessions };
  for (const key of Object.keys(env)) if (key.startsWith("PI_ORCHESTRATION_") || key.startsWith("PHIMACS_PARENT_") || key === "PHIMACS_MANAGED_CLAIM" || key === "PIMUX_DISCOVERY" || key === "PI_REMOTE" || key === "PI_NESTED") delete env[key];
  await startTestService(t, { dir: directory, env });
  let receipt: RuntimeReceipt | undefined;
  const sockets: net.Socket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (receipt) await stopRuntime(receipt.muxId, { env });
    fs.rmSync(directory, { recursive: true, force: true });
  });
  receipt = await startRuntime({ command, cwd: directory, env, args: ["--mode", "rpc", "--session", sessionFile,
    "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--provider", "switch-rpc-fixture", "--model", "one", "-e", fixture] });
  const piIdentity = readProcessIdentity(receipt.piPid)!;
  const traces = (): Array<{ event: string; muxId?: string }> => {
    const file = path.join(directory, "trace.jsonl");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { event: string; muxId?: string }) : [];
  };
  const first = await attach(receipt); sockets.push(first.socket);
  const bytes = fs.readFileSync(sessionFile, "utf8");
  const capability = lookupClaim(sessionFile, isolation.options)!.token;
  first.send({ id: "switch", type: "prompt", message: "/switch emacs" });
  await until(() => traces().some(entry => entry.event === "destination-start"), "destination attachment pending");
  first.socket.destroy();
  assert.equal(processIdentityStatus(piIdentity), "alive");
  assert.equal(lookupClaim(sessionFile, isolation.options)!.token, capability);
  fs.writeFileSync(path.join(directory, "release"), "ready");
  await until(() => traces().some(entry => entry.event === "destination-ready"), "detached pending attachment completed");
  const second = await attach(receipt); sockets.push(second.socket);
  second.send({ id: "state", type: "get_state" });
  await until(() => second.records.some(record => record.id === "state"), "same runtime still answers");
  assert.deepEqual(traces().map(entry => entry.event), ["start", "destination-start", "destination-ready"]);
  assert.equal(traces()[1]!.muxId, receipt.muxId);
  assert.equal(fs.readFileSync(sessionFile, "utf8"), bytes);
  assert.equal(lookupClaim(sessionFile, isolation.options)!.token, capability);
  second.send({ id: "herdr", type: "prompt", message: "/switch herdr" });
  await until(() => second.records.some(record => record.type === "extension_ui_request" && typeof record.message === "string" && record.message.includes("No claim was released")), "Herdr switch refusal");
  assert.equal(processIdentityStatus(piIdentity), "alive");
  assert.equal(lookupClaim(sessionFile, isolation.options)!.token, capability);
  assert.equal(fs.readFileSync(sessionFile, "utf8"), bytes);
  assert.ok(!traces().some(entry => entry.event === "unexpected-inference"));
});
