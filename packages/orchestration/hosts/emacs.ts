import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { startRuntime, stopRuntime, type ParentTask, type RuntimeReceipt } from "@phimacs/pimux/runtime";
import { processIdentityStatus, type ProcessIdentity } from "@phimacs/pimux/process-identity";
import { canonicalSessionPath } from "@phimacs/pimux/ownership";
import { orchestrationAsset } from "../assets.ts";
import type { Host, HostTarget } from "../host-types.ts";
import { managedHost, processIdentity } from "../managed-launch.ts";
import { serverGone } from "./server-socket.ts";
import { runtimeIdentity, runtimeRequest } from "@phimacs/pimux/request";
import { PANEL_RUNTIME, PanelStartError, type PanelRuntimeServices } from "../panel-runtime.ts";

const COMPANION = orchestrationAsset("./emacs/pi-orchestration.el");
const STARTUP_TIMEOUT_MS = 120_000;
const QUERY_TIMEOUT_MS = 10_000;
const MUTATION_TIMEOUT_MS = 60_000;
const CLOSE_PATIENCE_MS = 30_000;
const QUERY_OPERATIONS = new Set(["state", "response", "read", "switch-state"]);
interface EmacsReply {
  error?: string;
  target?: HostTarget;
  output?: string;
  state?: "running" | "exited" | "missing";
  ready?: boolean;
  pending?: boolean;
  success?: boolean;
  muxId?: string;
}
type RuntimeTarget = HostTarget & { runtime?: RuntimeReceipt; process?: ProcessIdentity };

export type EmacsExec = (command: string, args: string[], options: { signal?: AbortSignal; timeout: number; env?: NodeJS.ProcessEnv })
  => Promise<{ code: number; stdout: string; stderr: string; killed: boolean }>;

export class EmacsUnresponsiveError extends Error {
  constructor(endpoint: string, operation: unknown, detail: string) {
    super(`Emacs ${endpoint} did not answer '${String(operation)}': ${detail}`);
    this.name = "EmacsUnresponsiveError";
  }
}
export async function emacsPoll<T>(query: () => Promise<T>): Promise<T | undefined> {
  try { return await query(); }
  catch (error) { if (error instanceof EmacsUnresponsiveError) return undefined; throw error; }
}
export async function emacsOperation(exec: EmacsExec, endpoint: string, data: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  signal?.throwIfAborted();
  const encoded = Buffer.from(JSON.stringify(data), "utf8").toString("base64");
  const expression = `(progn (require 'pi-orchestration ${JSON.stringify(COMPANION)}) (pi-orchestration-dispatch "${encoded}"))`;
  const timeout = QUERY_OPERATIONS.has(String(data.operation)) ? QUERY_TIMEOUT_MS : MUTATION_TIMEOUT_MS;
  const result = await exec("emacsclient", ["--socket-name", endpoint, "--eval", expression], { signal, timeout });
  signal?.throwIfAborted();
  if (result.killed) throw new EmacsUnresponsiveError(endpoint, data.operation, `no reply within ${timeout / 1000} s; it may be busy.`);
  if (result.code !== 0) throw new Error(`Emacs ${endpoint}: ${result.stderr.trim() || result.stdout.trim()}`);
  const stdout = result.stdout.trim();
  const encodedReply: unknown = stdout ? JSON.parse(stdout) : "";
  if (encodedReply === "") throw new EmacsUnresponsiveError(endpoint, data.operation, "emacsclient returned no reply.");
  if (typeof encodedReply !== "string") throw new Error("Invalid Emacs operation response");
  const reply = JSON.parse(Buffer.from(encodedReply, "base64").toString("utf8")) as Record<string, unknown>;
  if (typeof reply.error === "string" && reply.error) throw new Error(`Emacs ${endpoint}: ${reply.error}`);
  return reply;
}

/** Runtime operations are separate from the native UI boundary (also a synthetic-test seam). */
export interface EmacsRuntimeServices {
  start: typeof startRuntime;
  stop: typeof stopRuntime;
  request: typeof runtimeRequest;
  identity: typeof runtimeIdentity;
}
const RUNTIME: EmacsRuntimeServices = { start: startRuntime, stop: stopRuntime, request: runtimeRequest, identity: runtimeIdentity };

export function createEmacsHost(pi: Pick<ExtensionAPI, "exec">, endpoint: string, runtime: EmacsRuntimeServices = RUNTIME, panels: PanelRuntimeServices = PANEL_RUNTIME): Host {
  async function call(data: Record<string, unknown>, signal?: AbortSignal): Promise<EmacsReply> {
    return await emacsOperation(async (command, args, { signal, timeout }) => {
      const result = await pi.exec(command, args, { signal, timeout, maxBuffer: 1024 * 1024 });
      if (result.truncated) throw new Error("Emacs control output was truncated");
      return result;
    }, endpoint, data, signal) as EmacsReply;
  }
  async function goneWithServer(error: unknown): Promise<void> {
    if (!await serverGone(endpoint)) throw error;
  }
  async function closeView(id: string, muxId?: string, taskOwned = false, panelId?: string): Promise<void> {
    if (panelId) {
      // A lost reply is not permission to repeat a native panel mutation.
      try {
        const reply = await call({ operation: "close", id, detachOnly: true, taskOwned, panelId });
        if (reply.success !== true || reply.pending) throw new Error(`Emacs did not acknowledge panel Close for ${id}`);
      } catch (error) { await goneWithServer(error); }
      return;
    }
    const deadline = Date.now() + CLOSE_PATIENCE_MS;
    for (;;) {
      let reply: EmacsReply | undefined;
      try { reply = await emacsPoll(() => call({ operation: "close", id, detachOnly: true, taskOwned, ...(muxId ? { muxId } : {}), ...(panelId ? { panelId } : {}) })); }
      catch (error) { await goneWithServer(error); return; }
      if (reply && !reply.pending) return;
      if (Date.now() >= deadline) { await goneWithServer(new Error(`Emacs ${endpoint} did not detach ${id}`)); return; }
      await delay(50);
    }
  }
  const host: Host = {
    kind: "emacs", endpoint,
    parent() {
      const id = process.env.PI_ORCHESTRATION_TARGET;
      return id ? { host: "emacs", endpoint, id, name: id, kind: "pi" } : undefined;
    },
    async start(spec, signal) {
      const id = randomUUID();
      let receipt: RuntimeReceipt | undefined;
      let runtimeEnv: NodeJS.ProcessEnv = process.env;
      if (spec.kind === "shell") {
        signal?.throwIfAborted();
        const panel = panels.create({ argv: spec.argv, cwd: spec.cwd, outputPath: spec.outputPath,
          env: { ...spec.env, PI_ORCHESTRATION_HOST: "emacs", PI_ORCHESTRATION_ENDPOINT: endpoint, PI_ORCHESTRATION_TARGET: id }, native: { kind: "emacs" } });
        let target: HostTarget = { host: "emacs", endpoint, id, kind: "shell", name: spec.name,
          panel, owner: panel.creator, ...(spec.outputPath ? { outputPath: spec.outputPath } : {}) };
        try {
          const reply = await call({ operation: "start", id, endpoint, spec: { ...spec, argv: panels.argv(panel), panel,
            panelControl: [process.execPath, orchestrationAsset("./dist/panel-close.js"), JSON.stringify(panel)] } }, signal);
          if (!reply.target || reply.target.id !== id) throw new Error("Emacs start returned no exact panel target");
          target = { ...target, panel: await panels.ready(panel, signal) };
          signal?.throwIfAborted();
          return target;
        } catch (error) {
          try {
            await panels.rollback(panel);
            // A queued Emacs mutation can allocate after a cancelled client.
            // Its cancellation marker prevents work, but absence is not exit.
            if (!(await panels.status(panel)).closed) throw new Error("Native allocation exit is not acknowledged");
            await closeView(id, undefined, false, panel.id);
          } catch (cleanup) { throw new PanelStartError(error, cleanup, target); }
          throw error;
        }
      }
      try {
        const env = { ...process.env, ...spec.env,
          PI_ORCHESTRATION_HOST: "emacs", PI_ORCHESTRATION_ENDPOINT: endpoint, PI_ORCHESTRATION_TARGET: id,
          PI_ORCHESTRATION_PLACEMENT: spec.placement,
          PHIMACS_PARENT_TASK: spec.placement === "worker" ? spec.env?.PHIMACS_PARENT_TASK ?? "" : "",
          PHIMACS_PARENT_TASK_FILE: spec.placement === "worker" ? spec.env?.PHIMACS_PARENT_TASK_FILE ?? "" : "",
        };
        runtimeEnv = env;
        const selected = managedHost(env);
        let parent: ParentTask | undefined;
        if (spec.placement === "worker") {
          const value: unknown = env.PHIMACS_PARENT_TASK ? JSON.parse(env.PHIMACS_PARENT_TASK) : undefined;
          if (typeof value !== "object" || value === null || !("process" in value) || !("taskId" in value)
            || !processIdentity(value.process) || typeof value.taskId !== "string" || !value.taskId) throw new Error("Detached worker requires a parent process identity and task ID");
          parent = { process: processIdentity(value.process)!, taskId: value.taskId };
        }
        receipt = spec.runtime ?? await runtime.start({
          command: selected.executable, args: ["--mode", "rpc", "--session", spec.sessionFile, ...spec.args], cwd: spec.cwd,
          env, signal, ...(parent ? { parent } : {}),
        });
        if (spec.placement === "worker" && receipt.outcome === "attached" && !spec.runtime) {
          throw new Error("Worker session already has a live runtime; continue through its owning parent task");
        }
        if (canonicalSessionPath(receipt.sessionFile) !== canonicalSessionPath(spec.sessionFile)) throw new Error("Detached runtime receipt names a different session");
        const identity = runtime.identity(receipt, env);
        const target: RuntimeTarget = { host: "emacs", endpoint, id, name: spec.name, kind: "pi", sessionFile: receipt.sessionFile, runtime: receipt, process: identity };
        // The prompt goes to the owned runtime, not through the view, so work starts
        // while Pilish draws the transcript; its attach snapshot covers a running turn.
        if (spec.prompt) await host.send(target, { kind: "prompt", text: spec.prompt }, signal);
        const attached = await call({ operation: "start", id, endpoint, spec: { ...spec, runtime: receipt, process: identity } }, signal);
        if (attached.target?.id !== id || attached.muxId !== receipt.muxId) throw new Error("Emacs attached a different runtime identity");
        const deadline = Date.now() + STARTUP_TIMEOUT_MS;
        for (;;) {
          signal?.throwIfAborted();
          const state = await emacsPoll(() => call({ operation: "state", id }, signal));
          if (state?.ready && state.muxId === receipt.muxId) break;
          if (state?.error) throw new Error(state.error);
          if (processIdentityStatus(identity) === "dead") {
            // The prompt went to the runtime before attachment, so a worker can
            // finish and exit first. Its task result, not view readiness, decides.
            if (spec.placement === "worker") break;
            throw new Error("Detached Pi exited during frontend attachment");
          }
          if (Date.now() >= deadline) throw new Error(`Emacs attachment timed out; runtime ${receipt.muxId} remains independently owned`);
          await delay(50, undefined, { signal });
        }
        return target;
      } catch (error) {
        // A failed view is not proof that Pi died. Stop only this operation's new
        // task-owned worker, never an attached owner or an independent root/fork.
        let cleanupFailure = "";
        if (receipt?.outcome === "started" && spec.kind === "pi" && spec.placement === "worker" && !spec.runtime) {
          try { await runtime.stop(receipt.muxId, { env: { ...runtimeEnv, PIMUX_DIR: path.dirname(receipt.socket) } }); }
          catch (stopError) { cleanupFailure = ` Owned worker cleanup is uncertain: ${String(stopError)}.`; }
        }
        if (!cleanupFailure) {
          try { await closeView(id, receipt?.muxId); }
          catch (viewError) { cleanupFailure = ` Frontend cleanup failed: ${String(viewError)}.`; }
        }
        const retained = receipt ? ` Runtime ${receipt.muxId}; no prompt was replayed.` : "";
        throw new Error(`${error instanceof Error ? error.message : String(error)}${retained}${cleanupFailure}`);
      }
    },
    async send(target, input, signal) {
      const owned = target as RuntimeTarget;
      if (target.kind === "pi") {
        if (!owned.runtime || !owned.process) throw new Error("Managed Pi target lacks runtime ownership identity");
        if (input.kind !== "prompt") throw new Error("Pilish targets accept prompts, not terminal keys");
        const reply = await runtime.request(owned.runtime, { type: "prompt", message: input.text, streamingBehavior: "steer" }, signal);
        if (reply.success !== true) throw new Error(`Pi rejected prompt: ${String(reply.error ?? "unknown error")}`);
      } else {
        if (!target.panel || input.kind === "prompt") throw new Error("Shell input requires its exact persistent panel binding");
        await panels.send(target.panel, input, signal);
      }
    },
    async read(target, lines = 80, signal) {
      const owned = target as RuntimeTarget;
      if (target.kind !== "pi") {
        signal?.throwIfAborted();
        if (!target.panel) throw new Error("Shell read requires its exact persistent panel binding");
        return panels.read(target.panel, lines);
      }
      if (!owned.runtime) throw new Error("Managed Pi target lacks runtime identity");
      const reply = await runtime.request(owned.runtime, { type: "get_messages" }, signal);
      if (reply.success !== true) throw new Error(String(reply.error ?? "Cannot read runtime transcript"));
      const data = reply.data as { messages?: unknown[] } | undefined;
      return JSON.stringify(data?.messages ?? [], null, 2).split("\n").slice(-Math.max(1, lines)).join("\n");
    },
    async state(target, signal) {
      signal?.throwIfAborted();
      if (target.kind === "pi") {
        const identity = (target as RuntimeTarget).process;
        if (!identity) throw new Error("Managed Pi target lacks process-start identity; socket/buffer liveness is not Pi liveness");
        const state = processIdentityStatus(identity);
        if (state === "unknown") throw new Error("Detached Pi liveness is uncertain");
        return state === "alive" ? "running" : "exited";
      }
      if (!target.panel) throw new Error("Shell state requires its exact persistent panel binding");
      const state = await panels.status(target.panel, signal);
      return state.closed ? "missing" : state.command === "exited" ? "exited" : "running";
    },
    async close(target, signal) {
      signal?.throwIfAborted();
      const owned = target as RuntimeTarget;
      if (target.kind === "pi") {
        if (!owned.runtime || !owned.process) throw new Error("Cannot stop an unowned Pi from a socket/buffer PID");
        if (processIdentityStatus(owned.process) !== "dead") await runtime.stop(owned.runtime.muxId, { env: { ...process.env, PIMUX_DIR: path.dirname(owned.runtime.socket) } });
        // closeView suppresses only verified frontend disappearance. A live
        // server's cleanup failure is owned cleanup failure, not success.
        await closeView(target.id, owned.runtime.muxId, true);
      } else {
        if (!target.panel) throw new Error("Shell Close requires its exact persistent panel binding");
        await panels.close(target.panel);
        await closeView(target.id, undefined, false, target.panel.id);
      }
    },
    async taskFinished(target, error) {
      const owned = target as RuntimeTarget;
      if (target.kind !== "pi" || !owned.runtime) return;
      try {
        await call({ operation: "task-finished", id: target.id, muxId: owned.runtime.muxId, ...(error ? { error } : {}) });
      } catch (failure) { await goneWithServer(failure); }
    },
  };
  return host;
}
