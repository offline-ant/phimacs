import * as fs from "node:fs";
import * as path from "node:path";
import { processIdentityStatus, readProcessIdentity, sameProcessIdentity, type ProcessIdentity } from "@phimacs/pimux/process-identity";
import { createPrivateJson, verifyPrivateDirectory, writePrivateJson } from "@phimacs/pimux/private-files";
import type { ParentTask } from "@phimacs/pimux/runtime";

export interface ParentTaskBinding { parent: ParentTask; file: string }
export interface ParentTaskRecord extends ParentTask { schema: 1; state: "active" | "ended" }

export function isProcessIdentity(value: unknown): value is ProcessIdentity {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return Number.isSafeInteger(item.pid) && Number(item.pid) > 0 && typeof item.startTime === "string" && /^\d+$/.test(item.startTime)
    && typeof item.bootId === "string" && item.bootId.length > 0;
}

function privateTaskDirectory(file: string): void {
  if (!path.isAbsolute(file)) throw new Error("Parent task lease requires an absolute path");
  verifyPrivateDirectory(path.dirname(file));
}

function readRecord(file: string): ParentTaskRecord {
  privateTaskDirectory(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error("Parent task lease must be a private same-user file");
    const value: unknown = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (typeof value !== "object" || value === null) throw new Error("Invalid parent task lease");
    const record = value as Record<string, unknown>;
    if (record.schema !== 1 || (record.state !== "active" && record.state !== "ended") || typeof record.taskId !== "string"
      || !record.taskId || !isProcessIdentity(record.process)) throw new Error("Invalid parent task lease");
    return record as unknown as ParentTaskRecord;
  } finally { fs.closeSync(fd); }
}

/** A task lease is never reused or removed: late children see its terminal state. */
export function createParentTask(directory: string, taskId: string): ParentTaskBinding & { end(): void } {
  const identity = readProcessIdentity(process.pid);
  if (!identity || !taskId) throw new Error("Cannot establish parent task identity");
  const file = path.join(fs.realpathSync.native(directory), "parent-task.json");
  privateTaskDirectory(file);
  const parent = { process: identity, taskId };
  const record: ParentTaskRecord = { schema: 1, ...parent, state: "active" };
  createPrivateJson(file, record);
  const binding = { parent, file };
  // Validate permission boundaries before any host receives the capability.
  try { readRecord(file); } catch (error) { fs.rmSync(file, { force: true }); throw error; }
  return { ...binding, end: () => endParentTask(binding) };
}

/**
 * End only this exact private task lease, from its parent or an explicit worker
 * cancellation. Cooperating writers never reuse its file or change its identity;
 * concurrent/repeated endings therefore have the same terminal outcome. No PID
 * is signalled and no new task can be substituted for a stale binding.
 */
export function endParentTask(binding: ParentTaskBinding): void {
  const current = readRecord(binding.file);
  if (current.taskId !== binding.parent.taskId || !sameProcessIdentity(current.process, binding.parent.process)) {
    throw new Error("Parent task lease identity changed; refusing to overwrite it");
  }
  if (current.state === "ended") return;
  writePrivateJson(binding.file, { ...current, state: "ended" });
}

export function parentTaskEnvironment(binding: ParentTaskBinding): Record<string, string> {
  return { PHIMACS_PARENT_TASK: JSON.stringify(binding.parent), PHIMACS_PARENT_TASK_FILE: binding.file };
}

/** Missing/partial managed bindings are not an independent-root fallback. */
export function readParentTaskBinding(env: NodeJS.ProcessEnv = process.env): ParentTaskBinding | undefined {
  const serialized = env.PHIMACS_PARENT_TASK;
  const file = env.PHIMACS_PARENT_TASK_FILE;
  if (!serialized && !file && !(env.PHIMACS_MANAGED_CLAIM && env.PI_ORCHESTRATION_PLACEMENT === "worker")) return undefined;
  if (!serialized || !file) throw new Error("Managed worker requires its parent process identity and task lease");
  const value: unknown = JSON.parse(serialized);
  if (typeof value !== "object" || value === null || !("process" in value) || !("taskId" in value)
    || !isProcessIdentity(value.process) || typeof value.taskId !== "string" || !value.taskId) throw new Error("Invalid parent task binding");
  return { parent: { process: value.process, taskId: value.taskId }, file };
}

/** Undefined means the owning task is authoritative and still active. */
export function parentTaskEnded(binding: ParentTaskBinding): string | undefined {
  try {
    const record = readRecord(binding.file);
    if (record.taskId !== binding.parent.taskId || !sameProcessIdentity(record.process, binding.parent.process)) return "Parent task lease identity changed";
    if (record.state === "ended") return `Parent task ${record.taskId} ended`;
    const status = processIdentityStatus(record.process);
    if (status !== "alive") return `Parent task process is ${status}`;
    return undefined;
  } catch (error) { return `Parent task lease is unavailable or uncertain: ${error instanceof Error ? error.message : String(error)}`; }
}

/** Checks before the first prompt too; no host/socket/buffer is a lifetime authority. */
export function watchParentTask(binding: ParentTaskBinding, stop: (reason: string) => void, intervalMs = 250): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  const check = (): void => {
    if (stopped) return;
    const reason = parentTaskEnded(binding);
    if (!reason) return;
    stopped = true;
    if (timer) clearInterval(timer);
    stop(reason);
  };
  check();
  if (!stopped) { timer = setInterval(check, intervalMs); timer.unref(); }
  return () => { stopped = true; if (timer) clearInterval(timer); };
}
