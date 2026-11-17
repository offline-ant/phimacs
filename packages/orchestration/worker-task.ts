import * as fs from "node:fs";
import * as path from "node:path";
import { muxDirectory } from "@phimacs/pimux/discovery";
import { ensurePrivateDirectory, verifyPrivateDirectory, writePrivateJson } from "@phimacs/pimux/private-files";
import { processIdentityStatus, readProcessIdentity, sameProcessIdentity, type ProcessIdentity } from "@phimacs/pimux/process-identity";
import { withTransaction } from "@phimacs/pimux/transaction";
import type { ParentTask } from "@phimacs/pimux/runtime";
import type { HostTarget } from "./host-types.ts";
import { isProcessIdentity, type ParentTaskBinding } from "./parent-task.ts";

export interface WorkerTaskRecord {
  schema: 1;
  muxId: string;
  worker: ProcessIdentity;
  parent: ParentTask;
  leaseFile: string;
  state: "pending" | "complete" | "failed";
  error?: string;
}

const MAX_BYTES = 64 * 1024;
const ID = /^[a-zA-Z0-9-]{1,128}$/;
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function privateDirectory(directory: string, create: boolean): boolean {
  if (!path.isAbsolute(directory)) throw new Error("Worker task directory must be absolute");
  if (create) { ensurePrivateDirectory(directory); return true; }
  try { verifyPrivateDirectory(directory); } catch (error) { if (missing(error)) return false; throw error; }
  return true;
}

function directory(env: NodeJS.ProcessEnv, create: boolean): string | null {
  const root = muxDirectory(env);
  if (!privateDirectory(root, create)) return null;
  const receipts = path.join(root, "task-receipts");
  return privateDirectory(receipts, create) ? receipts : null;
}

function fileFor(root: string, muxId: string): string {
  if (!ID.test(muxId)) throw new Error("Invalid worker task mux identity");
  return path.join(root, `${muxId}.json`);
}

function readPrivate(file: string): unknown {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    // Publication replaces evidence by rename: an opened record replaced since has
    // no links but is still the complete version current at open.
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.nlink > 1 || stat.size > MAX_BYTES) {
      throw new Error("Worker task evidence must be a bounded private same-user file with mode 0600");
    }
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    for (;;) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
      length += count;
      if (length > MAX_BYTES) throw new Error("Worker task evidence exceeds its byte bound");
      if (count === 0) return JSON.parse(bytes.toString("utf8", 0, length));
    }
  } finally { fs.closeSync(fd); }
}

function parseRecord(value: unknown, muxId: string): WorkerTaskRecord {
  if (!object(value) || value.schema !== 1 || value.muxId !== muxId || !isProcessIdentity(value.worker)
    || !object(value.parent) || !isProcessIdentity(value.parent.process) || typeof value.parent.taskId !== "string"
    || !value.parent.taskId || value.parent.taskId.length > 1024 || typeof value.leaseFile !== "string"
    || !path.isAbsolute(value.leaseFile) || path.normalize(value.leaseFile) !== value.leaseFile
    || (value.state !== "pending" && value.state !== "complete" && value.state !== "failed")
    || (value.state === "failed" ? typeof value.error !== "string" || !value.error || value.error.length > 16 * 1024 : value.error !== undefined)) {
    throw new Error("Invalid worker task evidence identity or state");
  }
  return { schema: 1, muxId, worker: value.worker, parent: { process: value.parent.process, taskId: value.parent.taskId },
    leaseFile: value.leaseFile, state: value.state as WorkerTaskRecord["state"], ...(value.error === undefined ? {} : { error: value.error as string }) };
}

/** Read-only: absence, pending and failed are never acknowledged task cleanup. */
export function readWorkerTask(muxId: string, env: NodeJS.ProcessEnv = process.env): WorkerTaskRecord | null {
  if (!ID.test(muxId)) throw new Error("Invalid worker task mux identity");
  const root = directory(env, false);
  if (!root) return null;
  try { return parseRecord(readPrivate(fileFor(root, muxId)), muxId); }
  catch (error) { if (missing(error)) return null; throw error; }
}

function sameBinding(left: WorkerTaskRecord, right: WorkerTaskRecord): boolean {
  return left.muxId === right.muxId && left.leaseFile === right.leaseFile && left.parent.taskId === right.parent.taskId
    && sameProcessIdentity(left.worker, right.worker) && sameProcessIdentity(left.parent.process, right.parent.process);
}

function parentOwns(record: WorkerTaskRecord): void {
  const current = readProcessIdentity(process.pid);
  if (!current || !sameProcessIdentity(current, record.parent.process)) throw new Error("Only the exact owning parent can publish worker task evidence");
}

function leaseState(record: WorkerTaskRecord): "active" | "ended" {
  privateDirectory(path.dirname(record.leaseFile), false);
  const lease = readPrivate(record.leaseFile);
  if (!object(lease) || lease.schema !== 1 || !isProcessIdentity(lease.process) || lease.taskId !== record.parent.taskId
    || !sameProcessIdentity(lease.process, record.parent.process) || (lease.state !== "active" && lease.state !== "ended")) {
    throw new Error("Worker task lease identity changed or is invalid");
  }
  return lease.state;
}

function writeRecord(file: string, record: WorkerTaskRecord): void {
  if (Buffer.byteLength(`${JSON.stringify(record)}\n`) > MAX_BYTES) throw new Error("Worker task evidence exceeds its byte bound");
  // All publishers hold the directory transaction. Rename publishes complete
  // bytes with one link; readers never observe a transient hardlink count.
  writePrivateJson(file, record);
}

/** Publish an immutable identity binding before advertising an interactive worker. */
export function publishWorkerTask(target: HostTarget, binding: ParentTaskBinding, env: NodeJS.ProcessEnv = process.env): WorkerTaskRecord {
  if (target.kind !== "pi" || !target.runtime || target.runtime.protocol !== 2 || target.runtime.state !== "committed"
    || !isProcessIdentity(target.process) || target.runtime.piPid !== target.process.pid) throw new Error("Worker task requires an exact committed RPC runtime and worker identity");
  const record = parseRecord({ schema: 1, muxId: target.runtime.muxId, worker: target.process,
    parent: binding.parent, leaseFile: binding.file, state: "pending" }, target.runtime.muxId);
  parentOwns(record);
  leaseState(record);
  const root = directory(env, true)!;
  return withTransaction(path.join(root, ".transactions"), () => {
    const existing = readWorkerTask(record.muxId, env);
    if (existing) {
      if (!sameBinding(existing, record)) throw new Error("Worker task identity cannot be replaced");
      return existing;
    }
    writeRecord(fileFor(root, record.muxId), record);
    return record;
  });
}

function prune(root: string, keep: string): void {
  const terminal = fs.readdirSync(root).filter(name => /^[a-zA-Z0-9-]{1,128}\.json$/.test(name)).flatMap(name => {
    const record = parseRecord(readPrivate(path.join(root, name)), name.slice(0, -5));
    return record.state === "pending" ? [] : [{ name, time: fs.lstatSync(path.join(root, name)).mtimeMs }];
  }).sort((a, b) => a.name === `${keep}.json` ? -1 : b.name === `${keep}.json` ? 1 : b.time - a.time || a.name.localeCompare(b.name));
  for (const item of terminal.slice(128)) fs.unlinkSync(path.join(root, item.name));
}

/**
 * Owning parent calls only after cleanup and name release. An ended lease alone
 * or frontend/runtime disconnection cannot acknowledge completion.
 */
export function finishWorkerTask(muxId: string, options: { error?: string; env?: NodeJS.ProcessEnv } = {}): WorkerTaskRecord {
  const env = options.env ?? process.env;
  const root = directory(env, false);
  if (!root) throw new Error("Worker task evidence is missing");
  return withTransaction(path.join(root, ".transactions"), () => {
    const record = readWorkerTask(muxId, env);
    if (!record) throw new Error("Worker task evidence is missing");
    parentOwns(record);
    const desired = parseRecord({ ...record, state: options.error === undefined ? "complete" : "failed", error: options.error }, muxId);
    if (record.state !== "pending") {
      if (record.state !== desired.state || record.error !== desired.error) throw new Error("Final worker task evidence cannot be replaced");
      return record;
    }
    if (leaseState(record) !== "ended") throw new Error("Worker task lease has not ended");
    if (processIdentityStatus(record.worker) !== "dead") throw new Error("Worker process exit is not proven; task cleanup remains uncertain");
    writeRecord(fileFor(root, muxId), desired);
    prune(root, muxId);
    return desired;
  });
}
