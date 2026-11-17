/** Service client and identity-bound runtime attachment. */
import * as net from "node:net";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readDiscovery } from "./discovery.ts";
import { validateSocket } from "./runtime-control.ts";
import { canonicalSessionPath, lookupClaim, type ClaimHandle, type ClaimOptions, type ClaimRecord } from "./ownership.ts";
import { processIdentityStatus, sameProcessIdentity, type ProcessIdentity } from "./process-identity.ts";
import type { HostIdentity } from "./host-identity.ts";
import { requestStart } from "./service-client.ts";
import { LineSplitter } from "./jsonl.ts";
import { isRecord, PROTOCOL_VERSION } from "./protocol.ts";
import { runtimePaths } from "./runtime-files.ts";
import { readPrivateJson } from "./private-files.ts";

export { validateSocket, listRuntimes, lookupRuntime, lookupTerminalReceipt, stopRuntime } from "./runtime-control.ts";

export interface RuntimeReceipt {
  protocol: 2;
  operationId: string;
  muxId: string;
  socket: string;
  pid: number;
  piPid: number;
  service?: ProcessIdentity;
  sessionFile: string;
  state: "committed";
  outcome: "started" | "attached";
}
export interface TerminalReceipt {
  protocol: 2;
  muxId: string;
  operationId: string;
  state: "stopped";
  service?: ProcessIdentity;
  /** Durable explicit root Close, distinct from an ended Pi process. */
  rootClosed?: boolean;
  placement?: "root" | "worker" | "interactive-fork";
  code: number | null;
  signal: string | null;
  stoppedAt: string;
}
export interface ParentTask { process: ProcessIdentity; taskId: string }
export interface StartRuntimeOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  parent?: ParentTask;
  /** The caller's new launch operation UUID; discovery publishes it from the provisional phase on. */
  operationId?: string;
}
export interface RuntimeInitialization {
  type: "initialize";
  operationId: string;
  muxId: string;
  claim: ClaimHandle;
  command: string;
  args: string[];
  cwd: string;
  host: HostIdentity;
  service: ProcessIdentity;
  serviceStateDirectory: string;
  parent?: ParentTask;
}
export interface OperationRecord {
  protocol: 2;
  operationId: string;
  muxId: string;
  state: "provisional" | "ready" | "committed" | "failed";
  receipt?: RuntimeReceipt;
  error?: string;
}
export class RuntimeOperationError extends Error {
  readonly operationId: string;
  readonly muxId: string;
  constructor(message: string, operationId: string, muxId: string) { super(message); this.operationId = operationId; this.muxId = muxId; }
}

function optionsFor(env: NodeJS.ProcessEnv): ClaimOptions { return env.PHIMACS_TEST_ROOT ? { testRoot: env.PHIMACS_TEST_ROOT } : {}; }

// Attachment checks the exact owner identity, not the Pi bytes: a running
// runtime keeps the host it started with across global Pi updates.
function verifyAttachment(file: string, owner: ClaimRecord["owner"]): void {
  const discovery = readDiscovery(file);
  if (!discovery || discovery.protocol !== PROTOCOL_VERSION || discovery.phase !== "committed"
    || discovery.muxId !== owner.id || discovery.socket !== owner.socket || discovery.operationId !== owner.operationId
    || !discovery.ownerIdentity || !sameProcessIdentity(discovery.ownerIdentity, owner.wrapper)
    || !owner.pi || !discovery.piIdentity || !sameProcessIdentity(discovery.piIdentity, owner.pi)) {
    throw new Error("Existing runtime has no supported exact owner identity; attachment refused");
  }
}

export async function attachExisting(claim: ClaimRecord, env: NodeJS.ProcessEnv, timeoutMs: number, signal?: AbortSignal): Promise<RuntimeReceipt> {
  const owner = claim.owner;
  if (owner.kind !== "rpc" || owner.protocol !== PROTOCOL_VERSION || !owner.socket || !owner.operationId) {
    throw new Error(`Session is owned by a nonattachable ${owner.kind} runtime; no replacement writer was started`);
  }
  const files = runtimePaths(owner.id, owner.operationId, { ...env, PIMUX_DIR: path.dirname(owner.socket) });
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    signal?.throwIfAborted();
    // The same capability transfers launcher -> detached owner without a gap.
    // Re-read that capability instead of treating the now-exited launcher as
    // the permanent owner during a concurrent attachment.
    const current = lookupClaim(claim.file, optionsFor(env));
    if (!current || current.token !== claim.token || current.owner.id !== owner.id
      || processIdentityStatus(current.owner.wrapper) !== "alive") throw new Error("Runtime owner is dead or uncertain; reconcile ownership before starting again");
    const operation = readPrivateJson<OperationRecord>(files.operation);
    if (operation?.state === "failed") throw new Error(operation.error ?? "Existing runtime startup failed");
    if (operation?.state === "committed" && operation.receipt) {
      verifyAttachment(files.discovery, current.owner);
      await verifyRuntimeConnection(operation.receipt, timeoutMs, signal, claim.file);
      verifyAttachment(files.discovery, current.owner);
      return { ...operation.receipt, sessionFile: claim.file, outcome: "attached" };
    }
    await delay(20, undefined, { signal });
  }
  throw new RuntimeOperationError("Existing runtime is still provisional; no second writer was started", owner.operationId, owner.id);
}

/** Handshake and full snapshot/live boundary, with no prompt, are the attachment readiness test. */
export function verifyRuntimeConnection(receipt: RuntimeReceipt, timeoutMs = 30_000, signal?: AbortSignal, expectedSessionFile = receipt.sessionFile): Promise<void> {
  validateSocket(receipt.socket);
  return new Promise((resolve, reject) => {
    const socket = net.connect(receipt.socket);
    let hello = false;
    let snapshot: { generation: number; file: string } | undefined;
    const timer = setTimeout(() => finish(new Error("Runtime attachment did not reach pimux_live")), timeoutMs);
    const aborted = (): void => finish(new Error("Runtime attachment cancelled"));
    const finish = (error?: Error): void => {
      clearTimeout(timer); signal?.removeEventListener("abort", aborted); socket.destroy();
      if (error) reject(error); else resolve();
    };
    const lines = new LineSplitter((line) => {
      let record: unknown;
      try { record = JSON.parse(line); } catch { finish(new Error("Invalid runtime handshake")); return; }
      if (!isRecord(record)) return;
      if (record.type === "pimux_hello") {
        if (record.protocol !== PROTOCOL_VERSION || record.muxId !== receipt.muxId || record.piPid !== receipt.piPid) finish(new Error("Runtime identity/protocol mismatch"));
        else hello = true;
      } else if (record.type === "pimux_snapshot" && hello && typeof record.generation === "number" && isRecord(record.session) && typeof record.session.file === "string") {
        snapshot = { generation: record.generation, file: record.session.file };
      } else if (record.type === "pimux_live" && hello && snapshot && record.generation === snapshot.generation) {
        if (canonicalSessionPath(snapshot.file) !== canonicalSessionPath(expectedSessionFile)) {
          finish(new Error("Requested file is retained by a runtime now serving another conversation; no second writer was started"));
        } else finish();
      }
      else if (record.type === "pimux_snapshot_failed" || record.type === "pimux_exit") finish(new Error("Runtime is not snapshot-ready"));
    }, 128 * 1024 * 1024, () => finish(new Error("Runtime handshake exceeds its bound")));
    socket.on("data", (chunk: Buffer) => lines.push(chunk));
    socket.once("error", finish);
    socket.once("end", () => finish(new Error("Runtime disconnected before readiness")));
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

/** Clients never spawn an owner or autostart the service. */
export async function startRuntime(options: StartRuntimeOptions): Promise<RuntimeReceipt> {
  return requestStart(options);
}
export { resolveRuntime } from "./service-client.ts";
