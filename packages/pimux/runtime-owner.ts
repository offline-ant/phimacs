/** One service-owned agent. Frontend loss is independent of its lifetime. */
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { type DiscoveryRecord, orchestrationIdentity, writeDiscovery } from "./discovery.ts";
import { ensurePrivateDirectory, writePrivateJson } from "./private-files.ts";
import { GUARD_STATUS_KEY, MANAGED_CLAIM_ENV } from "./guard.ts";
import { spawnGatedHost } from "./bootstrap.ts";
import { verifyHost } from "./host-identity.ts";
import { LineSplitter } from "./jsonl.ts";
import { Mux } from "./mux.ts";
import { OwnedToolGroups } from "./owned-tools.ts";
import { claimsForOwner, lookupClaim, reconcileClaim, releaseClaim, updateClaim, type ClaimHandle } from "./ownership.ts";
import { processIdentityStatus, readProcessIdentity, sameProcessIdentity, type ProcessIdentity } from "./process-identity.ts";
import { isRecord, parsePlacement, PROTOCOL_VERSION, type JsonRecord, type SnapshotData } from "./protocol.ts";
import { rootCloseIntent, writeServiceJson } from "./service-files.ts";
import { appendDiagnostic, pruneCompleted, runtimePaths } from "./runtime-files.ts";
import type { OperationRecord, RuntimeInitialization, RuntimeReceipt, TerminalReceipt } from "./runtime.ts";

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

export async function ownRuntime(input: RuntimeInitialization): Promise<void> {
  const files = runtimePaths(input.muxId, input.operationId);
  const identity = readProcessIdentity(process.pid);
  if (!identity) throw new Error("Cannot establish detached owner identity");
  let committed = false;
  let explicitlyClosed = false;
  let ready = false;
  let finished = false;
  let guardReady = false;
  let failure: string | undefined;
  let piIdentity: ProcessIdentity | undefined;
  let child: ChildProcess | undefined;
  let mux: Mux | undefined;
  let stopping: Promise<TerminalReceipt> | undefined;
  /** The service stop operation that closed frontend input, if any. */
  let gate: string | undefined;
  let parentTimer: ReturnType<typeof setInterval> | undefined;
  let toolTimer: ReturnType<typeof setInterval> | undefined;
  const tools = new OwnedToolGroups();
  const claims = new Map<string, ClaimHandle>([[input.claim.token, input.claim]]);
  const sockets = new Set<net.Socket>();
  const startedAt = new Date().toISOString();
  const placement = parsePlacement(process.env.PI_ORCHESTRATION_PLACEMENT);
  const references = orchestrationIdentity(process.env);
  let stderr = "";
  let configuration = "";
  let resolveExited: (receipt: TerminalReceipt) => void = () => {};
  const exited = new Promise<TerminalReceipt>((resolve) => { resolveExited = resolve; });
  let receipt: RuntimeReceipt | undefined;
  const operation = (state: OperationRecord["state"], error?: string): void => writePrivateJson(files.operation, {
    protocol: PROTOCOL_VERSION, operationId: input.operationId, muxId: input.muxId, state,
    ...receipt ? { receipt } : {}, ...error ? { error } : {},
  } satisfies OperationRecord);
  const notify = (record: JsonRecord): void => { if (process.connected) process.send?.(record); };
  const publish = (): void => {
    if (finished) return;
    const current = mux?.state;
    const model = current?.model;
    writeDiscovery(files.discovery, {
      protocol: PROTOCOL_VERSION, muxId: input.muxId, socket: files.socket, pid: process.pid, piPid: piIdentity?.pid ?? null,
      ownerIdentity: identity, service: input.service, piIdentity: piIdentity ?? null, operationId: input.operationId,
      phase: committed ? "committed" : "provisional", host: input.host,
      cwd: current?.session?.cwd ?? input.cwd, startedAt, updatedAt: new Date().toISOString(),
      status: committed ? current?.status().status ?? "idle" : "starting", blocked: current?.status().blocked ?? null,
      session: current?.session ? { file: current.session.file, id: current.session.id, name: current.session.name }
        : { file: input.claim.file, id: null, name: null },
      model: isRecord(model) && typeof model.provider === "string" && typeof model.id === "string" ? { provider: model.provider, id: model.id } : null,
      thinkingLevel: current?.thinkingLevel ?? null, placement, ...references,
    } satisfies DiscoveryRecord);
    const selected = isRecord(model) && typeof model.provider === "string" && typeof model.id === "string"
      ? { model: { provider: model.provider, id: model.id }, thinkingLevel: current?.thinkingLevel } : undefined;
    if (selected && JSON.stringify(selected) !== configuration) {
      configuration = JSON.stringify(selected);
      notify({ type: "configuration", ...selected });
    }
  };
  const server = net.createServer((socket) => {
    if (finished || sockets.size >= 32) { socket.destroy(); return; }
    sockets.add(socket);
    const client = mux!.addClient({ write: (line) => socket.write(line), onDrain: (listener) => { socket.on("drain", listener); }, destroy: () => socket.destroy() });
    const lines = new LineSplitter((line) => mux!.clientLine(client, line), 64 * 1024 * 1024, () => mux!.removeClient(client));
    socket.on("data", (chunk: Buffer) => lines.push(chunk));
    const gone = (): void => { sockets.delete(socket); mux!.removeClient(client); };
    socket.on("error", gone); socket.on("close", gone);
  });
  const finalize = (code: number | null, signal: string | null): void => {
    if (finished) return;
    finished = true; ready = false;
    if (parentTimer) clearInterval(parentTimer);
    if (toolTimer) clearInterval(toolTimer);
    tools.stop();
    try {
      for (const record of claimsForOwner({ id: input.muxId, wrapper: identity }, input.claim.testRoot ? { testRoot: input.claim.testRoot } : {})) {
        claims.set(record.token, { file: record.file, token: record.token, owner: record.owner,
          ...input.claim.testRoot ? { testRoot: input.claim.testRoot } : {} });
      }
    } catch (error) { appendDiagnostic(files.log, `Additional claims retained: ${errorText(error)}`); }
    for (const handle of claims.values()) {
      try { releaseClaim(handle); } catch (error) { appendDiagnostic(files.log, `Claim retained: ${errorText(error)}`); }
    }
    const terminal: TerminalReceipt = { protocol: PROTOCOL_VERSION, muxId: input.muxId, operationId: input.operationId,
      state: "stopped", service: input.service, rootClosed: explicitlyClosed, placement, code, signal, stoppedAt: new Date().toISOString() };
    writePrivateJson(files.receipt, terminal);
    if (!committed) operation("failed", failure ?? "Pi exited before runtime commitment");
    mux?.finish({ code, signal, stderrTail: stderr });
    resolveExited(terminal);
    if (!committed) notify({ type: "failed", error: failure ?? "Pi exited before readiness" });
    server.close();
    fs.rmSync(files.socket, { force: true });
    fs.rmSync(files.discovery, { force: true });
    pruneCompleted(path.dirname(files.receipt));
    // Bounded flush only; the stopped receipt is authoritative if a peer loses EOF.
    setTimeout(() => { for (const socket of sockets) socket.end(); }, 100).unref();
    setTimeout(() => {
      for (const socket of sockets) socket.destroy();
      if (process.connected) process.disconnect();
      process.exit(code === 0 || signal === "SIGTERM" ? 0 : 1);
    }, 1000);
  };
  const stop = (): Promise<TerminalReceipt> => {
    if (stopping) return stopping;
    stopping = (async () => {
      ready = false;
      if (!child) { finalize(1, null); return exited; }
      // A successful spawn is an owned child even if reading /proc failed.
      // Only its close event (or confirmed failure to spawn) authorizes release.
      if (!piIdentity || processIdentityStatus(piIdentity) === "alive") child.kill("SIGTERM");
      const graceful = await Promise.race([exited, delay(5000).then(() => undefined)]);
      if (graceful) return graceful;
      if (!piIdentity || processIdentityStatus(piIdentity) === "alive") child.kill("SIGKILL");
      const forced = await Promise.race([exited, delay(3000).then(() => undefined)]);
      if (forced) return forced;
      throw new Error("Owned Pi exit remains uncertain; claims retained, no replacement writer allowed");
    })();
    return stopping;
  };
  const fatal = (error: unknown): void => {
    failure = errorText(error);
    appendDiagnostic(files.log, failure);
    ready = false;
    void stop().catch((problem) => { appendDiagnostic(files.log, errorText(problem)); notify({ type: "failed", error: failure }); });
  };
  const adoptSnapshot = (data: SnapshotData): void => {
    try {
      if (!data.session.file) throw new Error("Managed runtime lost its persistent session");
      const claim = lookupClaim(data.session.file);
      if (!claim || claim.owner.id !== input.muxId || !sameProcessIdentity(claim.owner.wrapper, identity)) throw new Error("Companion snapshot has no matching owned session claim");
      const handle: ClaimHandle = { file: claim.file, token: claim.token, owner: claim.owner, ...input.claim.testRoot ? { testRoot: input.claim.testRoot } : {} };
      reconcileClaim(handle); claims.set(handle.token, handle);
      publish();
      notify({ type: "session", sessionFile: data.session.file, cwd: data.session.cwd });
    } catch (error) { fatal(error); throw error; }
  };
  const cancel = (): void => { if (!committed) fatal(new Error("Launch request disconnected or cancelled before commitment")); };
  /** With input gated: let forwarded input be answered, then read idleness at a companion boundary. */
  const gatedIdle = async (): Promise<boolean> => {
    if (!mux || !committed || finished) return false;
    const deadline = Date.now() + 5000;
    while (mux.pendingInputCount > 0) {
      if (Date.now() >= deadline) return false;
      await delay(20);
    }
    const snapshot = await mux.takeSnapshot();
    return snapshot.idle && mux.state.status().status === "idle";
  };
  // The supervising service, not a frontend, owns this channel. Losing it must
  // stop even committed agents; surviving detached extensions are forbidden.
  process.on("disconnect", () => fatal(new Error("pimux service exited; owned agent stopping")));
  process.on("message", (message: unknown) => {
    if (!isRecord(message)) return;
    if (message.type === "shutdown") { void stop().catch(fatal); }
    else if (message.type === "cancel") cancel();
    else if (message.type === "gate" && typeof message.operationId === "string") {
      const operationId = message.operationId;
      if (message.closed === true) {
        gate = operationId;
        void gatedIdle().then(idle => notify({ type: "gate", operationId, closed: true, idle }),
          (error: unknown) => notify({ type: "gate", operationId, closed: true, idle: false, error: errorText(error) }));
      } else {
        if (gate === operationId) gate = undefined;
        notify({ type: "gate", operationId, closed: false });
      }
    }
    else if (message.type === "commit" && ready && !committed && process.connected && receipt) {
      committed = true;
      // Publish the complete identity before another launcher can observe a
      // committed operation and validate attachment against discovery.
      publish(); operation("committed"); notify({ type: "committed", receipt });
    }
  });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => { void stop().catch(fatal); });
  try {
    if (!process.connected) throw new Error("Managed startup requires the private service channel");
    if (placement === "worker" && (!input.parent?.taskId || processIdentityStatus(input.parent.process) !== "alive")) throw new Error("Detached workers require a live parent process identity and task ID");
    verifyHost(input.command);
    updateClaim(input.claim, { ...input.claim.owner, wrapper: identity });
    operation("provisional"); publish();
    const companion = fileURLToPath(import.meta.resolve("@phimacs/pimux/companion"));
    const treeNavigate = fileURLToPath(import.meta.resolve("@phimacs/pimux/tree-navigate"));
    const gated = spawnGatedHost({ host: input.host,
      args: [...input.args, "--extension", companion, "--extension", treeNavigate],
      cwd: input.cwd, stdio: "pipe", claim: input.claim,
      env: { ...process.env, [MANAGED_CLAIM_ENV]: JSON.stringify(input.claim), PIMUX_DISCOVERY: files.discovery,
        PIMUX_WRAPPER_IDENTITY: JSON.stringify(identity) },
    });
    child = gated.child;
    child.once("close", finalize);
    piIdentity = await gated.authorize();
    child.stdin!.on("error", () => {});
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr = Buffer.from(`${stderr}${chunk.toString("utf8")}`).subarray(-16 * 1024).toString("utf8");
      appendDiagnostic(files.log, chunk.toString("utf8"));
    });
    toolTimer = setInterval(() => { if (piIdentity && processIdentityStatus(piIdentity) === "alive") tools.capture(piIdentity.pid); }, 1000);
    toolTimer.unref();
    mux = new Mux({ muxId: input.muxId, socketPath: files.socket, piPid: piIdentity.pid,
      canAcceptCommands: () => committed && ready && !finished,
      inputRefusal: () => gate ? "pimux service stopping" : undefined,
      writeToPi: (record) => { if (!finished && child?.stdin?.writable) child.stdin.write(`${JSON.stringify(record)}\n`); },
      onStatus: () => { try { publish(); } catch (error) { fatal(error); } },
      onDiagnostic: (line) => appendDiagnostic(files.log, line), onSnapshot: adoptSnapshot,
      onStop: async () => {
        // Durable intent precedes both shutdown and the service notification.
        // A crash between these steps must not resurrect an explicitly closed root.
        if (placement !== "worker" && !input.parent) {
          writeServiceJson(rootCloseIntent(input.muxId, input.serviceStateDirectory), { muxId: input.muxId });
        }
        explicitlyClosed = true;
        notify({ type: "closing" });
        return await stop() as unknown as JsonRecord;
      },
    });
    const output = new LineSplitter((line) => {
      let value: unknown;
      try { value = JSON.parse(line); } catch { /* Mux records ordinary malformed output privately. */ }
      if (isRecord(value) && value.type === "extension_ui_request" && value.method === "setStatus" && value.statusKey === GUARD_STATUS_KEY) {
        try {
          if (typeof value.statusText !== "string") throw new Error("Managed guard supplied no readiness record");
          const report: unknown = JSON.parse(value.statusText);
          if (!isRecord(report) || report.ready !== true || !isRecord(report.handle)) throw new Error(isRecord(report) ? String(report.error ?? "Managed guard supplied no claim") : "Managed guard failed");
          const handle = report.handle as unknown as ClaimHandle;
          if (handle.owner.id !== input.muxId || !sameProcessIdentity(handle.owner.wrapper, identity)) throw new Error("Guard reported another runtime's claim");
          claims.set(handle.token, handle);
          guardReady = true;
        } catch (error) { fatal(error); return; }
      }
      try { mux!.piLine(line); } catch (error) { fatal(error); }
    }, 128 * 1024 * 1024, () => fatal(new Error("Pi output record exceeds safety bound")));
    child.stdout!.on("data", (chunk: Buffer) => {
      if (piIdentity && processIdentityStatus(piIdentity) === "alive") tools.capture(piIdentity.pid);
      output.push(chunk);
    });
    ensurePrivateDirectory(files.directory);
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(files.socket, () => { server.off("error", reject); resolve(); }); });
    fs.chmodSync(files.socket, 0o600);
    publish();
    const snapshot = await mux.takeSnapshot();
    adoptSnapshot(snapshot);
    if (failure || finished || !guardReady) throw new Error(failure ?? "Required managed companion did not establish ownership readiness");
    ready = true;
    receipt = { protocol: PROTOCOL_VERSION, operationId: input.operationId, muxId: input.muxId, socket: files.socket,
      pid: process.pid, piPid: piIdentity.pid, service: input.service,
      sessionFile: snapshot.session.file!, state: "committed", outcome: "started" };
    operation("ready"); notify({ type: "ready" });
    if (input.parent) {
      const parent = input.parent;
      parentTimer = setInterval(() => { if (processIdentityStatus(parent.process) === "dead") fatal(new Error(`Parent task ${parent.taskId} ended; subordinate runtime stopping`)); }, 1000);
      parentTimer.unref();
    }
  } catch (error) {
    failure = errorText(error);
    appendDiagnostic(files.log, failure);
    if (!child) finalize(1, null);
    else await stop().catch((problem) => notify({ type: "failed", error: errorText(problem) }));
  }
}
