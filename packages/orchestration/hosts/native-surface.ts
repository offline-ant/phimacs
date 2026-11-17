import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import { randomUUID } from "node:crypto";
import type { NativePanelSurface } from "../host-types.ts";

/** A single bounded JSONL request to an exact pinned native server socket. */
export async function nativeRequest(socket: NativePanelSurface["socket"], method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  signal?.throwIfAborted();
  validateNativeSocket(socket);
  return await new Promise((resolve, reject) => {
    const client = net.createConnection(socket.path);
    const id = randomUUID();
    let bytes = "", done = false;
    const finish = (error?: Error, value?: Record<string, unknown>): void => {
      if (done) return; done = true;
      clearTimeout(timer); signal?.removeEventListener("abort", abort); client.destroy();
      if (error) reject(error); else resolve(value!);
    };
    const abort = (): void => finish(new Error("Native request cancelled; allocation may be uncertain"));
    const timer = setTimeout(() => finish(new Error("Native request timed out; allocation may be uncertain")), 10_000);
    signal?.addEventListener("abort", abort, { once: true });
    client.once("error", finish);
    client.once("end", () => { if (!done) finish(new Error("Native server disconnected before acknowledgement")); });
    client.once("connect", () => client.write(`${JSON.stringify({ id, method, params })}\n`));
    client.on("data", chunk => {
      bytes += chunk.toString("utf8");
      if (bytes.length > 1024 * 1024) return finish(new Error("Native response exceeds its bound"));
      if (!bytes.includes("\n")) return;
      try {
        const response = JSON.parse(bytes.slice(0, bytes.indexOf("\n"))) as { id?: string; result?: Record<string, unknown>; error?: { message?: string } };
        if (response.id !== id) throw new Error("Native response identity mismatch");
        if (response.error) throw new Error(response.error.message ?? "Native request refused");
        if (!response.result || typeof response.result !== "object") throw new Error("Invalid native response");
        finish(undefined, response.result);
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
  });
}

/** Linux Unix sockets are inode addressed. A private hardlink cannot retarget
 * when a native server replaces its public pathname, even between two commands. */
export function pinNativeSocket(endpoint: string, directory: string): NativePanelSurface["socket"] {
  const source = fs.lstatSync(endpoint);
  if (!source.isSocket() || source.uid !== process.getuid?.()) throw new Error("Native server must expose a same-user Unix socket");
  const pinned = path.join(directory, "host.sock");
  fs.linkSync(endpoint, pinned);
  const stat = fs.lstatSync(pinned);
  if (!stat.isSocket() || source.dev !== stat.dev || source.ino !== stat.ino) {
    fs.unlinkSync(pinned);
    throw new Error("Native server socket changed during ownership capture");
  }
  return { path: pinned, device: String(stat.dev), inode: String(stat.ino) };
}

export function createNativeSocketPin(endpoint: string): NativePanelSurface["socket"] {
  const directory = fs.mkdtempSync(path.join(path.dirname(endpoint), ".pi-panel-"));
  fs.chmodSync(directory, 0o700);
  try { return pinNativeSocket(endpoint, directory); }
  catch (error) {
    try { fs.rmSync(directory, { recursive: true, force: true }); }
    catch (cleanup) { throw new AggregateError([error, cleanup], `${String(error)}; native socket pin cleanup failed: ${String(cleanup)}`); }
    throw error;
  }
}

export function validateNativeSocket(socket: NativePanelSurface["socket"]): void {
  const directory = fs.lstatSync(path.dirname(socket.path));
  const stat = fs.lstatSync(socket.path);
  if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0
    || !stat.isSocket() || stat.uid !== process.getuid?.() || String(stat.dev) !== socket.device || String(stat.ino) !== socket.inode) {
    throw new Error("Native server socket identity changed; refusing destructive cleanup");
  }
}
