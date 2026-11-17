import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI, ExecResult } from "@earendil-works/pi-coding-agent";
import type { Host, HostTarget, NativePanelSurface } from "../host-types.ts";
import { TERMINAL_INPUT_EXTENSION, terminalRequest } from "../terminal-input.ts";
import { serverGone } from "./server-socket.ts";
import { managedTerminalArgv } from "../managed-launch.ts";
import { processIdentityStatus, readProcessIdentity, sameProcessIdentity } from "@phimacs/pimux/process-identity";
import { createNativeSocketPin, nativeRequest } from "./native-surface.ts";
import { PANEL_RUNTIME, PanelStartError, savedPanelState, type PanelRuntimeServices, type PanelBinding } from "../panel-runtime.ts";

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected a Herdr response object");
  return value as JsonObject;
}
function result(raw: string): JsonObject { return object(object(JSON.parse(raw)).result); }
function errorCode(response: ExecResult): string | undefined {
  for (const raw of [response.stdout, response.stderr]) {
    try { const code = object(object(JSON.parse(raw)).error).code; if (typeof code === "string") return code; } catch { /* Native diagnostic. */ }
  }
  return undefined;
}
function failure(response: ExecResult): Error { return new Error([response.stdout.trim(), response.stderr.trim()].filter(Boolean).join("\n") || "Herdr operation failed"); }
const quote = (text: string): string => `'${text.replaceAll("'", `'"'"'`)}'`;
const PANE_GONE = ["pane_not_found", "terminal_not_found"];

export async function captureHerdrPanel(_pi: Pick<ExtensionAPI, "exec">, target: HostTarget, socket: NativePanelSurface["socket"]): Promise<NativePanelSurface> {
  const pane = object((await nativeRequest(socket, "pane.get", { pane_id: target.paneId ?? target.id })).pane);
  const info = object((await nativeRequest(socket, "pane.process_info", { pane_id: target.paneId ?? target.id })).process_info);
  if (pane.pane_id !== (target.paneId ?? target.id) || typeof pane.terminal_id !== "string" || !Number.isSafeInteger(info.shell_pid)) throw new Error("Herdr lacks an exact terminal wrapper identity");
  const process = readProcessIdentity(Number(info.shell_pid));
  if (!process) throw new Error("Herdr wrapper identity is unavailable");
  return { socket, panePid: process.pid, process, terminalId: pane.terminal_id };
}

export function createHerdrHost(pi: Pick<ExtensionAPI, "exec">, endpoint: string, panels: PanelRuntimeServices = PANEL_RUNTIME): Host {
  const parentPane = process.env.HERDR_PANE_ID;
  const workspace = process.env.HERDR_WORKSPACE_ID;
  const binary = process.env.HERDR_BIN_PATH || "herdr";
  const run = async (args: string[], signal?: AbortSignal): Promise<ExecResult> => {
    const response = await pi.exec("env", [`HERDR_SOCKET_PATH=${endpoint}`, binary, ...args], { signal, timeout: 120_000, maxBuffer: 1024 * 1024 });
    if (response.truncated) throw new Error("Herdr control output was truncated");
    return response;
  };
  async function checked(args: string[], signal?: AbortSignal): Promise<string> {
    const response = await run(args, signal);
    if (response.code !== 0 || response.killed) throw failure(response);
    return response.stdout;
  }
  const host: Host = {
    kind: "herdr", endpoint,
    parent: () => parentPane ? { host: "herdr", endpoint, id: parentPane, paneId: parentPane, name: "parent", kind: "pi" } : undefined,
    async start(spec, signal) {
      signal?.throwIfAborted();
      const parent = spec.parent;
      if (!parent || parent.host !== "herdr" || parent.endpoint !== endpoint) throw new Error("Herdr startup requires an explicit parent on the selected server");
      if (spec.kind === "shell") {
        const socket = createNativeSocketPin(endpoint);
        let panel: PanelBinding;
        try { panel = panels.create({ argv: spec.argv, cwd: spec.cwd, outputPath: spec.outputPath, env: spec.env, native: { kind: "herdr" } }); }
        catch (error) {
          try { fs.rmSync(path.dirname(socket.path), { recursive: true, force: true }); }
          catch (cleanup) { throw new AggregateError([error, cleanup], `${String(error)}\nNative socket pin cleanup failed: ${String(cleanup)}`); }
          throw error;
        }
        const target: HostTarget = { host: "herdr", endpoint, id: panel.id, kind: "shell", name: spec.name, owner: panel.creator, panel };
        try {
          const parentInfo = object((await nativeRequest(socket, "pane.get", { pane_id: parent.paneId ?? parent.id }, signal)).pane);
          const workspaceId = typeof parentInfo.workspace_id === "string" ? parentInfo.workspace_id : workspace;
          if (!workspaceId) throw new Error("Could not identify the parent Herdr workspace");
          // layout.apply allocates argv directly. Typing `exec` through a reusable
          // pane alias would not establish a pre-execution ownership boundary.
          const applied = await nativeRequest(socket, "layout.apply", { workspace_id: workspaceId, tab_label: spec.name, focus: false,
            root: { type: "pane", cwd: spec.cwd, label: spec.name, command: panels.argv(panel), env: spec.env ?? {} } });
          const root = object(object(applied.layout).root);
          if (root.type !== "pane" || typeof root.pane_id !== "string") throw new Error("Herdr did not return its new wrapper pane");
          target.id = root.pane_id; target.paneId = root.pane_id;
          target.panel = await panels.ready(panel, signal);
          const surface = await captureHerdrPanel(pi, target, socket);
          if (!surface.process || !target.panel.process || !sameProcessIdentity(surface.process, target.panel.process)) throw new Error("Herdr terminal no longer belongs to the created wrapper");
          target.nativeSurface = surface;
          signal?.throwIfAborted();
          return target;
        } catch (error) {
          try { await panels.rollback(target.panel!); }
          catch (cleanup) { throw new PanelStartError(error, cleanup, target); }
          const final = savedPanelState(target.panel!);
          if (!final?.closed || processIdentityStatus(final.process) !== "dead") throw new PanelStartError(error, "Allocation identity unavailable; late wrapper activation is disabled", target);
          try { fs.rmSync(path.dirname(socket.path), { recursive: true, force: true }); }
          catch (cleanup) { throw new PanelStartError(error, cleanup, target); }
          throw error;
        }
      }
      const argv = managedTerminalArgv(spec, [TERMINAL_INPUT_EXTENSION]);
      let create: string[];
      if (spec.placement === "interactive-fork") {
        const layout = object(result(await checked(["pane", "layout", "--pane", parent.paneId ?? parent.id], signal)).layout);
        const panes = Array.isArray(layout.panes) ? layout.panes.map(object) : [];
        const rect = object(panes.find(pane => pane.pane_id === (parent.paneId ?? parent.id))?.rect);
        create = ["pane", "split", parent.paneId ?? parent.id, "--direction", Number(rect.width) >= Number(rect.height) * 2 ? "right" : "down", "--cwd", spec.cwd, "--no-focus"];
      } else {
        const parentInfo = object(result(await checked(["pane", "get", parent.paneId ?? parent.id], signal)).pane);
        const workspaceId = typeof parentInfo.workspace_id === "string" ? parentInfo.workspace_id : workspace;
        if (!workspaceId) throw new Error("Could not identify the parent Herdr workspace");
        create = ["tab", "create", "--workspace", workspaceId, "--cwd", spec.cwd, "--label", spec.name, "--no-focus"];
      }
      const controlDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-terminal-"));
      const controlPath = path.join(controlDir, "input.sock");
      for (const [key, value] of Object.entries(spec.env ?? {})) create.push("--env", `${key}=${value}`);
      create.push("--env", `PI_ORCHESTRATION_CONTROL=${controlPath}`);
      let target: HostTarget | undefined;
      try {
        const created = result(await checked(create));
        const pane = object(created.pane ?? created.root_pane);
        if (typeof pane.pane_id !== "string") throw new Error("Herdr did not return a pane identity");
        const paneId = pane.pane_id;
        target = { host: "herdr", endpoint, id: paneId, paneId, name: spec.name, kind: "pi", controlPath, sessionFile: spec.sessionFile };
        signal?.throwIfAborted();
        await checked(["pane", "run", paneId, `exec ${argv.map(quote).join(" ")}`], signal);
        const deadline = Date.now() + 30_000;
        for (;;) {
          signal?.throwIfAborted();
          try { target.process = (await terminalRequest(controlPath, { kind: "ping", sessionFile: spec.sessionFile }, signal)).process; break; }
          catch (error) {
            if (Date.now() >= deadline || await host.state(target, signal) !== "running") throw error;
            await delay(50, undefined, { signal });
          }
        }
        const namingDeadline = Date.now() + 5_000;
        for (;;) {
          const named = await run(["agent", "rename", paneId, spec.name], signal);
          if (named.code === 0 && !named.killed) break;
          if (errorCode(named) !== "agent_not_found" || Date.now() >= namingDeadline) throw failure(named);
          await delay(100, undefined, { signal });
        }
        if (spec.prompt) await host.send(target, { kind: "prompt", text: spec.prompt }, signal);
        return target;
      } catch (error) {
        try { if (target) await host.close(target); else fs.rmSync(controlDir, { recursive: true, force: true }); }
        catch (cleanup) { throw new AggregateError([error, cleanup], `${String(error)}\nNative startup cleanup failed: ${String(cleanup)}`); }
        throw error;
      }
    },
    async send(target, input, signal) {
      if (target.kind === "shell") {
        if (!target.panel || input.kind === "prompt") throw new Error("Shell panel input requires its exact owned control endpoint");
        await panels.send(target.panel, input, signal); return;
      }
      if (input.kind === "prompt") {
        if (!target.controlPath || !target.process) throw new Error("Pi prompt submission requires its owned terminal input endpoint and process identity");
        await terminalRequest(target.controlPath, { ...input, process: target.process }, signal);
      } else if (input.kind === "text") {
        await checked(["pane", input.enter ? "run" : "send-text", target.paneId ?? target.id, input.text], signal);
      } else await checked(["pane", "send-keys", target.paneId ?? target.id, ...input.keys], signal);
    },
    async read(target, lines = 80, signal) {
      if (target.kind === "shell") {
        signal?.throwIfAborted();
        if (!target.panel) throw new Error("Shell panel read requires its owned capture");
        return panels.read(target.panel, lines);
      }
      const pane = target.paneId ?? target.id;
      const info = object(result(await checked(["pane", "get", pane], signal)).pane);
      const rows = typeof info.scroll === "object" && info.scroll !== null ? Number(object(info.scroll).viewport_rows ?? 0) : 0;
      return (await checked(["pane", "read", pane, "--source", "recent", "--lines", String(lines + rows)], signal)).trimEnd().split("\n").slice(-lines).join("\n");
    },
    async state(target, signal) {
      if (target.kind === "shell") {
        if (!target.panel) throw new Error("Shell panel lacks persistent ownership identity");
        const state = await panels.status(target.panel, signal);
        if (state.error) throw new Error(state.error);
        return state.closed ? "missing" : state.command === "exited" ? "exited" : "running";
      }
      if (target.process) {
        signal?.throwIfAborted();
        const state = processIdentityStatus(target.process);
        if (state === "unknown") throw new Error("Managed terminal process identity is uncertain");
        return state === "alive" ? "running" : "exited";
      }
      const response = await run(["pane", "get", target.paneId ?? target.id], signal);
      if (response.killed) throw new Error("Herdr state query timed out");
      if (response.code !== 0) {
        if (PANE_GONE.includes(errorCode(response) ?? "") || await serverGone(endpoint)) return "missing";
        throw failure(response);
      }
      return "running";
    },
    async close(target, signal) {
      if (target.kind === "shell") {
        if (!target.panel) throw new Error("Shell panel close requires exact owned control endpoint");
        await panels.close(target.panel);
        if (target.nativeSurface) fs.rmSync(path.dirname(target.nativeSurface.socket.path), { recursive: true, force: true });
        return;
      }
      if (target.process && processIdentityStatus(target.process) !== "dead" && target.controlPath) {
        await terminalRequest(target.controlPath, { kind: "stop", process: target.process }, signal).catch(() => undefined);
      }
      const response = await run(["pane", "close", target.paneId ?? target.id], signal);
      if (response.code !== 0 && !PANE_GONE.includes(errorCode(response) ?? "") && !await serverGone(endpoint)) throw failure(response);
      if (target.process) {
        const deadline = Date.now() + 10_000;
        while (processIdentityStatus(target.process) !== "dead") {
          if (Date.now() >= deadline) throw new Error("Managed terminal shutdown uncertain; session remains claimed");
          await delay(50, undefined, { signal });
        }
      }
      if (target.controlPath) fs.rmSync(path.dirname(target.controlPath), { recursive: true, force: true });
    },
  };
  return host;
}
