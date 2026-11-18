import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { type DiscoveryRecord, readDiscovery } from "../discovery.ts";
import { LineSplitter } from "../jsonl.ts";
import { createClaimTestEnvironment, type ClaimTestEnvironment } from "../ownership.ts";
import { processIdentityStatus, readProcessIdentity, type ProcessIdentity } from "../process-identity.ts";
import { startRuntime, stopRuntime, type ParentTask, type RuntimeReceipt } from "../runtime.ts";
import { isReadOnlyCommand, parseInputContext, type JsonRecord } from "../protocol.ts";

export const BIN = fileURLToPath(new URL("../bin/pimux", import.meta.url));
export const PI = fs.realpathSync.native(fileURLToPath(new URL("../../../node_modules/.bin/pi", import.meta.url)));
const FIXTURE = fileURLToPath(new URL("../../../test/support/faux.ts", import.meta.url));

export async function until<T>(check: () => T | undefined | false, description: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    assert.ok(Date.now() < deadline, `Timed out: ${description}`);
    await delay(20);
  }
}

export function alive(pid: number): boolean {
  try { return readProcessIdentity(pid) !== undefined; } catch { return true; }
}

export class Peer {
  records: JsonRecord[] = [];
  private nextId = 0;
  private readonly write: (line: string) => void;
  constructor(write: (line: string) => void) { this.write = write; }
  readonly splitter = new LineSplitter((line) => this.records.push(JSON.parse(line) as JsonRecord), 128 * 1024 * 1024, () => {});
  send(record: JsonRecord): void {
    // Test actions capture the last authoritative branch anchor. Tests of raw
    // malformed/pre-boundary input write directly to their owned socket.
    const snapshot = this.records.findLast((received) => received.type === "pimux_snapshot");
    const context = parseInputContext(snapshot?.inputContext);
    const command = typeof record.type === "string" && !record.type.startsWith("pimux_")
      && !isReadOnlyCommand(record.type) && !("pimuxContext" in record) && context
      ? { ...record, pimuxContext: context } : record;
    this.write(`${JSON.stringify(command)}\n`);
  }
  mark(): number { return this.records.length; }
  waitFor(match: (record: JsonRecord) => boolean, description: string, after = 0, timeoutMs?: number): Promise<JsonRecord> {
    return until(() => this.records.slice(after).find(match), description, timeoutMs);
  }
  after(index: number, match: (record: JsonRecord) => boolean): JsonRecord[] { return this.records.slice(index).filter(match); }
  async request(record: JsonRecord): Promise<JsonRecord> {
    const id = `req-${++this.nextId}`;
    this.send({ ...record, id });
    const response = await this.waitFor((received) => received.type === "response" && received.id === id, `response to ${String(record.type)}`);
    if (response.success === true && (["new_session", "switch_session", "fork", "clone", "navigate_tree"].includes(String(record.type))
      || (record.type === "prompt" && typeof record.message === "string" && record.message.trimStart().startsWith("/")))) {
      const responseIndex = this.records.indexOf(response);
      const snapshot = await this.waitFor((received) => received.type === "pimux_snapshot" && received.reason === "request", "post-action context boundary", responseIndex + 1);
      await this.waitFor((received) => received.type === "pimux_live" && received.generation === snapshot.generation, "post-action live boundary", responseIndex + 1);
    }
    return response;
  }
  async run(message: string): Promise<void> {
    const start = this.mark();
    const response = await this.request({ type: "prompt", message });
    assert.equal(response.success, true, String(response.error));
    await this.waitFor((record) => record.type === "agent_settled", `settle after ${message}`, start);
  }
}
export type SocketPeer = Peer & { socket: net.Socket };
export async function connectPeer(receipt: RuntimeReceipt): Promise<SocketPeer> {
  const socket = net.connect(receipt.socket);
  const peer = Object.assign(new Peer((line) => socket.write(line)), { socket });
  socket.on("error", () => {});
  socket.on("data", (chunk: Buffer) => peer.splitter.push(chunk));
  await peer.waitFor((record) => record.type === "pimux_live", "socket snapshot/live boundary", 0, 30_000);
  const hello = peer.records[0]!;
  assert.equal(hello.protocol, 2);
  assert.equal(hello.muxId, receipt.muxId);
  assert.equal("role" in hello, false);
  return peer;
}

export interface Prepared {
  dir: string; sessionFile: string; env: NodeJS.ProcessEnv; piArgs: string[]; isolation: ClaimTestEnvironment;
}
export function prepare(entries = 0): Prepared {
  const isolation = createClaimTestEnvironment();
  const dir = isolation.root;
  const agentDir = path.join(dir, "agent");
  const home = path.join(dir, "home");
  const temporary = path.join(dir, "tmp");
  for (const folder of [agentDir, home, temporary]) fs.mkdirSync(folder, { mode: 0o700 });
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "fx", defaultModel: "one", compaction: { enabled: false }, retry: { enabled: false },
  }), { mode: 0o600 });
  const sessionFile = path.join(isolation.sessions, "session.jsonl");
  const header = { type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd: dir };
  fs.writeFileSync(sessionFile, [header, ...linearEntries(entries)].map((record) => `${JSON.stringify(record)}\n`).join(""), { mode: 0o600 });
  // Only explicit selections: a caller's live state, service, provider or desktop variables never leak in.
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", ...isolation.env, HOME: home, TMPDIR: temporary,
    PHIMACS_STATE_DIR: path.join(dir, "state"), XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_DATA_HOME: path.join(home, ".local/share"), XDG_STATE_HOME: path.join(home, ".local/state"), XDG_RUNTIME_DIR: temporary,
    PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: isolation.sessions, PI_NESTED: "" };
  return { dir, sessionFile, env, isolation, piArgs: ["--mode", "rpc", "--session", sessionFile,
    "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--provider", "fx", "--model", "one", "-e", FIXTURE] };
}
function linearEntries(count: number): JsonRecord[] {
  const timestamp = new Date().toISOString();
  return Array.from({ length: count }, (_, index) => {
    const message = index % 2 === 0
      ? { role: "user", content: [{ type: "text", text: `question ${index}` }], timestamp: 1 }
      : { role: "assistant", content: [{ type: "text", text: `answer ${index}` }], api: "fx", provider: "fx", model: "one",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1 };
    return { type: "message", id: `e${index}`, parentId: index ? `e${index - 1}` : null, timestamp, message };
  });
}

/**
 * Resolve when a just-spawned `pimux serve` announces readiness on its piped stdout.
 * A client started earlier can outlast its bounded availability wait on a loaded
 * machine. Rejects with the service's stderr if it exits first or stays unready.
 */
export function serviceReady(service: ChildProcess, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let announced = "";
    let diagnostic = "";
    const output = (chunk: Buffer) => {
      announced += chunk.toString("utf8");
      if (announced.includes("pimux service ready\n")) settle();
    };
    const error = (chunk: Buffer) => { diagnostic += chunk.toString("utf8"); };
    const exit = (code: number | null, signal: NodeJS.Signals | null) =>
      settle(new Error(`pimux service exited (${code ?? signal}) before readiness: ${diagnostic}`));
    const timer = setTimeout(() => settle(new Error(`pimux service not ready within ${timeoutMs} ms: ${diagnostic}`)), timeoutMs);
    function settle(failure?: Error) {
      clearTimeout(timer);
      service.stdout!.off("data", output);
      service.stderr!.off("data", error);
      service.off("exit", exit);
      service.stdout!.resume();
      if (failure) reject(failure); else resolve();
    }
    service.stdout!.on("data", output);
    service.stderr!.on("data", error);
    service.once("exit", exit);
  });
}

/** An owned `pimux serve`, returned once ready and stopped after the test. */
export async function startTestService(t: TestContext, input: Pick<Prepared, "dir" | "env">, env = input.env): Promise<ChildProcess> {
  const child = spawn(process.execPath, [BIN, "serve"], { cwd: input.dir, env, stdio: ["ignore", "pipe", "pipe"] });
  let diagnostic = "";
  child.stderr!.on("data", chunk => { diagnostic += chunk.toString(); });
  child.on("error", error => { diagnostic += String(error); });
  const ready = serviceReady(child);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await until(() => child.exitCode !== null || child.signalCode !== null, `test service stopped: ${diagnostic}`, 15_000);
  });
  await ready;
  return child;
}

export interface MuxRun extends Prepared {
  first: SocketPeer; receipt: RuntimeReceipt; ownerIdentity: ProcessIdentity; piIdentity: ProcessIdentity;
  discovery(): DiscoveryRecord | undefined; connect(): Promise<SocketPeer>; stop(): Promise<void>;
}
export async function startMux(t: TestContext, options: { env?: Record<string, string>; entries?: number; parent?: ParentTask; extensions?: readonly string[] } = {}): Promise<MuxRun> {
  const prepared = prepare(options.entries);
  for (const extension of options.extensions ?? []) prepared.piArgs.push("-e", extension);
  const env = { ...prepared.env, ...options.env };
  await startTestService(t, prepared, env);
  const parent = options.parent ?? (env.PI_ORCHESTRATION_PLACEMENT === "worker" ? { process: readProcessIdentity(process.pid)!, taskId: randomUUID() } : undefined);
  let receipt: RuntimeReceipt;
  try { receipt = await startRuntime({ command: PI, args: prepared.piArgs, cwd: prepared.dir, env, ...parent ? { parent } : {} }); }
  catch (error) {
    const logs = path.join(prepared.dir, "mux", "logs");
    const diagnostics = fs.existsSync(logs) ? fs.readdirSync(logs).map((name) => fs.readFileSync(path.join(logs, name), "utf8")).join("\n") : "";
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${diagnostics}`);
  }
  const ownerIdentity = readProcessIdentity(receipt.pid)!;
  const piIdentity = readProcessIdentity(receipt.piPid)!;
  const sockets = new Set<net.Socket>();
  const connect = async (): Promise<SocketPeer> => { const peer = await connectPeer(receipt); sockets.add(peer.socket); return peer; };
  const stop = async (): Promise<void> => {
    for (const socket of sockets) socket.destroy();
    if (processIdentityStatus(ownerIdentity) === "alive") await stopRuntime(receipt.muxId, { env });
    await until(() => processIdentityStatus(ownerIdentity) === "dead" && processIdentityStatus(piIdentity) === "dead", "owned runtime and Pi exited", 15_000);
  };
  t.after(async () => { await stop(); fs.rmSync(prepared.dir, { recursive: true, force: true }); });
  const first = await connect();
  return { ...prepared, env, first, receipt, ownerIdentity, piIdentity, connect, stop,
    discovery: () => readDiscovery(path.join(env.PIMUX_DIR!, `${receipt.muxId}.json`)) };
}
