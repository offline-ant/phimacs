/** Internal service-owned launch. Never called by frontends. */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireClaim, releaseClaim, ClaimConflictError, type ClaimHandle } from "./ownership.ts";
import { readProcessIdentity } from "./process-identity.ts";
import { exactSessionArgs, servesRpc } from "./host.ts";
import { verifyHost } from "./host-identity.ts";
import { isRecord, PROTOCOL_VERSION } from "./protocol.ts";
import { runtimePaths } from "./runtime-files.ts";
import { readPrivateJson, writePrivateJson } from "./private-files.ts";
import { attachExisting, RuntimeOperationError, type RuntimeReceipt, type RuntimeInitialization, type StartRuntimeOptions, type OperationRecord } from "./runtime.ts";

export interface LaunchObserver {
  stateDirectory: string;
  ownsRuntime(muxId: string): boolean;
  spawned(child: ChildProcess, input: RuntimeInitialization): void;
  ready(input: RuntimeInitialization): void;
}
const optionsFor = (env: NodeJS.ProcessEnv) => env.PHIMACS_TEST_ROOT ? { testRoot: env.PHIMACS_TEST_ROOT } : {};

export async function launchRuntime(options: StartRuntimeOptions, observer: LaunchObserver, operation?: { muxId: string; operationId: string }): Promise<RuntimeReceipt> {
  const env = options.env ?? process.env;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  options.signal?.throwIfAborted();
  const host = verifyHost(options.command);
  if (!servesRpc(options.args)) throw new Error("pimux start requires a serving --mode rpc invocation");
  const selected = exactSessionArgs(options.args, cwd, env);
  const muxId = operation?.muxId ?? randomUUID();
  const operationId = operation?.operationId ?? randomUUID();
  const files = runtimePaths(muxId, operationId, env);
  if (readPrivateJson(files.operation) || readPrivateJson(files.receipt)) throw new Error("Launch identity already used; reconcile instead of replaying");
  const launcher = readProcessIdentity(process.pid);
  if (!launcher) throw new Error("Cannot establish launcher identity");
  let claim: ClaimHandle;
  try {
    claim = acquireClaim(selected.file, { id: muxId, kind: "rpc", wrapper: launcher, pi: null, protocol: PROTOCOL_VERSION, socket: files.socket, operationId }, optionsFor(env));
  } catch (error) {
    if (error instanceof ClaimConflictError && error.code === "CLAIM_CONFLICT") {
      const existing = error.claim.owner;
      if (existing.kind === "rpc" && !observer.ownsRuntime(existing.id)) {
        throw new Error("Session belongs to another runtime service or an unmanaged owner; stop that exact owner before resuming");
      }
      return attachExisting(error.claim, env, options.timeoutMs ?? 30_000, options.signal);
    }
    throw error;
  }
  writePrivateJson(files.operation, { protocol: PROTOCOL_VERSION, operationId, muxId, state: "provisional" } satisfies OperationRecord);
  const entry = fileURLToPath(new URL("./owner-entry.js", import.meta.resolve("@phimacs/pimux/runtime")));
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, [entry], { cwd, env, detached: false, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  } catch (error) { releaseClaim(claim); throw error; }
  const initialization: RuntimeInitialization = { type: "initialize", operationId, muxId, claim, command: host.executable, args: selected.args, cwd, host, service: launcher, serviceStateDirectory: observer.stateDirectory,
    ...options.parent ? { parent: options.parent } : {} };
  observer.spawned(child, initialization);
  return new Promise<RuntimeReceipt>((resolve, reject) => {
    let settled = false;
    let cancelling = false;
    let cancellationTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => { clearTimeout(timer); if (cancellationTimer) clearTimeout(cancellationTimer); options.signal?.removeEventListener("abort", cancel); };
    const complete = (error?: Error, receipt?: RuntimeReceipt): void => {
      if (settled) return;
      settled = true; cleanup();
      // The service retains IPC and the child handle for its entire lifetime.
      if (error) reject(error); else resolve(receipt!);
    };
    const cancel = (): void => {
      if (settled || cancelling) return;
      cancelling = true;
      if (child.connected) child.send({ type: "cancel" });
      cancellationTimer = setTimeout(() => complete(new RuntimeOperationError("Startup cancellation is uncertain; reconcile the retained operation before retrying", operationId, muxId)), 10_000);
    };
    const timer = setTimeout(cancel, options.timeoutMs ?? 30_000);
    child.on("message", (message: unknown) => {
      if (!isRecord(message)) return;
      if (message.type === "ready") {
        if (cancelling || options.signal?.aborted) cancel();
        else if (child.connected) {
          try { observer.ready(initialization); child.send({ type: "commit" }); }
          catch (error) { child.send({ type: "cancel" }); complete(error instanceof Error ? error : new Error(String(error))); }
        }
      } else if (message.type === "committed" && isRecord(message.receipt)) complete(undefined, message.receipt as unknown as RuntimeReceipt);
      else if (message.type === "failed") complete(new RuntimeOperationError(String(message.error ?? "Runtime startup failed"), operationId, muxId));
    });
    child.once("error", (error) => {
      // Spawn did not execute: the launcher still owns its unchanged capability.
      try { releaseClaim(claim); } catch { /* transfer may already have happened; fail closed */ }
      complete(new RuntimeOperationError(error.message, operationId, muxId));
    });
    child.once("exit", () => {
      const operation = readPrivateJson<OperationRecord>(files.operation);
      if (operation?.state === "committed" && operation.receipt) complete(undefined, operation.receipt);
      else complete(new RuntimeOperationError(operation?.error ?? "Runtime exited before commitment; inspect retained operation", operationId, muxId));
    });
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (child.connected) child.send(initialization);
    if (options.signal?.aborted) cancel();
  });
}
