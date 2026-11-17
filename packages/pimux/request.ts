/** One non-replayed request to an identity-checked detached runtime. */
import { randomUUID } from "node:crypto";
import * as net from "node:net";
import { LineSplitter } from "./jsonl.ts";
import { canonicalSessionPath } from "./ownership.ts";
import { isReadOnlyCommand, isRecord, parseInputContext, PROTOCOL_VERSION, type InputContext, type JsonRecord } from "./protocol.ts";
import { lookupRuntime, validateSocket, type RuntimeReceipt } from "./runtime.ts";
import { processIdentityStatus, type ProcessIdentity } from "./process-identity.ts";

/** Read the owner-recorded start identity, never adopt whichever process reused a PID. */
export function runtimeIdentity(runtime: RuntimeReceipt, env: NodeJS.ProcessEnv = process.env): ProcessIdentity {
  const claim = lookupRuntime(runtime.sessionFile, env);
  if (!claim || claim.owner.id !== runtime.muxId || claim.owner.kind !== "rpc" || claim.owner.protocol !== PROTOCOL_VERSION
    || claim.owner.socket !== runtime.socket || claim.owner.wrapper.pid !== runtime.pid
    || claim.owner.pi?.pid !== runtime.piPid || processIdentityStatus(claim.owner.pi) !== "alive") {
    throw new Error("Runtime claim/process-start identity changed or is uncertain");
  }
  return claim.owner.pi;
}

export async function runtimeRequest(runtime: RuntimeReceipt, request: JsonRecord, signal?: AbortSignal, timeoutMs = 30_000): Promise<JsonRecord> {
  signal?.throwIfAborted();
  validateSocket(runtime.socket);
  return new Promise((resolve, reject) => {
    const socket = net.connect(runtime.socket);
    const id = randomUUID();
    let settled = false;
    let hello = false;
    let generation: number | undefined;
    let inputContext: InputContext | undefined;
    let sent = false;
    const finish = (error?: Error, response?: JsonRecord): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(new Error(`${error.message}${sent ? " Request may have been accepted; it was not replayed." : ""}`));
      else resolve(response!);
    };
    const abort = (): void => finish(new Error("Runtime request aborted"));
    const timer = setTimeout(() => finish(new Error("Runtime request timed out")), timeoutMs);
    const lines = new LineSplitter((line) => {
      let record: unknown;
      try { record = JSON.parse(line); } catch { finish(new Error("Malformed runtime record")); return; }
      if (!isRecord(record)) { finish(new Error("Malformed runtime record")); return; }
      if (!hello) {
        if (record.type !== "pimux_hello" || record.protocol !== PROTOCOL_VERSION || record.muxId !== runtime.muxId || record.piPid !== runtime.piPid
          || !Array.isArray(record.capabilities) || !record.capabilities.includes("snapshot") || !record.capabilities.includes("detached")
          || !record.capabilities.includes("contextual-input")) {
          finish(new Error("Runtime identity/protocol mismatch")); return;
        }
        hello = true;
      } else if (record.type === "pimux_snapshot") {
        try {
          if (!isRecord(record.session) || typeof record.session.file !== "string" || typeof record.generation !== "number"
            || canonicalSessionPath(record.session.file) !== canonicalSessionPath(runtime.sessionFile)) {
            finish(new Error("Runtime is serving a different conversation")); return;
          }
          inputContext = parseInputContext(record.inputContext);
          if (inputContext && inputContext.sessionFile !== record.session.file) {
            finish(new Error("Runtime input context names a different conversation")); return;
          }
          generation = record.generation;
        } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      } else if (record.type === "pimux_live" && record.generation === generation && generation !== undefined && !sent) {
        const mutates = typeof request.type !== "string" || !isReadOnlyCommand(request.type);
        if (mutates && !inputContext) {
          finish(new Error("Runtime snapshot has no usable input context")); return;
        }
        sent = true;
        // Extension commands may await human input or task settlement. Bound
        // attachment readiness, not the user's task after dispatch. Capture the
        // socket's authoritative context; the router checks it atomically.
        clearTimeout(timer);
        socket.write(`${JSON.stringify({ ...request, id, ...(mutates ? { pimuxContext: inputContext } : {}) })}\n`);
      } else if (record.type === "response" && sent && record.id === id) finish(undefined, record);
      else if (record.type === "pimux_gap" || record.type === "pimux_session_changed" || record.type === "pimux_tree_changed") {
        generation = undefined;
        inputContext = undefined;
      }
      else if (record.type === "pimux_snapshot_failed" || record.type === "pimux_exit") finish(new Error("Runtime is not available"));
    }, 128 * 1024 * 1024, () => finish(new Error("Runtime response exceeds its bound")));
    socket.on("data", (chunk: Buffer) => lines.push(chunk));
    socket.once("error", (error) => finish(error));
    socket.once("end", () => finish(new Error("Runtime disconnected")));
    socket.once("close", () => finish(new Error("Runtime connection closed")));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
