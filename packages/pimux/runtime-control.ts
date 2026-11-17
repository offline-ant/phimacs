/** Discovery and identity-bound control; no launch/parser SDK dependency. */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { type DiscoveryRecord, liveDiscovery, muxDirectory, readDiscovery, watchDiscovery } from "./discovery.ts";
import { lookupClaim, type ClaimRecord } from "./ownership.ts";
import { LineSplitter } from "./jsonl.ts";
import { isRecord, PROTOCOL_VERSION } from "./protocol.ts";
import { runtimePaths } from "./runtime-files.ts";
import { readPrivateJson } from "./private-files.ts";
import type { TerminalReceipt } from "./runtime.ts";

export function validateSocket(socket: string): void {
  const stat = fs.lstatSync(socket);
  if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error("Runtime socket must be same-user and private");
  const parent = fs.lstatSync(path.dirname(socket));
  if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0) throw new Error("Runtime socket directory is unsafe");
}

/** Exposes no claims from an unrelated namespace; foreign/unsupported live owners are refusals. */
export function lookupRuntime(file: string, env = process.env): ClaimRecord | undefined { return lookupClaim(file, env.PHIMACS_TEST_ROOT ? { testRoot: env.PHIMACS_TEST_ROOT } : {}); }
export function listRuntimes(env = process.env): DiscoveryRecord[] { return liveDiscovery(muxDirectory(env)); }

/**
 * `pimux watch --json`: one `{"type":"agents","agents":[…]}` line with the
 * complete `list` now and after each change, until `input` ends.
 */
export function watchRuntimes(env = process.env, input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout): Promise<void> {
  return new Promise((resolve, reject) => {
    let watch: { close(): void } | undefined;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      watch?.close();
      input.off("end", ended).off("close", ended).off("error", finish);
      output.off("error", finish);
      (input as NodeJS.ReadableStream & { destroy?(): void }).destroy?.();
      if (error) reject(error); else resolve();
    };
    const ended = (): void => finish();
    input.on("end", ended).on("close", ended).on("error", finish);
    output.on("error", finish);
    try {
      watch = watchDiscovery(muxDirectory(env), (agents) => { output.write(`${JSON.stringify({ type: "agents", agents })}\n`); },
        { onError: finish });
    } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); return; }
    input.resume();
  });
}

/** Read retained terminal evidence only; absence never establishes runtime death. */
export function lookupTerminalReceipt(muxId: string, env = process.env): TerminalReceipt | null {
  if (typeof muxId !== "string" || !/^[a-zA-Z0-9-]+$/.test(muxId)) throw new Error("Invalid runtime identity");
  const directory = muxDirectory(env);
  const receipts = path.join(directory, "receipts");
  for (const dir of [directory, receipts]) {
    let stat: fs.Stats;
    try { stat = fs.lstatSync(dir); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
      throw new Error("Terminal receipt directory has unsafe ownership/permissions");
    }
  }
  const receipt = readPrivateJson<unknown>(path.join(receipts, `${muxId}.json`));
  if (receipt === undefined) return null;
  if (!isRecord(receipt) || receipt.protocol !== PROTOCOL_VERSION || receipt.muxId !== muxId
    || receipt.state !== "stopped" || typeof receipt.operationId !== "string" || !/^[a-zA-Z0-9-]+$/.test(receipt.operationId)
    || !(receipt.code === null || (typeof receipt.code === "number" && Number.isSafeInteger(receipt.code) && receipt.code >= 0))
    || !(receipt.signal === null || (typeof receipt.signal === "string" && receipt.signal.length > 0))
    || typeof receipt.stoppedAt !== "string" || !Number.isFinite(Date.parse(receipt.stoppedAt))) {
    throw new Error("Invalid retained terminal receipt");
  }
  if (receipt.service !== undefined && (!isRecord(receipt.service) || !Number.isSafeInteger(receipt.service.pid)
    || Number(receipt.service.pid) <= 0 || typeof receipt.service.startTime !== "string" || !/^\d+$/.test(receipt.service.startTime)
    || typeof receipt.service.bootId !== "string" || !receipt.service.bootId
    || typeof receipt.rootClosed !== "boolean"
    || !["root", "worker", "interactive-fork"].includes(String(receipt.placement)))) throw new Error("Invalid retained service identity");
  return { protocol: PROTOCOL_VERSION, muxId, operationId: receipt.operationId, state: "stopped",
    ...(receipt.service ? { service: receipt.service as unknown as TerminalReceipt["service"], rootClosed: receipt.rootClosed as boolean, placement: receipt.placement as TerminalReceipt["placement"] } : {}),
    code: receipt.code, signal: receipt.signal, stoppedAt: receipt.stoppedAt };
}

export async function stopRuntime(muxId: string, options: { env?: NodeJS.ProcessEnv; timeoutMs?: number; operationId?: string } = {}): Promise<TerminalReceipt> {
  const env = options.env ?? process.env;
  const operationId = options.operationId ?? randomUUID();
  const files = runtimePaths(muxId, operationId, env);
  const retained = readPrivateJson<TerminalReceipt>(files.receipt);
  if (retained?.muxId === muxId && retained.state === "stopped") return retained;
  const discovery = readDiscovery(files.discovery);
  if (!discovery || discovery.muxId !== muxId || discovery.protocol !== PROTOCOL_VERSION) throw new Error("Runtime unavailable or unsupported; no process was signalled");
  validateSocket(discovery.socket);
  const timeoutMs = options.timeoutMs ?? 15_000;
  return new Promise((resolve, reject) => {
    const socket = net.connect(discovery.socket);
    let settled = false;
    const finish = (error?: Error, receipt?: TerminalReceipt): void => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy();
      const retainedNow = readPrivateJson<TerminalReceipt>(files.receipt);
      if (retainedNow?.muxId === muxId && retainedNow.state === "stopped") resolve(retainedNow);
      else if (receipt) resolve(receipt); else reject(error ?? new Error("Stop acknowledgement lost; reconcile this runtime's retained receipt"));
    };
    const timer = setTimeout(() => finish(new Error("Stop is uncertain; no duplicate operation was submitted")), timeoutMs);
    const lines = new LineSplitter((line) => {
      let record: unknown; try { record = JSON.parse(line); } catch { return; }
      if (!isRecord(record)) return;
      if (record.type === "pimux_hello") {
        if (record.protocol !== PROTOCOL_VERSION || record.muxId !== muxId) finish(new Error("Stop target identity mismatch"));
        else socket.write(`${JSON.stringify({ type: "pimux_stop", id: operationId, operationId, expectedMuxId: muxId })}\n`);
      } else if (record.type === "response" && record.id === operationId) {
        if (record.success === true) finish(undefined, record.data as unknown as TerminalReceipt);
        else finish(new Error(String(record.error ?? "Stop refused")));
      } else if (record.type === "pimux_exit") finish();
    }, 128 * 1024 * 1024, () => finish(new Error("Stop response exceeds bound")));
    socket.on("data", (chunk: Buffer) => lines.push(chunk));
    socket.once("error", finish);
    socket.once("end", () => finish());
  });
}
