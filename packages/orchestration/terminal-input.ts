import * as net from "node:net";
import { processIdentityStatus, type ProcessIdentity } from "@phimacs/pimux/process-identity";
import { processIdentity } from "./managed-launch.ts";
import { fileURLToPath } from "node:url";

export const TERMINAL_INPUT_EXTENSION = fileURLToPath(import.meta.resolve("@phimacs/orchestration/terminal-extension"));

export interface TerminalReply { process: ProcessIdentity; sessionFile?: string }

/** Dispatch through Pi rather than pasting into an unknown human editor draft. */
export function terminalRequest(socketPath: string, request: { kind: "ping"; sessionFile?: string; process?: ProcessIdentity } | { kind: "prompt"; text: string; process?: ProcessIdentity } | { kind: "stop"; process: ProcessIdentity }, signal?: AbortSignal): Promise<TerminalReply> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let response = "";
    const abort = (): void => { socket.destroy(new Error("Terminal input cancelled")); };
    signal?.addEventListener("abort", abort, { once: true });
    socket.setEncoding("utf8");
    socket.setTimeout(30_000, () => socket.destroy(new Error(`Terminal input timeout: ${socketPath}`)));
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => { response += chunk; if (Buffer.byteLength(response) > 64 * 1024) socket.destroy(new Error("Terminal receipt exceeds its bound")); });
    socket.on("error", reject);
    socket.on("close", () => signal?.removeEventListener("abort", abort));
    socket.on("end", () => {
      try {
        const result: unknown = JSON.parse(response);
        if (typeof result !== "object" || result === null || !("dispatched" in result) || result.dispatched !== true) {
          throw new Error(`Terminal input was not dispatched: ${response}`);
        }
        const value = result as { process?: unknown; sessionFile?: unknown };
        const identity = processIdentity(value.process);
        if (!identity || processIdentityStatus(identity) === "dead") throw new Error("Terminal receipt lacks a live process-start identity");
        resolve({ process: identity, ...(typeof value.sessionFile === "string" ? { sessionFile: value.sessionFile } : {}) });
      } catch (error) { reject(error); }
    });
  });
}
