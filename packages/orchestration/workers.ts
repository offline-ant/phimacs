import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentToolUpdateCallback, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { publicTarget } from "./endpoint.ts";
import { getHost, hostForTarget } from "./host.ts";
import type { HostTarget } from "./host-types.ts";
import { appendWorkerMoreInfo, formatWorkerResult, formatWorkerRetryTime, parseWorkerResult, readWorkerStatus, type WorkerArtifactPaths, type WorkerResultFile, type WorkerStatusFile } from "./worker-frame.ts";
import { createWorkerPreview } from "./worker-preview.ts";
import { processIdentityStatus, readProcessIdentity, sameProcessIdentity, type ProcessIdentity } from "@phimacs/pimux/process-identity";
import { createParentTask, isProcessIdentity, parentTaskEnvironment } from "./parent-task.ts";
import { randomUUID } from "node:crypto";
import { withTransaction } from "@phimacs/pimux/transaction";
import { ensurePrivateDirectory, writePrivateJson } from "@phimacs/pimux/private-files";
import { publishWorkerTask, finishWorkerTask } from "./worker-task.ts";

const REGISTRY_DIR = path.join(os.tmpdir(), "pi-orchestration-targets");
const RESULT_POLL_INTERVAL_MS = 250;
const PROGRESS_UPDATE_INTERVAL_MS = 5000;
const STATE_POLL_INTERVAL_MS = 1000;
const STATE_UNAVAILABLE_GRACE_MS = 5000;

interface RegistryEntry {
  target: HostTarget;
}

export function validateName(name: string): string {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) {
    throw new Error("Name must start with a lowercase letter, contain only lowercase letters, numbers, '_' or '-', and be at most 32 characters.");
  }
  return name;
}

function registryPath(name: string): string {
  return path.join(REGISTRY_DIR, `${validateName(name)}.json`);
}

function readEntry(name: string): RegistryEntry | undefined {
  const file = registryPath(name);
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, "utf8")) as RegistryEntry;
}

function saveEntry(entry: RegistryEntry): void {
  ensurePrivateDirectory(REGISTRY_DIR);
  writePrivateJson(registryPath(entry.target.name), entry);
}

/**
 * A claim makes one process the only user of a name: `request` for a worker's
 * whole parent request, `operation` for a start or close that changes the
 * registry within seconds. The file identifies its holder's process start and purpose.
 */
export type ClaimPurpose = "request" | "operation";
interface Claim { process: ProcessIdentity; purpose: ClaimPurpose; token: string }
const OPERATION_POLL_MS = 50;

const claimPath = (name: string): string => `${registryPath(name)}.claim`;

function nameTransaction<T>(name: string, action: () => T): T {
  validateName(name);
  ensurePrivateDirectory(REGISTRY_DIR);
  return withTransaction(path.join(REGISTRY_DIR, `${name}.transactions`), action);
}

function readClaim(file: string): Claim | undefined {
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let value: unknown;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 4096) {
        throw new Error(`Unsafe name claim: ${file}; reconcile it before retrying.`);
      }
      value = JSON.parse(fs.readFileSync(fd, "utf8"));
    } finally { fs.closeSync(fd); }
    if (typeof value !== "object" || value === null || !("process" in value) || !isProcessIdentity(value.process)
      || !("purpose" in value) || (value.purpose !== "request" && value.purpose !== "operation")
      || !("token" in value) || typeof value.token !== "string" || !value.token) throw new Error(`Invalid name claim: ${file}; reconcile it before retrying.`);
    return { process: value.process, purpose: value.purpose, token: value.token };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Called only while this name's transaction serializes every cooperating peer. */
function readLiveClaim(name: string): Claim | undefined {
  const file = claimPath(name);
  const claim = readClaim(file);
  if (!claim || processIdentityStatus(claim.process) !== "dead") return claim;
  fs.unlinkSync(file);
  return undefined;
}

/** The live holder after serialized recovery; uncertain process identities remain held. */
function liveClaim(name: string): Claim | undefined {
  return nameTransaction(name, () => readLiveClaim(name));
}

export function tryClaimName(name: string, purpose: ClaimPurpose = "request"): (() => void) | undefined {
  const file = claimPath(name);
  const identity = readProcessIdentity(process.pid);
  if (!identity) throw new Error("Cannot establish the name-claim holder process identity");
  const token = randomUUID();
  const acquired = nameTransaction(name, () => {
    if (readLiveClaim(name)) return false;
    // Publish complete bytes: crashing during the write cannot leave a truncated
    // reused claim pathname that readers mistake for an absent/dead owner.
    const temporary = `${file}.${token}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify({ process: identity, purpose, token })}\n`, { mode: 0o600, flag: "wx" });
      fs.linkSync(temporary, file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    } finally { fs.rmSync(temporary, { force: true }); }
  });
  if (!acquired) return undefined;
  let released = false;
  return () => {
    if (released) return;
    nameTransaction(name, () => {
      const current = readClaim(file);
      if (current && current.token === token && sameProcessIdentity(current.process, identity)) fs.unlinkSync(file);
    });
    released = true;
  };
}

const heldError = (name: string): Error =>
  new Error(`'${name}' is already being used by another request (claim: ${claimPath(name)}).`);

export function claimName(name: string): () => void {
  const release = tryClaimName(name);
  if (!release) throw heldError(name);
  return release;
}

/**
 * Claim a name for a registry operation. Tools of one assistant batch run
 * concurrently, so a start may follow a close of the same name that has not
 * finished yet: wait for such operations instead of failing. A worker's request
 * claim lasts its whole run and still fails at once.
 */
export async function claimNameForOperation(name: string, signal?: AbortSignal): Promise<() => void> {
  for (;;) {
    const release = tryClaimName(name, "operation");
    if (release) return release;
    const holder = liveClaim(name);
    if (holder && holder.purpose !== "operation") throw heldError(name);
    await delay(OPERATION_POLL_MS, undefined, { signal });
  }
}

/** A name's target once any start or close of it in progress has finished. */
export async function settledTarget(name: string, signal?: AbortSignal): Promise<HostTarget | undefined> {
  while (liveClaim(name)?.purpose === "operation") await delay(OPERATION_POLL_MS, undefined, { signal });
  return readTarget(name);
}

export function readTarget(name: string): HostTarget | undefined {
  return readEntry(name)?.target;
}

export function saveTarget(target: HostTarget): void {
  saveEntry({ target });
}

export function removeTarget(name: string): void {
  fs.rmSync(registryPath(name), { force: true });
}

export function listTargets(): HostTarget[] {
  if (!fs.existsSync(REGISTRY_DIR)) return [];
  return fs.readdirSync(REGISTRY_DIR).filter((file) => file.endsWith(".json"))
    .map((file) => readTarget(file.slice(0, -5))).filter((target): target is HostTarget => target !== undefined);
}

export interface WorkerToolDetails {
  id: string;
  target: HostTarget;
  artifacts: WorkerArtifactPaths;
  sessionFile: string;
  task: string;
  elapsedMs: number;
  status: string;
  retryAt?: number;
}

export async function waitForWorkerResult(
  pi: ExtensionAPI,
  options: {
    id: string;
    target: HostTarget;
    paths: WorkerArtifactPaths;
    sessionFile: string;
    task: string;
    signal?: AbortSignal;
    onUpdate?: AgentToolUpdateCallback;
  },
): Promise<{ result: WorkerResultFile; details: WorkerToolDetails }> {
  const startedAt = Date.now();
  let lastProgressAt = -PROGRESS_UPDATE_INTERVAL_MS;
  let lastStateAt = -STATE_POLL_INTERVAL_MS;
  let unavailableSince: number | undefined;
  let workerIdentity = (options.target as HostTarget & { process?: ProcessIdentity }).process;
  const host = hostForTarget(pi, options.target);
  const preview = createWorkerPreview(options.sessionFile);
  const matchingStatus = (): WorkerStatusFile | undefined => {
    const status = readWorkerStatus(options.paths.statusPath);
    return status?.id === options.id ? status : undefined;
  };
  const details = (status: string, retryAt?: number): WorkerToolDetails => ({
    id: options.id, target: publicTarget(options.target), artifacts: options.paths,
    sessionFile: options.sessionFile, task: options.task, elapsedMs: Date.now() - startedAt, status,
    ...(retryAt === undefined ? {} : { retryAt }),
  });
  const readResult = (): WorkerResultFile | undefined => fs.existsSync(options.paths.resultPath)
    ? parseWorkerResult(fs.readFileSync(options.paths.resultPath, "utf8"), options.paths.resultPath, options.id) : undefined;

  while (true) {
    options.signal?.throwIfAborted();
    const result = readResult();
    if (result) return { result, details: details("finished") };
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs - lastStateAt >= STATE_POLL_INTERVAL_MS) {
      lastStateAt = elapsedMs;
      let state: "running" | "exited" | "missing" | undefined;
      // Runtime identity is authoritative even before the first task status.
      // A socket process, buffer, vanished discovery entry or reused PID cannot
      // prove worker death.
      const published = matchingStatus()?.process;
      if (published) {
        if (workerIdentity && !sameProcessIdentity(workerIdentity, published)) throw new Error("Worker status process identity does not match its owned target");
        workerIdentity ??= published;
      }
      if (workerIdentity) {
        const alive = processIdentityStatus(workerIdentity);
        state = alive === "dead" ? "exited" : "running";
      }
      else try {
        state = await host.state(options.target, options.signal);
        unavailableSince = undefined;
      } catch (error) {
        options.signal?.throwIfAborted();
        unavailableSince ??= Date.now();
        if (Date.now() - unavailableSince >= STATE_UNAVAILABLE_GRACE_MS) {
          throw new Error(`Could not inspect worker ${options.target.name} (${options.target.host}:${options.target.id}) for five seconds: ${String(error)}\nSession: ${options.sessionFile}`);
        }
      }
      if (state === "exited" || state === "missing") {
        // The child writes its final artifact before exiting. Recheck after native state I/O.
        const final = readResult();
        if (final) return { result: final, details: details("finished") };
        throw new Error(`Worker ${options.target.name} (${options.target.host}:${options.target.id}) ${state} before writing a final result.\nSession: ${options.sessionFile}\nResult: ${options.paths.resultPath}`);
      }
    }
    if (options.onUpdate && elapsedMs - lastProgressAt >= PROGRESS_UPDATE_INTERVAL_MS) {
      lastProgressAt = elapsedMs;
      const status = matchingStatus();
      const retryAt = status?.state === "running" ? status.retryAt : undefined;
      const progress = retryAt !== undefined
        ? [`Worker ${options.target.name} is waiting for provider quota; retry scheduled at ${formatWorkerRetryTime(retryAt)}.`,
          "No tools are replayed; parent cancellation stops recovery."].join("\n")
        : status?.state === "waiting"
          ? [`Worker ${options.target.name} is waiting for you.`, status.waitingReason,
            "Open the worker and type a message to continue it, or use /worker-return [text] to hand back now."].filter(Boolean).join("\n")
          : `Worker ${options.target.name} is running (${Math.floor(elapsedMs / 1000)}s elapsed).`;
      options.onUpdate({
        content: [{ type: "text", text: `${progress}\nSession: ${options.sessionFile}\n\n${preview()}` }],
        details: details(retryAt === undefined ? status?.state ?? "running" : "quota-wait", retryAt),
      });
    }
    await delay(RESULT_POLL_INTERVAL_MS, undefined, { signal: options.signal });
  }
}

/** A worker that finished with an error result; callers keep the result file's fields. */
export class WorkerResultError extends Error {
  readonly result: WorkerResultFile;

  constructor(message: string, result: WorkerResultFile) {
    super(message);
    this.result = result;
  }
}

export async function runEphemeralWorker(
  pi: ExtensionAPI,
  options: {
    id: string;
    name: string;
    cwd: string;
    sessionFile: string;
    args: string[];
    env?: Record<string, string>;
    paths: WorkerArtifactPaths;
    task: string;
    signal?: AbortSignal;
    onUpdate?: AgentToolUpdateCallback;
  },
): Promise<{ result: WorkerResultFile; details: WorkerToolDetails }> {
  const release = claimName(options.name);
  let target: HostTarget | undefined;
  let failure: Error | undefined;
  let output: Awaited<ReturnType<typeof waitForWorkerResult>> | undefined;
  let parentTask: ReturnType<typeof createParentTask> | undefined;
  let taskEvidence: { muxId: string; env: NodeJS.ProcessEnv } | undefined;
  try {
    if (readTarget(options.name)) throw new Error(`'${options.name}' already exists.`);
    const host = getHost(pi);
    parentTask = createParentTask(options.paths.artifactDir, options.id);
    target = await host.start({
      // Everything already in the session predates this run: inherited context or earlier runs.
      hiddenHistoryBefore: Date.now(),
      kind: "pi", name: options.name, cwd: options.cwd, sessionFile: options.sessionFile,
      args: options.args, env: { ...options.env, ...parentTaskEnvironment(parentTask) }, prompt: fs.readFileSync(options.paths.promptPath, "utf8"), placement: "worker", parent: host.parent(),
    }, options.signal);
    if (target.runtime && parentTask) {
      const env = { PIMUX_DIR: path.dirname(target.runtime.socket) };
      publishWorkerTask(target, parentTask, env);
      taskEvidence = { muxId: target.runtime.muxId, env };
    }
    saveTarget(target);
    output = await waitForWorkerResult(pi, { ...options, target });
    if (output.result.isError) throw new Error(formatWorkerResult(output.result));
    return output;
  } catch (error) {
    const message = appendWorkerMoreInfo(error instanceof Error ? error.message : String(error), options.paths);
    failure = output?.result.isError ? new WorkerResultError(message, output.result) : new Error(message);
    throw failure;
  } finally {
    let leaseFailure: string | undefined;
    const cleanupErrors: string[] = [];
    try { parentTask?.end(); }
    catch (error) {
      leaseFailure = `Could not end worker parent-task lease: ${String(error)}`;
      cleanupErrors.push(leaseFailure);
    }
    try {
      if (target) {
        try {
          await hostForTarget(pi, target).close(target);
          removeTarget(target.name);
        } catch (error) {
          const closeFailure = `Could not close worker ${target.name} (${target.host}:${target.id}): ${String(error)}`;
          cleanupErrors.push(closeFailure);
          // A finished worker's result outlives its failed cleanup. The target
          // stays recorded, so the worker can still be stopped by hand.
          if (output && !failure) output.result.result = `${output.result.result.trimEnd()}\n\n${closeFailure}`;
          else throw new Error(appendWorkerMoreInfo([failure?.message, leaseFailure, closeFailure].filter(Boolean).join("\n"), options.paths));
        }
      }
      if (leaseFailure) {
        if (output && !failure) output.result.result = `${output.result.result.trimEnd()}\n\n${leaseFailure}`;
        else throw new Error(appendWorkerMoreInfo([failure?.message, leaseFailure].filter(Boolean).join("\n"), options.paths));
      }
    } finally {
      try { release(); }
      catch (error) {
        cleanupErrors.push(`Could not release worker name: ${String(error)}`);
        throw new Error([failure?.message, ...cleanupErrors].filter(Boolean).join("\n"));
      } finally {
        let evidenceFailure: string | undefined;
        if (taskEvidence) {
          const error = cleanupErrors.length ? [failure?.message, ...cleanupErrors].filter(Boolean).join("\n") : undefined;
          try { finishWorkerTask(taskEvidence.muxId, { env: taskEvidence.env, error }); }
          catch (evidenceError) {
            evidenceFailure = `Could not publish final worker task evidence: ${String(evidenceError)}`;
            cleanupErrors.push(evidenceFailure);
          }
        }
        if (target) {
          const error = cleanupErrors.length ? [failure?.message, ...cleanupErrors].filter(Boolean).join("\n") : undefined;
          try { await hostForTarget(pi, target).taskFinished?.(target, error); }
          catch (notificationError) {
            const message = `Could not acknowledge worker cleanup: ${String(notificationError)}`;
            if (output && !failure) output.result.result = `${output.result.result.trimEnd()}\n\n${message}`;
            else throw new Error([failure?.message, ...cleanupErrors, message].filter(Boolean).join("\n"));
          }
        }
        if (evidenceFailure) {
          if (output && !failure) output.result.result = `${output.result.result.trimEnd()}\n\n${evidenceFailure}`;
          else throw new Error([failure?.message, ...cleanupErrors].filter(Boolean).join("\n"));
        }
      }
    }
  }
}
