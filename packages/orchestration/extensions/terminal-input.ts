import * as fs from "node:fs";
import * as net from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { reserveManagedSession } from "@phimacs/pimux/guard";
import { canonicalSessionPath } from "@phimacs/pimux/ownership";
import { readProcessIdentity, sameProcessIdentity } from "@phimacs/pimux/process-identity";
import { processIdentity } from "../managed-launch.ts";

/** Native terminal submissions append to drafts. Keep machine prompts out of the human editor. */
export default function terminalInput(pi: ExtensionAPI): void {
  const socketPath = process.env.PI_ORCHESTRATION_CONTROL;
  if (!socketPath) return;
  let server: net.Server | undefined;
  let currentContext: ExtensionContext | undefined;
  const clients = new Set<net.Socket>();

  pi.on("session_start", async (_event, ctx) => {
    currentContext = ctx;
    if (server) return;
    server = net.createServer((client) => {
      clients.add(client);
      client.on("close", () => clients.delete(client));
      client.on("error", () => client.destroy());
      client.setEncoding("utf8");
      let input = "";
      client.on("data", (chunk: string) => {
        input += chunk;
        if (Buffer.byteLength(input) > 1024 * 1024) { client.destroy(); return; }
        const newline = input.indexOf("\n");
        if (newline < 0) return;
        client.removeAllListeners("data");
        try {
          const request: unknown = JSON.parse(input.slice(0, newline));
          if (typeof request !== "object" || request === null || !("kind" in request)) {
            throw new Error("Expected a terminal-input request");
          }
          const context = currentContext;
          if (!context) throw new Error("Terminal session is not ready");
          const sessionFile = context.sessionManager.getSessionFile();
          if (!sessionFile) throw new Error("Managed terminal requires a persisted session");
          // A socket may listen before all session_start hooks have run. Do not
          // acknowledge readiness or dispatch until the owning guard agrees.
          reserveManagedSession(sessionFile);
          const expected = "process" in request ? processIdentity(request.process) : undefined;
          const self = readProcessIdentity(process.pid);
          if (("process" in request || request.kind === "stop") && (!expected || !self || !sameProcessIdentity(expected, self))) throw new Error("Terminal process identity mismatch");
          if (request.kind === "stop") {
            client.end(`${JSON.stringify({ dispatched: true, process: readProcessIdentity(process.pid) })}\n`);
            context.shutdown();
            process.kill(process.pid, "SIGTERM");
            return;
          }
          if (request.kind === "prompt" && "text" in request && typeof request.text === "string") {
            pi.sendUserMessage(request.text, { deliverAs: "followUp", expandPromptTemplates: true });
          } else if (request.kind !== "ping") {
            throw new Error("Expected ping or prompt with text");
          } else if ("sessionFile" in request && (typeof request.sessionFile !== "string"
            || canonicalSessionPath(request.sessionFile) !== canonicalSessionPath(sessionFile))) {
            throw new Error("Terminal is not running the expected session file");
          }
          // Dispatch acknowledgement only; worker result artifacts determine completion.
          client.end(`${JSON.stringify({ dispatched: true, process: readProcessIdentity(process.pid), sessionFile })}\n`);
        } catch (error) {
          client.end(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(socketPath, () => {
        server!.off("error", reject);
        fs.chmodSync(socketPath, 0o600);
        resolve();
      });
    });
  });

  pi.on("session_shutdown", async () => {
    const current = server;
    server = undefined;
    currentContext = undefined;
    if (!current) return;
    for (const client of clients) client.destroy();
    await new Promise<void>((resolve, reject) => current.close((error) => error ? reject(error) : resolve()));
  });
}
