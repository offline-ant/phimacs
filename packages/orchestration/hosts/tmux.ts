import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Host, HostTarget, NativePanelSurface } from "../host-types.ts";
import { managedTerminalArgv } from "../managed-launch.ts";
import { processIdentityStatus, readProcessIdentity, sameProcessIdentity } from "@phimacs/pimux/process-identity";
import { createNativeSocketPin, validateNativeSocket } from "./native-surface.ts";
import { PANEL_RUNTIME, PanelStartError, savedPanelState, type PanelRuntimeServices, type PanelBinding } from "../panel-runtime.ts";
import { TERMINAL_INPUT_EXTENSION, terminalRequest } from "../terminal-input.ts";
const quote = (text: string): string => `'${text.replaceAll("'", `'"'"'`)}'`;
const SURFACE_FORMAT = "#{pid}\t#{pane_id}\t#{pane_pid}\t#{pane_dead}";

export async function captureTmuxPanel(pi: Pick<ExtensionAPI, "exec">, target: HostTarget, socket: NativePanelSurface["socket"]): Promise<NativePanelSurface> {
  validateNativeSocket(socket);
  const result = await pi.exec("tmux", ["-S", socket.path, "display-message", "-p", "-t", target.id, SURFACE_FORMAT], { timeout: 10_000, maxBuffer: 1024 * 1024 });
  if (result.truncated) throw new Error("tmux control output was truncated");
  const [serverPid, pane, panePid, dead] = result.stdout.trim().split("\t");
  if (result.code !== 0 || result.killed || pane !== target.id || !/^\d+$/.test(serverPid ?? "") || !/^\d+$/.test(panePid ?? "") || dead !== "0") throw new Error("Cannot capture the live owned tmux wrapper surface");
  const server = readProcessIdentity(Number(serverPid));
  const process = readProcessIdentity(Number(panePid));
  if (!server || !process) throw new Error("Native tmux wrapper/server identity is unavailable");
  return { socket, server, panePid: Number(panePid), process };
}

export function createTmuxHost(pi: Pick<ExtensionAPI, "exec">, endpoint: string, panels: PanelRuntimeServices = PANEL_RUNTIME): Host {
  const parentPane = process.env.TMUX_PANE;
  const run = async (args: string[], signal?: AbortSignal) => {
    const result = await pi.exec("tmux", ["-S", endpoint, ...args], { signal, timeout: 30_000, maxBuffer: 1024 * 1024 });
    if (result.truncated) throw new Error("tmux control output was truncated");
    return result;
  };
  async function checked(args: string[], signal?: AbortSignal): Promise<string> {
    const result = await run(args, signal);
    if (result.code !== 0 || result.killed) throw new Error(result.stderr.trim() || result.stdout.trim() || `tmux ${args[0]} failed`);
    return result.stdout;
  }
  const host: Host = {
    kind: "tmux", endpoint,
    parent: () => parentPane ? { host: "tmux", endpoint, id: parentPane, paneId: parentPane, kind: "pi", name: "parent" } : undefined,
    async start(spec, signal) {
      signal?.throwIfAborted();
      const parent = spec.parent;
      if (!parent || parent.host !== "tmux" || parent.endpoint !== endpoint) throw new Error("Tmux startup requires an explicit parent on the selected server");
      if (spec.kind === "shell") {
        const socket = createNativeSocketPin(endpoint);
        let panel: PanelBinding;
        try { panel = panels.create({ argv: spec.argv, cwd: spec.cwd, outputPath: spec.outputPath, env: spec.env, native: { kind: "tmux", socket } }); }
        catch (error) {
          try { fs.rmSync(path.dirname(socket.path), { recursive: true, force: true }); }
          catch (cleanup) { throw new AggregateError([error, cleanup], `${String(error)}\nNative socket pin cleanup failed: ${String(cleanup)}`); }
          throw error;
        }
        const target: HostTarget = { host: "tmux", endpoint, id: panel.id, name: spec.name, kind: "shell", owner: panel.creator, panel };
        const native = async (args: string[]): Promise<string> => {
          validateNativeSocket(socket);
          const response = await pi.exec("tmux", ["-S", socket.path, ...args], { timeout: 30_000, maxBuffer: 1024 * 1024 });
          if (response.truncated) throw new Error("tmux control output was truncated");
          if (response.code !== 0 || response.killed) throw new Error(response.stderr || response.stdout || "Native panel allocation failed");
          return response.stdout;
        };
        try {
          const location = spec.placement === "interactive-fork" ? parent.id
            : (await native(["display-message", "-p", "-t", parent.id, "#{session_id}"])).trim();
          const args = spec.placement === "interactive-fork" ? ["split-window", "-d", "-t", location]
            : ["new-window", "-d", "-t", location, "-n", spec.name];
          args.push("-P", "-F", SURFACE_FORMAT, "-c", spec.cwd, "/bin/sh", "-c", `exec ${panels.argv(panel).map(quote).join(" ")}`);
          const receipt = (await native(args)).trim().split("\t");
          if (!/^%\d+$/.test(receipt[1] ?? "")) throw new Error("Invalid native tmux panel receipt");
          target.id = receipt[1]; target.paneId = receipt[1];
          target.panel = await panels.ready(panel, signal);
          const surface = await captureTmuxPanel(pi, target, socket);
          if (!surface.process || !target.panel.process || !sameProcessIdentity(surface.process, target.panel.process)
            || String(surface.server?.pid) !== receipt[0] || String(surface.panePid) !== receipt[2]) throw new Error("Native panel receipt does not identify its wrapper");
          target.nativeSurface = surface;
          signal?.throwIfAborted();
          return target;
        } catch (error) {
          try { await panels.rollback(target.panel!); }
          catch (cleanup) { throw new PanelStartError(error, cleanup, target); }
          // An unacknowledged allocation may still launch a cancelled wrapper.
          // Keep its capability/evidence instead of guessing native pane IDs.
          const final = savedPanelState(target.panel!);
          if (!final?.closed || processIdentityStatus(final.process) !== "dead") throw new PanelStartError(error, "Allocation identity unavailable; late wrapper activation is disabled", target);
          try { fs.rmSync(path.dirname(socket.path), { recursive: true, force: true }); }
          catch (cleanup) { throw new PanelStartError(error, cleanup, target); }
          throw error;
        }
      }
      const controlDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-terminal-"));
      const controlPath = path.join(controlDir, "input.sock");
      let target: HostTarget | undefined;
      try {
        const argv = managedTerminalArgv(spec, [TERMINAL_INPUT_EXTENSION]);
        const args = spec.placement === "interactive-fork"
          ? ["split-window", "-d", "-t", parent.id, "-P", "-F", "#{pane_id}", "-c", spec.cwd]
          : ["new-window", "-d", "-t", (await checked(["display-message", "-p", "-t", parent.id, "#{session_id}"], signal)).trim(), "-n", spec.name, "-P", "-F", "#{pane_id}", "-c", spec.cwd];
        for (const [key, value] of Object.entries({ ...spec.env, PI_ORCHESTRATION_CONTROL: controlPath })) args.push("-e", `${key}=${value}`);
        args.push("/bin/sh", "-lc", `tmux -S ${quote(endpoint)} set-option -p -t "$TMUX_PANE" remain-on-exit on; exec ${argv.map(quote).join(" ")}`);
        const id = (await checked(args)).trim();
        if (!/^%\d+$/.test(id)) throw new Error(`Invalid tmux pane identity: ${id}`);
        target = { host: "tmux", endpoint, id, paneId: id, name: spec.name, kind: "pi", sessionFile: spec.sessionFile, controlPath };
        const deadline = Date.now() + 30_000;
        for (;;) {
          signal?.throwIfAborted();
          try { target.process = (await terminalRequest(controlPath, { kind: "ping", sessionFile: spec.sessionFile }, signal)).process; break; }
          catch (error) {
            if (Date.now() >= deadline || await host.state(target, signal) !== "running") throw error;
            await delay(50, undefined, { signal });
          }
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
        await checked(["send-keys", "-t", target.id, "-l", "--", input.text], signal);
        if (input.enter) await checked(["send-keys", "-t", target.id, "Enter"], signal);
      } else await checked(["send-keys", "-t", target.id, ...input.keys.map(key => key.replace(/ctrl\+/ig, "C-").replace(/alt\+/ig, "M-").replace(/shift\+/ig, "S-"))], signal);
    },
    async read(target, lines = 80, signal) {
      if (target.kind === "shell") {
        signal?.throwIfAborted();
        if (!target.panel) throw new Error("Shell panel read requires its owned capture");
        return panels.read(target.panel, lines);
      }
      const socket = target.nativeSurface?.socket;
      if (socket) validateNativeSocket(socket);
      const result = await pi.exec("tmux", ["-S", socket?.path ?? endpoint, "capture-pane", "-p", "-t", target.id, "-S", `-${Math.max(1, lines)}`], { signal, timeout: 30_000, maxBuffer: 1024 * 1024 });
      if (result.truncated) throw new Error("tmux capture output was truncated");
      if (result.code !== 0 || result.killed) throw new Error(result.stderr || "Cannot read native panel");
      return result.stdout.trimEnd().split("\n").slice(-Math.max(1, lines)).join("\n");
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
      const response = await run(["display-message", "-p", "-t", target.id, "#{pane_dead}"], signal);
      if (response.killed) throw new Error("tmux state query timed out");
      return response.code !== 0 || !response.stdout.trim() ? "missing" : response.stdout.trim() === "1" ? "exited" : "running";
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
      const pane = await run(["display-message", "-p", "-t", target.id, "#{pane_id}"], signal);
      if (pane.killed) throw new Error("Cannot verify the owned tmux surface");
      if (pane.code === 0) await checked(["kill-pane", "-t", target.id], signal);
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
