import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { processIdentityStatus, readProcessIdentity, sameProcessIdentity, type ProcessIdentity } from "@phimacs/pimux/process-identity";
import { verifyPrivateDirectory, writePrivateJson } from "@phimacs/pimux/private-files";
import { orchestrationAsset } from "./assets.ts";
import { isProcessIdentity } from "./parent-task.ts";
import { readOutput } from "./panel-output.ts";
import type { NativePanelSurface, HostTarget } from "./host-types.ts";

export interface PanelBinding {
  id: string;
  directory: string;
  creator: ProcessIdentity;
  process?: ProcessIdentity;
}
export interface PanelConfig extends PanelBinding {
  schema: 1;
  token: string;
  argv: string[];
  cwd: string;
  outputPath: string;
  env: Record<string, string>;
  native: { kind: "tmux"; socket: NativePanelSurface["socket"] } | { kind: "herdr" | "emacs" };
}
export interface PanelState {
  schema: 1;
  id: string;
  process: ProcessIdentity;
  command: "held" | "running" | "exited";
  code?: number | null;
  signal?: string | null;
  closed: boolean;
  error?: string;
  /** Processes that a successful Close left running outside the panel. */
  warning?: string;
}
export type PanelInput = { kind: "text"; text: string; enter: boolean } | { kind: "keys"; keys: string[] };

/** Failed native allocation whose owned rollback could not be acknowledged. */
export class PanelStartError extends AggregateError {
  readonly target: HostTarget;
  constructor(original: unknown, cleanup: unknown, target: HostTarget) {
    super([original, cleanup], `${String(original)}\nOwned panel startup cleanup uncertain: ${String(cleanup)}; retained ${target.panel?.directory}`);
    this.target = target;
  }
}


export function panelFile(binding: PanelBinding, name: string): string {
  if (!path.isAbsolute(binding.directory)) throw new Error("Panel control directory must be absolute");
  verifyPrivateDirectory(binding.directory);
  return path.join(binding.directory, name);
}
export function readPanelFile(binding: PanelBinding, name: string): unknown {
  const fd = fs.openSync(panelFile(binding, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    // The owner republishes state by rename: an opened file it has since replaced
    // has no links but is still the complete version current at open.
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.nlink > 1 || stat.size > 64 * 1024) throw new Error("Unsafe panel control file");
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally { fs.closeSync(fd); }
}
export function writePanelState(binding: PanelBinding, state: PanelState): void {
  writePrivateJson(panelFile(binding, "state.json"), state);
}
export function readPanelConfig(binding: PanelBinding): PanelConfig {
  const config = readPanelFile(binding, "config.json") as PanelConfig;
  if (config.schema !== 1 || config.id !== binding.id || config.directory !== binding.directory || !isProcessIdentity(config.creator)
    || !sameProcessIdentity(config.creator, binding.creator) || typeof config.token !== "string" || config.token.length < 32
    || !Array.isArray(config.argv) || !config.argv.length || !config.argv.every(arg => typeof arg === "string")
    || typeof config.cwd !== "string" || !path.isAbsolute(config.cwd) || typeof config.outputPath !== "string" || !path.isAbsolute(config.outputPath) || !config.native || !["tmux", "herdr", "emacs"].includes(config.native.kind)) throw new Error("Invalid panel control binding");
  return config;
}
function stateFor(binding: PanelBinding, value: unknown): PanelState {
  if (typeof value !== "object" || value === null) throw new Error("Invalid panel state");
  const state = value as PanelState;
  if (state.schema !== 1 || state.id !== binding.id || !isProcessIdentity(state.process)
    || (binding.process && !sameProcessIdentity(binding.process, state.process)) || !["held", "running", "exited"].includes(state.command)
    || typeof state.closed !== "boolean" || (state.error !== undefined && typeof state.error !== "string")
    || (state.warning !== undefined && typeof state.warning !== "string")) throw new Error("Panel state identity changed");
  return state;
}
export function savedPanelState(binding: PanelBinding): PanelState | undefined {
  try { return stateFor(binding, readPanelFile(binding, "state.json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
export function createPanelBinding(options: {
  argv: string[]; cwd: string; outputPath?: string; env?: Record<string, string>; creator?: ProcessIdentity; native?: PanelConfig["native"];
}): PanelBinding {
  const creator = options.creator ?? readProcessIdentity(process.pid);
  if (!isProcessIdentity(creator) || !Array.isArray(options.argv) || !options.argv.length || !options.argv.every(arg => typeof arg === "string")
    || !path.isAbsolute(options.cwd) || (options.outputPath !== undefined && !path.isAbsolute(options.outputPath))) throw new Error("Panel requires exact creator, argv and absolute paths");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-panel-runtime-"));
  fs.chmodSync(directory, 0o700);
  const binding = { id: randomUUID(), directory, creator };
  const config: PanelConfig = { schema: 1, ...binding, token: randomUUID(), argv: options.argv, cwd: options.cwd,
    outputPath: options.outputPath ?? path.join(directory, "output.log"), env: options.env ?? {}, native: options.native ?? { kind: "emacs" } };
  try { fs.writeFileSync(panelFile(binding, "config.json"), `${JSON.stringify(config)}\n`, { mode: 0o600, flag: "wx" }); }
  catch (error) {
    try { fs.rmSync(directory, { recursive: true, force: true }); }
    catch (cleanup) { throw new AggregateError([error, cleanup], `${String(error)}\nPanel binding cleanup failed: ${String(cleanup)}`); }
    throw error;
  }
  return binding;
}
export function panelWrapperArgv(binding: PanelBinding): string[] {
  return [process.execPath, orchestrationAsset("./dist/panel-runtime-owner.js"), JSON.stringify(binding)];
}

async function request(binding: PanelBinding, operation: string, input?: PanelInput, signal?: AbortSignal): Promise<PanelState> {
  signal?.throwIfAborted();
  const config = readPanelConfig(binding);
  if (!binding.process) throw new Error("Panel wrapper process identity is required");
  const socketFile = panelFile(binding, "control.sock");
  const stat = fs.lstatSync(socketFile);
  if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) throw new Error("Unsafe panel control socket");
  return await new Promise<PanelState>((resolve, reject) => {
    const socket = net.createConnection(socketFile).setEncoding("utf8");
    let bytes = "";
    const finish = (error?: Error, state?: PanelState): void => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort); socket.destroy();
      if (error) reject(error); else resolve(state!);
    };
    const abort = (): void => finish(new Error("Panel control cancelled; admission may be uncertain"));
    const timer = setTimeout(() => finish(new Error("Panel control timed out; outcome uncertain")), 5000);
    signal?.addEventListener("abort", abort, { once: true });
    socket.once("error", finish);
    socket.once("connect", () => socket.write(`${JSON.stringify({ id: binding.id, token: config.token, process: binding.process, operation, input })}\n`));
    socket.on("data", chunk => {
      bytes += chunk;
      if (bytes.length > 64 * 1024) return finish(new Error("Panel response exceeds its bound"));
      if (!bytes.includes("\n")) return;
      try {
        const response = JSON.parse(bytes.slice(0, bytes.indexOf("\n"))) as { error?: string; state?: unknown };
        if (response.error) finish(new Error(response.error)); else finish(undefined, stateFor(binding, response.state));
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
    socket.once("end", () => { if (!bytes.includes("\n")) finish(new Error("Panel disconnected before acknowledgement")); });
  });
}
export async function waitPanelReady(binding: PanelBinding, signal?: AbortSignal, timeoutMs = 5000): Promise<PanelBinding> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    signal?.throwIfAborted();
    const state = savedPanelState(binding);
    if (state) {
      if (state.closed || state.error) throw new Error(state.error ?? "Panel closed before readiness");
      const ready = { ...binding, process: state.process };
      await request(ready, "status", undefined, signal);
      return ready;
    }
    if (Date.now() >= deadline) throw new Error(`Panel wrapper readiness uncertain; retained ${binding.directory}`);
    await delay(20, undefined, { signal });
  }
}
export async function panelStatus(binding: PanelBinding, signal?: AbortSignal): Promise<PanelState> {
  const saved = savedPanelState(binding);
  if (saved?.closed && processIdentityStatus(saved.process) === "dead") return saved;
  return await request(binding, "status", undefined, signal);
}
export function readPanelOutput(binding: PanelBinding, lines = 80): string {
  const file = readPanelConfig(binding).outputPath;
  try {
    const size = fs.statSync(file).size;
    const chunk = readOutput(file, Math.max(0, size - 64 * 1024), size);
    return [...chunk.lines, ...(chunk.partial ? [chunk.partial] : [])].slice(-Math.max(1, lines)).map(line => line.text).join("\n");
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
}
function cancelPanel(binding: PanelBinding): void {
  const file = panelFile(binding, "cancelled");
  try { fs.writeFileSync(file, "cancelled\n", { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1) throw new Error("Unsafe panel cancellation marker");
  }
}
export async function activatePanel(binding: PanelBinding, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  let cancellationError: unknown;
  const cancel = (): void => {
    try { cancelPanel(binding); }
    catch (error) { cancellationError = error; }
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    await request(binding, "activate", undefined, signal);
    signal?.throwIfAborted();
  } catch (error) {
    if (signal?.aborted) {
      try { await rollbackPanel(binding); }
      catch (cleanup) { throw new AggregateError([error, cancellationError, cleanup].filter(item => item !== undefined), `${String(error)}\nPanel activation rollback uncertain: ${String(cleanup)}${cancellationError ? `\n${String(cancellationError)}` : ""}`); }
      if (cancellationError) throw new AggregateError([error, cancellationError], `${String(error)}\nCould not publish activation cancellation: ${String(cancellationError)}`);
    }
    throw error;
  } finally { signal?.removeEventListener("abort", cancel); }
}
export async function sendPanel(binding: PanelBinding, input: PanelInput, signal?: AbortSignal): Promise<void> {
  await request(binding, "input", input, signal);
}
export async function closePanel(binding: PanelBinding): Promise<void> {
  const state = savedPanelState(binding);
  if (!state) throw new Error(`Panel wrapper has no exit evidence; retained ${binding.directory}`);
  const exact = { ...binding, process: state.process };
  if (!state.closed && processIdentityStatus(state.process) === "dead") throw new Error(`Panel wrapper died without acknowledged child cleanup; outcome uncertain, retained ${binding.directory}`);
  let failure: unknown;
  if (!state.closed) {
    try { await request(exact, "close"); }
    catch (error) { failure = error; }
  }
  const deadline = Date.now() + 8000;
  for (;;) {
    const final = savedPanelState(exact);
    if (final?.closed && processIdentityStatus(final.process) === "dead") return;
    if (final?.error || Date.now() >= deadline) throw new Error([failure ? String(failure) : "", final?.error ?? `Panel shutdown uncertain; retained ${binding.directory}`].filter(Boolean).join("\n"));
    await delay(20);
  }
}
export async function rollbackPanel(binding: PanelBinding): Promise<void> {
  cancelPanel(binding);
  if (savedPanelState(binding)) await closePanel(binding);
}

export const PANEL_RUNTIME = { create: createPanelBinding, argv: panelWrapperArgv, ready: waitPanelReady,
  activate: activatePanel, send: sendPanel, read: readPanelOutput, status: panelStatus, close: closePanel, rollback: rollbackPanel };
export type PanelRuntimeServices = typeof PANEL_RUNTIME;
