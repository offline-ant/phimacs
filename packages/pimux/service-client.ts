/** Same-user service discovery. Only readiness is retried; launch is never replayed. */
import * as net from "node:net";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { muxDirectory } from "./discovery.ts";
import { LineSplitter } from "./jsonl.ts";
import { readPrivateJson } from "./private-files.ts";
import { processIdentityStatus, type ProcessIdentity, type ProcessIdentityStatus } from "./process-identity.ts";
import { isRecord } from "./protocol.ts";
import { validateSocket } from "./runtime-control.ts";
import { RuntimeOperationError, type RuntimeReceipt, type StartRuntimeOptions } from "./runtime.ts";
import { serviceStateDirectory, stateIdentityFile } from "./service-files.ts";

export const SERVICE_PROTOCOL = 1;
export function serviceSocket(env = process.env): string { return path.join(muxDirectory(env), "service.sock"); }
export const SERVICE_UNAVAILABLE = "pimux unavailable; start it with `phimacs` or its supervisor, then retry";

export interface ServiceAgent { muxId: string; placement: string; status: string; cwd: string | null }
export interface ServiceStatus {
  process: ProcessIdentity;
  /** PHIMACS_ROOT of the service environment: the checkout that started it, if any. */
  root: string | null;
  /** Durable identity of the state directory holding this service's journal. */
  stateId: string;
  /** An accepted stop is draining the service: no agent can start. */
  stopping: boolean;
  /** The stop operation in progress and the process that started it, if any. */
  stop: { operationId: string; committed: boolean; caller: ProcessIdentity } | null;
  pending: number;
  agents: ServiceAgent[];
  /** Journaled roots; `error` records a failed restoration. */
  roots: { muxId: string; cwd: string; sessionFile: string | null; error: string | null }[];
}
export interface ServiceGreeting {
  ready: boolean; stopping: boolean; root: string | null; stateId: string | null; process: ProcessIdentity | null;
}
export type ServiceProbe = { state: "absent" | "refused" | "unresponsive" } | { state: "answering"; greeting: ServiceGreeting };

/**
 * One bounded look at the service endpoint. It never retries, creates files or
 * starts a process. An unsafe socket or another protocol is an error.
 */
export async function probeService(env = process.env, timeoutMs = 1000): Promise<ServiceProbe> {
  const file = serviceSocket(env);
  try { validateSocket(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" }; throw error; }
  return await new Promise<ServiceProbe>((resolve, reject) => {
    const socket = net.connect(file);
    const finish = (result: ServiceProbe | Error): void => {
      clearTimeout(timer); socket.destroy();
      if (result instanceof Error) reject(result); else resolve(result);
    };
    const timer = setTimeout(() => finish({ state: "unresponsive" }), timeoutMs);
    const lines = new LineSplitter(line => {
      const record: unknown = JSON.parse(line);
      if (!isRecord(record) || record.type !== "pimux_service" || record.protocol !== SERVICE_PROTOCOL) finish(new Error("Unsupported pimux service protocol"));
      else finish({ state: "answering", greeting: { ready: record.ready === true, stopping: record.stopping === true,
        root: typeof record.root === "string" ? record.root : null, stateId: typeof record.stateId === "string" ? record.stateId : null,
        process: isRecord(record.process) ? record.process as unknown as ProcessIdentity : null } });
    }, 4096, () => finish(new Error("Invalid service greeting")));
    socket.on("data", (chunk: Buffer) => { try { lines.push(chunk); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); } });
    socket.once("error", (error: NodeJS.ErrnoException) => finish(error.code === "ECONNREFUSED" ? { state: "refused" } : error));
    socket.once("end", () => finish({ state: "unresponsive" }));
  });
}

/** The state identity this environment's journal directory carries; null before its first service. */
export function expectedStateId(env = process.env): string | null {
  return readPrivateJson<{ id: string }>(stateIdentityFile(serviceStateDirectory(env)))?.id ?? null;
}

export interface ServiceLease { process: ProcessIdentity; status: ProcessIdentityStatus }
/** The singleton leases a starting or running service holds: its state lease and its endpoint lease. */
export function serviceLeases(env = process.env): { service: ServiceLease | null; endpoint: ServiceLease | null } {
  const read = (file: string): ServiceLease | null => {
    const record = readPrivateJson<{ process: ProcessIdentity }>(file);
    return record ? { process: record.process, status: processIdentityStatus(record.process) } : null;
  };
  return { service: read(path.join(serviceStateDirectory(env), "service.json")),
    endpoint: read(path.join(muxDirectory(env), ".service.json")) };
}

/** Wait for a ready service, without creating directories or starting a process. */
async function ready(env: NodeJS.ProcessEnv, signal?: AbortSignal, timeoutMs = 10_000): Promise<net.Socket> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    signal?.throwIfAborted();
    try {
      const file = serviceSocket(env);
      validateSocket(file);
      return await new Promise<net.Socket>((resolve, reject) => {
        const socket = net.connect(file);
        const finish = (error?: Error): void => {
          clearTimeout(timer); signal?.removeEventListener("abort", aborted);
          socket.removeAllListeners("data"); socket.removeAllListeners("error"); socket.removeAllListeners("end");
          if (error) { socket.destroy(); reject(error); } else resolve(socket);
        };
        const aborted = (): void => finish(new Error("Service connection cancelled"));
        const timer = setTimeout(() => finish(new Error("Service not ready")), Math.max(1, Math.min(1000, deadline - performance.now())));
        const lines = new LineSplitter(line => {
          const record: unknown = JSON.parse(line);
          if (!isRecord(record) || record.type !== "pimux_service" || record.protocol !== SERVICE_PROTOCOL) finish(new Error("Unsupported pimux service protocol"));
          else if (record.ready === true) finish();
        }, 4096, () => finish(new Error("Invalid service greeting")));
        socket.on("data", (chunk: Buffer) => { try { lines.push(chunk); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); } });
        socket.once("error", finish); socket.once("end", () => finish(new Error("Service disconnected")));
        signal?.addEventListener("abort", aborted, { once: true });
        if (signal?.aborted) aborted();
      });
    } catch (error) {
      signal?.throwIfAborted();
      const code = (error as NodeJS.ErrnoException).code;
      // Unsafe files and protocol failures are not transient unavailability.
      if (code !== "ENOENT" && code !== "ECONNREFUSED" && !(error instanceof Error && ["Service not ready", "Service disconnected"].includes(error.message))) throw error;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error(SERVICE_UNAVAILABLE);
      await delay(Math.min(100, remaining), undefined, { signal });
    }
  }
}

export async function serviceRequest(request: Record<string, unknown>, options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal; availabilityMs?: number; timeoutMs?: number } = {}): Promise<unknown> {
  const socket = await ready(options.env ?? process.env, options.signal, options.availabilityMs);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: unknown): void => {
      if (settled) return;
      settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", aborted); socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const aborted = (): void => finish(new Error("Service request cancelled; reconcile before retrying"));
    const timer = setTimeout(() => finish(new Error("Service request outcome uncertain; no launch was replayed")), options.timeoutMs ?? 40_000);
    const lines = new LineSplitter(line => {
      const response: unknown = JSON.parse(line);
      if (!isRecord(response) || response.type !== "service_response") return finish(new Error("Invalid service response"));
      if (response.success !== true) {
        const message = String(response.error ?? "Service request failed");
        finish(typeof response.operationId === "string" && typeof response.muxId === "string"
          ? new RuntimeOperationError(message, response.operationId, response.muxId) : new Error(message));
      } else finish(undefined, response.data);
    }, 4 * 1024 * 1024, () => finish(new Error("Service response exceeds bound")));
    socket.on("data", (chunk: Buffer) => { try { lines.push(chunk); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); } });
    socket.once("error", finish);
    socket.once("end", () => finish(new Error("Service disconnected; outcome uncertain, no launch was replayed")));
    options.signal?.addEventListener("abort", aborted, { once: true });
    if (options.signal?.aborted) aborted();
    else socket.write(`${JSON.stringify(request)}\n`);
  });
}

export async function requestStart(options: StartRuntimeOptions): Promise<RuntimeReceipt> {
  const operationId = options.operationId ?? randomUUID();
  const muxId = randomUUID();
  try {
    return await serviceRequest({ type: "start", operationId, muxId, command: options.command, args: options.args,
      cwd: path.resolve(options.cwd ?? process.cwd()), env: options.env ?? process.env, parent: options.parent,
      timeoutMs: options.timeoutMs }, options) as RuntimeReceipt;
  } catch (error) {
    if (error instanceof RuntimeOperationError) throw error;
    throw new RuntimeOperationError(error instanceof Error ? error.message : String(error), operationId, muxId);
  }
}

export async function serviceStatus(env = process.env, availabilityMs = 1000): Promise<ServiceStatus> {
  return await serviceRequest({ type: "status" }, { env, availabilityMs, timeoutMs: 5000 }) as ServiceStatus;
}

export interface StopOperation {
  /** The exact service process every phase is bound to. */
  service: ProcessIdentity;
  /** Chosen by the caller; only this operation's commit or resume acts on it. */
  operationId: string;
  /** The calling process. Its operation is recoverable by others only once it is proven dead. */
  caller: ProcessIdentity;
  force: boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * `drain` refuses busy, starting or unrestorable agents unless forced, stops new
 * agents and (unforced) closes every agent's frontend input before the idle check.
 * `commit` checks again; with `exit` the service then shuts down, otherwise its
 * supervisor ends it. Idle roots stay journaled and are restored idle. Repeating
 * a phase of the same operation reconciles a lost reply.
 */
export async function stopService(operation: StopOperation & { phase: "drain" | "commit"; exit: boolean }): Promise<ServiceStatus> {
  return await serviceRequest({ type: "stop", service: operation.service, operationId: operation.operationId,
    caller: operation.caller, force: operation.force, phase: operation.phase, exit: operation.exit },
  { env: operation.env, availabilityMs: 1000, timeoutMs: 30_000 }) as ServiceStatus;
}

/**
 * Undo this operation's uncommitted or supervisor-pending stop. Another operation
 * is undone only when its caller is proven dead; a live caller's is untouched.
 */
export async function resumeService(operation: Omit<StopOperation, "force">): Promise<ServiceStatus & { resumed: boolean }> {
  return await serviceRequest({ type: "resume", service: operation.service, operationId: operation.operationId, caller: operation.caller },
    { env: operation.env, availabilityMs: 1000, timeoutMs: 30_000 }) as ServiceStatus & { resumed: boolean };
}

/** Resolve only service-recorded successors. This never launches or resumes an agent. */
export async function resolveRuntime(muxId: string, env = process.env, signal?: AbortSignal): Promise<RuntimeReceipt | null> {
  return await serviceRequest({ type: "resolve", muxId }, { env, signal }) as RuntimeReceipt | null;
}
