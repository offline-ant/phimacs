import * as fs from "node:fs";
import * as path from "node:path";
import { muxDirectory } from "./discovery.ts";
import { ensurePrivateDirectory, readPrivateJson } from "./private-files.ts";

export function runtimePaths(muxId: string, operationId: string, env = process.env) {
  if (!/^[a-zA-Z0-9-]+$/.test(muxId) || !/^[a-zA-Z0-9-]+$/.test(operationId)) throw new Error("Invalid runtime operation identity");
  const directory = muxDirectory(env);
  ensurePrivateDirectory(directory);
  const operations = path.join(directory, "operations");
  const receipts = path.join(directory, "receipts");
  const logs = path.join(directory, "logs");
  for (const dir of [operations, receipts, logs]) ensurePrivateDirectory(dir);
  return { directory, socket: path.join(directory, `${muxId}.sock`), discovery: path.join(directory, `${muxId}.json`),
    operation: path.join(operations, `${operationId}.json`), receipt: path.join(receipts, `${muxId}.json`), log: path.join(logs, `${muxId}.log`) };
}

/** Diagnostics are private and bounded; malformed Pi output is never routed into a draft. */
export function appendDiagnostic(file: string, text: string): void {
  const previous = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0);
  const incoming = Buffer.from(`${new Date().toISOString()} ${text}\n`);
  const joined = Buffer.concat([previous, incoming]);
  const tail = joined.subarray(Math.max(0, joined.length - 64 * 1024));
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, tail); } finally { fs.closeSync(fd); }
}

/**
 * Only completed receipts/logs expire; provisional operation evidence is not silently discarded.
 * A worker whose `task-receipts/<muxId>.json` is not `complete` keeps its receipt: frontends
 * need it to prove the worker ended before retiring a failed or orphaned task's view.
 */
export function pruneCompleted(directory: string, maximum = 128): void {
  const names = fs.readdirSync(directory).filter((name) => /^[a-zA-Z0-9-]+\.(?:json|log)$/.test(name));
  const files = names.map((name) => ({ file: path.join(directory, name), time: fs.lstatSync(path.join(directory, name)).mtimeMs })).sort((a, b) => b.time - a.time);
  const root = path.dirname(directory);
  for (const { file } of files.slice(maximum)) {
    const receipt = readPrivateJson<{ muxId?: string; operationId?: string; state?: string }>(file);
    if (receipt?.state !== "stopped" || !receipt.muxId || !receipt.operationId
      || !/^[a-zA-Z0-9-]+$/.test(receipt.muxId) || !/^[a-zA-Z0-9-]+$/.test(receipt.operationId)
      || taskUnfinished(path.join(root, "task-receipts", `${receipt.muxId}.json`))) continue;
    const operationFile = path.join(root, "operations", `${receipt.operationId}.json`);
    const operation = readPrivateJson<{ muxId?: string; operationId?: string }>(operationFile);
    if (operation?.muxId === receipt.muxId && operation.operationId === receipt.operationId) fs.rmSync(operationFile, { force: true });
    fs.rmSync(path.join(root, "logs", `${receipt.muxId}.log`), { force: true });
    fs.rmSync(file, { force: true });
  }
}

/** Unreadable or unsafe task evidence counts as unfinished: retention is the safe side. */
function taskUnfinished(file: string): boolean {
  try { const task = readPrivateJson<{ state?: unknown }>(file); return task !== undefined && task.state !== "complete"; }
  catch { return true; }
}
