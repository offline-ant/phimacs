/** Foreground, singleton supervisor. Only roots are restored, always idle. */
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { muxDirectory, readDiscovery } from "./discovery.ts";
import { withExactOption } from "./host.ts";
import { LineSplitter } from "./jsonl.ts";
import { ensurePrivateDirectory, readPrivateJson, writePrivateJson } from "./private-files.ts";
import { processIdentityStatus, readProcessIdentity, sameProcessIdentity, type ProcessIdentity } from "./process-identity.ts";
import { isRecord } from "./protocol.ts";
import { runtimePaths } from "./runtime-files.ts";
import { launchRuntime } from "./runtime-launch.ts";
import { rootCloseIntent, serviceStateDirectory, stateIdentityFile, writeServiceJson } from "./service-files.ts";
import { SERVICE_PROTOCOL, serviceSocket, type ServiceAgent, type ServiceStatus } from "./service-client.ts";
import { withTransaction } from "./transaction.ts";
import { RuntimeOperationError, type OperationRecord, type RuntimeInitialization, type RuntimeReceipt, type StartRuntimeOptions } from "./runtime.ts";

interface Root {
  ids: string[];
  command: string;
  args: string[];
  cwd: string;
  /** Execution/placement overrides only; provider environment comes from the service. */
  environment: NodeJS.ProcessEnv;
  receipt: RuntimeReceipt;
  owner: ProcessIdentity;
  pi: ProcessIdentity;
  model: { provider: string; id: string } | null;
  thinkingLevel: string | null;
  error?: string;
}
const ROOT_ENV = ["PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "PI_REMOTE", "PI_ORCHESTRATION_HOST", "PI_ORCHESTRATION_ENDPOINT", "PI_ORCHESTRATION_TARGET", "PI_ORCHESTRATION_PLACEMENT"];
const text = (error: unknown): string => error instanceof Error ? error.message : String(error);

export async function runService(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const directory = muxDirectory(env);
  ensurePrivateDirectory(directory);
  const identity = readProcessIdentity(process.pid);
  if (!identity) throw new Error("Cannot establish pimux service identity");
  const state = serviceStateDirectory(env);
  ensurePrivateDirectory(state);
  ensurePrivateDirectory(path.join(state, "closed"));
  const lease = path.join(state, "service.json");
  const journal = path.join(state, "roots.json");
  const socketFile = serviceSocket(env);
  const transaction = path.join(state, "lock");
  const endpointLease = path.join(directory, ".service.json");
  const endpointTransaction = path.join(directory, ".service-lock");
  const serialized = (action: () => void): void => withTransaction(endpointTransaction, () => withTransaction(transaction, action));
  serialized(() => {
    const previous = readPrivateJson<{ process: ProcessIdentity }>(lease);
    const endpoint = readPrivateJson<{ process: ProcessIdentity }>(endpointLease);
    if ([previous, endpoint].some(record => record && processIdentityStatus(record.process) !== "dead")) throw new Error("pimux service already running or its identity is uncertain");
    // State selection cannot authorize unlinking another service\'s endpoint.
    if (fs.existsSync(socketFile) && !endpoint) throw new Error("pimux endpoint has no authoritative owner identity; removal refused");
    fs.rmSync(socketFile, { force: true });
    writePrivateJson(endpointLease, { protocol: SERVICE_PROTOCOL, process: identity });
    writePrivateJson(lease, { protocol: SERVICE_PROTOCOL, process: identity });
    // One durable identity per state directory lets launchers prove which journal a service uses.
    if (!readPrivateJson(stateIdentityFile(state))) writeServiceJson(stateIdentityFile(state), { id: randomUUID() });
  });
  const stateId = readPrivateJson<{ id: string }>(stateIdentityFile(state))!.id;
  const roots = readPrivateJson<Root[]>(journal) ?? [];
  const children = new Set<ChildProcess>();
  const ownedIds = new Set<string>();
  const owners = new Map<string, ChildProcess>();
  /** Waiters for owners' input-gate acknowledgements, by agent, operation and direction. */
  const gateAcks = new Map<string, (ack: Record<string, unknown>) => void>();
  const gateKey = (muxId: string, operationId: string, closed: boolean): string => `${muxId}\0${operationId}\0${closed}`;
  /**
   * The one stop operation in progress and the process that started it. Only its
   * own caller's resume or commit acts on it, until that caller is proven dead.
   */
  let stop: { id: string; force: boolean; committed: boolean; caller: ProcessIdentity } | undefined;
  const peers = new Set<net.Socket>();
  const pending = new Set<Promise<unknown>>();
  let ready = false;
  let shuttingDown = false;
  /** An accepted stop: no agent may start, but existing agents run until shutdown. */
  let draining = false;
  const save = (): void => writeServiceJson(journal, roots);
  const remove = (root: Root): void => {
    const at = roots.indexOf(root);
    if (at >= 0) {
      roots.splice(at, 1); save();
      fs.rmSync(rootCloseIntent(root.receipt.muxId, state), { force: true });
    }
  };
  const spawnAgent = async (options: StartRuntimeOptions, restored?: Root, operation?: { muxId: string; operationId: string }): Promise<RuntimeReceipt> => {
    if (shuttingDown || draining) throw new Error("pimux service stopping; no agent was started");
    let ownedRoot = restored;
    const launch = launchRuntime(options, {
      stateDirectory: state,
      ownsRuntime: muxId => ownedIds.has(muxId),
      spawned(child, input) {
        children.add(child); ownedIds.add(input.muxId); owners.set(input.muxId, child);
        child.on("message", (message: unknown) => {
          if (!isRecord(message)) return;
          if (message.type === "gate" && typeof message.operationId === "string") {
            gateAcks.get(gateKey(input.muxId, message.operationId, message.closed === true))?.(message);
          }
          if (message.type === "closing" && ownedRoot) remove(ownedRoot);
          if (message.type === "configuration" && ownedRoot && isRecord(message.model)
            && typeof message.model.provider === "string" && typeof message.model.id === "string" && typeof message.thinkingLevel === "string") {
            ownedRoot.model = { provider: message.model.provider, id: message.model.id };
            ownedRoot.thinkingLevel = message.thinkingLevel;
            save();
          }
          if (message.type === "session" && ownedRoot && typeof message.sessionFile === "string" && typeof message.cwd === "string") {
            if (ownedRoot.receipt.sessionFile === message.sessionFile && ownedRoot.cwd === message.cwd) return;
            ownedRoot.args = withExactOption(ownedRoot.args, "session", message.sessionFile);
            ownedRoot.cwd = message.cwd;
            ownedRoot.receipt.sessionFile = message.sessionFile;
            save();
          }
        });
        child.once("exit", () => {
          children.delete(child); ownedIds.delete(input.muxId); owners.delete(input.muxId);
          // An exited agent has no input left to gate.
          for (const [key, waiter] of gateAcks) if (key.startsWith(`${input.muxId}\0`)) waiter({ idle: true });
          // Service stop preserves root intent; individual Pi/Close exits do not.
          if (!shuttingDown && ownedRoot && ownedRoot.receipt.muxId === input.muxId) remove(ownedRoot);
        });
        if (shuttingDown) child.kill("SIGTERM");
      },
      ready(input: RuntimeInitialization) {
        if (shuttingDown) throw new Error("pimux service stopping before commitment");
        const effective = options.env ?? env;
        if (effective.PI_ORCHESTRATION_PLACEMENT === "worker" || options.parent) return;
        const files = runtimePaths(input.muxId, input.operationId, env);
        const operation = readPrivateJson<OperationRecord>(files.operation);
        const discovery = readDiscovery(files.discovery);
        if (!operation?.receipt || !discovery?.ownerIdentity || !discovery.piIdentity) throw new Error("Missing owned root readiness identities");
        const environment: NodeJS.ProcessEnv = {};
        for (const key of ROOT_ENV) if (effective[key] !== undefined) environment[key] = effective[key];
        const next: Root = { command: input.command, args: input.args, cwd: input.cwd, environment,
          ids: [...restored?.ids ?? [], input.muxId].slice(-128), receipt: operation.receipt,
          owner: discovery.ownerIdentity, pi: discovery.piIdentity, model: discovery.model, thinkingLevel: discovery.thinkingLevel };
        if (restored) { delete restored.error; Object.assign(restored, next); }
        else { ownedRoot = next; roots.push(next); }
        save(); // Intent is durable before owner commitment, never after it.
      },
    }, operation);
    pending.add(launch);
    try { return await launch; }
    finally { pending.delete(launch); }
  };
  /** Owned agents as their discovery reports them; an uncommitted agent is still starting. */
  const agents = (): ServiceAgent[] => [...ownedIds].map(muxId => {
    const record = readDiscovery(path.join(directory, `${muxId}.json`));
    return { muxId, placement: record?.placement ?? "unknown", cwd: record?.cwd ?? null,
      status: record?.phase === "committed" ? record.status : "starting" };
  });
  const status = (): ServiceStatus => ({ process: identity, root: env.PHIMACS_ROOT ?? null, stateId, stopping: draining,
    stop: stop ? { operationId: stop.id, committed: stop.committed, caller: stop.caller } : null,
    pending: pending.size, agents: agents(), roots: roots.map(root => ({ muxId: root.receipt.muxId, cwd: root.cwd,
      sessionFile: root.receipt.sessionFile ?? null, error: root.error ?? null })) });
  /** Work a stop would interrupt or lose: busy agents, launches and agents never restored. */
  const stopBlockers = (unsettled: ReadonlySet<string> = new Set()): string[] => {
    const blockers = pending.size ? [`${pending.size} agent start(s) in progress`] : [];
    for (const agent of agents()) {
      if (agent.status !== "idle") blockers.push(`${agent.placement} ${agent.muxId} is ${agent.status}`);
      else if (unsettled.has(agent.muxId)) blockers.push(`${agent.placement} ${agent.muxId} did not settle idle behind the input gate`);
      else if (agent.placement !== "root") blockers.push(`${agent.placement} ${agent.muxId} is not restored after a stop`);
    }
    return blockers;
  };
  /** Close or open every owner's frontend input for one operation; closing returns the agents not proven idle. */
  const gateAll = async (operationId: string, closed: boolean): Promise<Set<string>> => {
    const unsettled = await Promise.all([...owners].map(([muxId, child]) => new Promise<string | undefined>(resolve => {
      const key = gateKey(muxId, operationId, closed);
      const finish = (settled: boolean): void => { clearTimeout(timer); gateAcks.delete(key); resolve(settled ? undefined : muxId); };
      const timer = setTimeout(() => finish(!closed), 10_000);
      gateAcks.set(key, ack => finish(!closed || (ack.idle === true && ack.error === undefined)));
      if (!child.connected) { finish(!closed); return; }
      child.send({ type: "gate", operationId, closed }, error => { if (error) finish(!closed); });
    })));
    return new Set(unsettled.filter((muxId): muxId is string => muxId !== undefined));
  };
  const refused = (blockers: string[]): Error =>
    new Error(`pimux stop refused: ${blockers.join("; ")}. Retry when they are idle, or force the stop to interrupt them`);
  /** A stop or resume acts only on this exact service process and its own operation. */
  const operationOf = (request: Record<string, unknown>): { operationId: string; caller: ProcessIdentity } => {
    if (!isRecord(request.service) || !sameProcessIdentity(request.service as unknown as ProcessIdentity, identity)) {
      throw new Error("Request is bound to another pimux service process; nothing was changed");
    }
    if (typeof request.operationId !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(request.operationId)) throw new Error("Invalid stop operation ID");
    const caller = request.caller;
    if (!isRecord(caller) || !Number.isSafeInteger(caller.pid) || (caller.pid as number) <= 0 || typeof caller.startTime !== "string"
      || typeof caller.bootId !== "string") throw new Error("A stop operation needs its caller's process identity");
    const operation = { operationId: request.operationId, caller: caller as unknown as ProcessIdentity };
    if (stop?.id === operation.operationId && !sameProcessIdentity(stop.caller, operation.caller)) {
      throw new Error(`pimux stop ${stop.id} belongs to another caller; nothing was changed`);
    }
    return operation;
  };
  /** Undo an operation whose caller is proven dead; a live (or uncertain) caller's operation is never taken over. */
  const recoverAbandoned = async (): Promise<boolean> => {
    if (!stop || shuttingDown || processIdentityStatus(stop.caller) !== "dead") return false;
    const abandoned = stop;
    stop = undefined; draining = false;
    if (!abandoned.force) await gateAll(abandoned.id, false);
    return true;
  };
  const handleStop = async (request: Record<string, unknown>, exit: () => void): Promise<ServiceStatus> => {
    const { operationId, caller } = operationOf(request);
    if (typeof request.force !== "boolean" || (request.phase !== "drain" && request.phase !== "commit") || typeof request.exit !== "boolean") {
      throw new Error("Invalid service stop request");
    }
    if (stop && stop.id !== operationId && !await recoverAbandoned()) {
      throw new Error(`pimux stop ${stop!.id} by live process ${stop!.caller.pid} is already in progress; it must finish or resume first`);
    }
    if (request.phase === "drain") {
      if (stop) return status(); // This operation's lost drain reply is reconciled, not repeated.
      // No start can begin between this check and draining: they are one synchronous section.
      const early = request.force ? [] : stopBlockers();
      if (early.length) throw refused(early);
      stop = { id: operationId, force: request.force, committed: false, caller };
      draining = true;
      if (!request.force) {
        // Frontend input is refused before idleness counts; only then is the check authoritative.
        const busy = stopBlockers(await gateAll(operationId, true));
        if (busy.length) {
          stop = undefined; draining = false;
          await gateAll(operationId, false);
          throw refused(busy);
        }
      }
      return status();
    }
    if (!stop) throw new Error(`pimux stop ${operationId} was not drained; nothing was committed`);
    const busy = stop.force ? [] : stopBlockers();
    if (busy.length) throw refused(busy);
    stop.committed = true;
    if (request.exit) exit();
    return status();
  };
  const handleResume = async (request: Record<string, unknown>): Promise<ServiceStatus & { resumed: boolean }> => {
    const { operationId } = operationOf(request);
    if (stop && stop.id !== operationId) {
      const resumed = await recoverAbandoned();
      return { ...status(), resumed };
    }
    if (stop?.id !== operationId || shuttingDown) return { ...status(), resumed: false };
    const resumed = stop;
    stop = undefined; draining = false;
    if (!resumed.force) await gateAll(operationId, false);
    return { ...status(), resumed: true };
  };
  const server = net.createServer(socket => {
    if (peers.size >= 32 || shuttingDown) { socket.destroy(); return; }
    peers.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => peers.delete(socket));
    socket.write(`${JSON.stringify({ type: "pimux_service", protocol: SERVICE_PROTOCOL, ready, stopping: draining,
      root: env.PHIMACS_ROOT ?? null, stateId, process: identity })}\n`);
    let used = false;
    /** Runs once this connection's response is written, e.g. the accepted exit. */
    let after: (() => void) | undefined;
    const controller = new AbortController();
    socket.once("close", () => controller.abort());
    const lines = new LineSplitter(line => {
      if (used || !ready || shuttingDown) { socket.destroy(); return; }
      used = true;
      const handle = async (): Promise<unknown> => {
        const request: unknown = JSON.parse(line);
        if (!isRecord(request)) throw new Error("Invalid service request");
        if (request.type === "status") return status();
        if (request.type === "resume") return handleResume(request);
        if (request.type === "stop") return handleStop(request, () => { after = () => { void shutdown(); }; });
        if (request.type === "resolve") {
          const root = roots.find(item => item.ids.includes(String(request.muxId)));
          if (!root) return null;
          if (readPrivateJson(rootCloseIntent(root.receipt.muxId, state))) { remove(root); return null; }
          if (root.error) throw new Error(root.error);
          const owner = readDiscovery(path.join(directory, `${root.receipt.muxId}.json`));
          if (owner?.phase !== "committed" || !owner.ownerIdentity || !owner.piIdentity || !sameProcessIdentity(owner.ownerIdentity, root.owner)
            || !sameProcessIdentity(owner.piIdentity, root.pi) || processIdentityStatus(root.pi) !== "alive") throw new Error("Root runtime is unavailable; no replacement writer was started");
          return { ...root.receipt, outcome: "attached" };
        }
        if (request.type !== "start" || typeof request.muxId !== "string" || !/^[a-f0-9-]{36}$/.test(request.muxId)
          || typeof request.operationId !== "string" || !/^[a-f0-9-]{36}$/.test(request.operationId)
          || typeof request.command !== "string" || !Array.isArray(request.args)
          || !request.args.every(arg => typeof arg === "string") || typeof request.cwd !== "string"
          || !isRecord(request.env) || !Object.values(request.env).every(value => typeof value === "string")) throw new Error("Invalid service start request");
        const effective: NodeJS.ProcessEnv = { ...env, ...request.env, PIMUX_DIR: directory };
        if (env.PHIMACS_TEST_ROOT) effective.PHIMACS_TEST_ROOT = env.PHIMACS_TEST_ROOT;
        else delete effective.PHIMACS_TEST_ROOT;
        return spawnAgent({ command: request.command, args: request.args as string[], cwd: request.cwd, env: effective,
          signal: controller.signal, timeoutMs: typeof request.timeoutMs === "number" ? request.timeoutMs : undefined,
          ...request.parent ? { parent: request.parent as StartRuntimeOptions["parent"] } : {} }, undefined,
          { muxId: request.muxId, operationId: request.operationId });
      };
      void handle().then(data => {
        if (after) socket.once("close", after);
        socket.end(`${JSON.stringify({ type: "service_response", success: true, data })}\n`, after);
      },
        error => socket.end(`${JSON.stringify({ type: "service_response", success: false, error: text(error),
          ...error instanceof RuntimeOperationError ? { operationId: error.operationId, muxId: error.muxId } : {} })}\n`));
    }, 4 * 1024 * 1024, () => socket.destroy());
    socket.on("data", (chunk: Buffer) => lines.push(chunk));
  });
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => shutdownPromise ??= (async () => {
    shuttingDown = true; ready = false;
    server.close();
    for (const peer of peers) peer.destroy();
    for (const child of children) {
      if (child.connected) child.send({ type: "shutdown" }, error => { if (error) child.kill("SIGTERM"); });
      else child.kill("SIGTERM");
    }
    await Promise.allSettled([...pending]);
    // Never exit normally while an owned owner can still keep old extensions alive.
    await Promise.all([...children].map(child => new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("exit", () => resolve());
    })));
  })();
  const terminate = (): void => { void shutdown(); };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, terminate);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      // Launchers probe this fixed path while it starts: bind it private, never briefly wider.
      const umask = process.umask(0o077);
      try { server.listen(socketFile, () => { server.off("error", reject); resolve(); }); }
      finally { process.umask(umask); }
    });
    fs.chmodSync(socketFile, 0o600);
    await Promise.all([...roots].map(async root => {
      if (shuttingDown) return;
      const files = runtimePaths(root.receipt.muxId, root.receipt.operationId, env);
      if (readPrivateJson(rootCloseIntent(root.receipt.muxId, state))) { remove(root); return; }
      try {
        // Pipe death tells old owners to stop. Definite exact writer death, not
        // a refused socket or a timeout, is the only replacement authorization.
        const deadline = performance.now() + 10_000;
        while (processIdentityStatus(root.owner) !== "dead" || processIdentityStatus(root.pi) !== "dead") {
          if (performance.now() >= deadline) throw new Error("Previous root writer is alive or uncertain; restoration refused");
          await delay(20);
        }
        const last = readDiscovery(files.discovery);
        if (last?.session?.file && last.ownerIdentity && last.piIdentity
          && sameProcessIdentity(last.ownerIdentity, root.owner) && sameProcessIdentity(last.piIdentity, root.pi)) {
          root.args = withExactOption(root.args, "session", last.session.file);
          root.cwd = last.cwd;
        }
        let args = root.args;
        if (root.model) {
          args = withExactOption(withExactOption(args, "provider", root.model.provider), "model", root.model.id);
        }
        if (root.thinkingLevel) args = withExactOption(args, "thinking", root.thinkingLevel);
        await spawnAgent({ command: root.command, args, cwd: root.cwd, env: { ...env, ...root.environment, PIMUX_DIR: directory } }, root);
      } catch (error) { root.error = `Root restoration failed: ${text(error)}`; save(); process.stderr.write(`${root.error}\n`); }
    }));
    ready = !shuttingDown;
    if (ready) process.stdout.write("pimux service ready\n");
    // The listening server and owned child IPC are the supervisor's liveness.
    await new Promise<void>(resolve => { if (shuttingDown) resolve(); else server.once("close", resolve); });
    await shutdown();
  } finally {
    await shutdown();
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.off(signal, terminate);
    serialized(() => {
      const endpoint = readPrivateJson<{ process: ProcessIdentity }>(endpointLease);
      if (endpoint && sameProcessIdentity(endpoint.process, identity)) {
        fs.rmSync(socketFile, { force: true }); fs.rmSync(endpointLease, { force: true });
      }
      const current = readPrivateJson<{ process: ProcessIdentity }>(lease);
      if (current && sameProcessIdentity(current.process, identity)) fs.rmSync(lease, { force: true });
    });
  }
}
