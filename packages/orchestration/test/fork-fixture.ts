import * as fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createClaimTestEnvironment } from "@phimacs/pimux/ownership";
import { readProcessIdentity } from "@phimacs/pimux/process-identity";
import * as net from "node:net";
import * as path from "node:path";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPreparedSession, flushSessionFile } from "../context.ts";
import { removeTarget } from "../workers.ts";

/** Fake tmux transport with a real local terminal-input acknowledgement endpoint. */
export function forkFixture() {
  const sandbox = createClaimTestEnvironment();
  const keys = ["PI_ORCHESTRATION_HOST", "PI_ORCHESTRATION_ENDPOINT", "TMUX_PANE", "PHIMACS_TEST_ROOT", "PHIMACS_PI"];
  const previous = keys.map((key) => process.env[key]);
  process.env.PHIMACS_TEST_ROOT = sandbox.root;
  process.env.PHIMACS_PI = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
  process.env.PI_ORCHESTRATION_HOST = "tmux";
  process.env.PI_ORCHESTRATION_ENDPOINT = "/tmp/pi-fork-fake-tmux";
  process.env.TMUX_PANE = "%901";
  const directory = path.join(sandbox.root, "project");
  fs.mkdirSync(directory);
  const prepared = createPreparedSession(directory);
  let session = prepared.session;
  session.appendMessage({ role: "user", content: "Parent context", timestamp: Date.now() });
  const sessionFile = prepared.sessionFile;
  flushSessionFile(session, sessionFile);
  session = SessionManager.open(sessionFile);
  const commands: string[][] = [];
  const prompts: string[] = [];
  const children: string[] = [];
  const targets: string[] = [];
  const exitedPanes = new Set<string>();
  const servers: net.Server[] = [];
  const sockets = new Set<net.Socket>();
  const processes: ChildProcess[] = [];
  const controlDirectories: string[] = [];
  let failure: string | undefined;
  const pi = {
    getActiveTools: () => ["read", "ask", "do", "delegate", "fresh_look", "unknown-in-child"],
    getThinkingLevel: () => "high",
    getSessionName: (): string | undefined => undefined,
    exec: async (_command: string, args: string[]) => {
      commands.push(args);
      let stdout = "";
      if (args.includes("split-window") || args.includes("new-window")) {
        const command = args.at(-1)!;
        const child = /--session' '([^']+)'/.exec(command)?.[1];
        if (child) children.push(child);
        if (failure) throw new Error(failure);
        const socketPath = args.find((arg) => arg.startsWith("PI_ORCHESTRATION_CONTROL="))?.split("=")[1];
        if (socketPath) {
          controlDirectories.push(path.dirname(socketPath));
          const process = spawn(globalThis.process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
          processes.push(process);
          await once(process, "spawn");
          const identity = readProcessIdentity(process.pid!)!;
          const server = net.createServer((socket) => {
            sockets.add(socket); socket.on("close", () => sockets.delete(socket));
            let input = "";
            socket.on("data", (data) => {
              input += data.toString();
              if (!input.endsWith("\n")) return;
              const request = JSON.parse(input) as { kind: string; text?: string };
              if (request.kind === "prompt" && request.text) prompts.push(request.text);
              socket.end(JSON.stringify({ dispatched: true, process: identity }));
              if (request.kind === "stop") process.stdin?.end();
            });
          });
          await new Promise<void>((resolve) => server.listen(socketPath, resolve));
          servers.push(server);
        }
        stdout = `%${902 + children.length}\n`;
      } else if (args.includes("display-message")) {
        stdout = exitedPanes.has(args[args.indexOf("-t") + 1]) ? "1\n" : "0\n";
      }
      return { code: 0, stdout, stderr: "", killed: false };
    },
  } as unknown as ExtensionAPI;
  return {
    directory, session, sessionFile, pi, commands, prompts, children, targets, exitedPanes,
    failStart: (message: string) => { failure = message; },
    cleanup: async () => {
      for (const child of processes) {
        if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "close"); child.kill(); await exited; }
      }
      for (const socket of sockets) socket.destroy();
      for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const target of targets) removeTarget(target);
      for (const child of children) {
        fs.rmSync(child, { force: true });
        try { fs.rmdirSync(path.dirname(child)); } catch { /* A sibling may still own a file here. */ }
      }
      for (const control of controlDirectories) fs.rmSync(control, { recursive: true, force: true });
      keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
      fs.rmSync(sandbox.root, { recursive: true, force: true });
    },
  };
}
