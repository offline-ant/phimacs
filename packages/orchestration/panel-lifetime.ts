import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { orchestrationAsset } from "./assets.ts";
import type { HostTarget } from "./host-types.ts";
import { readProcessIdentity, processIdentityStatus, sameProcessIdentity } from "@phimacs/pimux/process-identity";
import { retainPanelObserverFailure, validatePanelOwner } from "./panel-owner.ts";
import { activatePanel, rollbackPanel, savedPanelState, type PanelBinding } from "./panel-runtime.ts";
import { readTarget, saveTarget } from "./workers.ts";

interface PanelLifetimeServices {
  launch(target: HostTarget): ChildProcess;
  activate(binding: PanelBinding, signal?: AbortSignal): Promise<void>;
}
const SERVICES: PanelLifetimeServices = {
  launch(target) {
    return spawn(process.execPath, [orchestrationAsset("./dist/panel-owner.js"), JSON.stringify(target)], {
      detached: true, stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
  },
  activate: activatePanel,
};

/** Register a detached observer, then activate through the common owned control.
 * The caller holds panel-start's name claim through registration and activation.
 * Cancellation never releases held work and awaits owned rollback, without using
 * the cancelled signal. Uncertain rollback retains the binding and diagnostics. */
export async function ownPanel(target: HostTarget, signal?: AbortSignal, services: PanelLifetimeServices = SERVICES): Promise<void> {
  let child: ChildProcess | undefined;
  try {
    if (target.kind !== "shell" || !target.owner || !target.panel
      || !sameProcessIdentity(target.owner, target.panel.creator)) throw new Error("Panel requires its creating Pi and persistent control binding");
    signal?.throwIfAborted();
    if (!isDeepStrictEqual(readTarget(target.name), target)) throw new Error("Panel registry changed before observer launch");
    // This write is protected by the caller's existing panel-start claim.
    target.observerErrorPath ??= path.join(target.panel.directory, "observer-error.log");
    saveTarget(target);
    validatePanelOwner(target);
    child = services.launch(target);
    const observer = child;
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-64 * 1024); });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", aborted);
        observer.removeListener("error", fail);
        observer.removeListener("close", exited);
        observer.removeListener("message", ready);
        if (error) reject(error); else resolve();
      };
      const fail = (error: Error): void => finish(error);
      const exited = (): void => finish(new Error(`Panel lifetime observer exited before readiness${stderr ? `: ${stderr.trim()}` : ""}`));
      const aborted = (): void => finish(new Error("Panel startup cancelled before activation"));
      const ready = (message: unknown): void => {
        if (signal?.aborted) { aborted(); return; }
        if (message === "ready") observer.send("start", error => { if (error) fail(error); });
        else if (message === "started") finish();
        else if (typeof message === "string" && message.startsWith("error:")) fail(new Error(message.slice(6)));
      };
      const timeout = setTimeout(() => finish(new Error("Panel lifetime observer did not become ready")), 5000);
      observer.once("error", fail);
      observer.once("close", exited);
      observer.on("message", ready);
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
    });
    signal?.throwIfAborted();
    validatePanelOwner(target);
    await services.activate(target.panel, signal);
    signal?.throwIfAborted();
  } catch (error) {
    if (target.panel) target.observerErrorPath ??= path.join(target.panel.directory, "observer-error.log");
    let failure = error;
    let acknowledged = false;
    if (target.panel) {
      try {
        await rollbackPanel(target.panel);
        const final = savedPanelState(target.panel);
        if (!final?.closed || processIdentityStatus(final.process) !== "dead") throw new Error("Panel rollback lacks authoritative wrapper exit evidence");
        acknowledged = true;
      }
      catch (cleanup) { failure = new AggregateError([error, cleanup], `${String(error)}\nOwned panel rollback uncertain: ${String(cleanup)}`); }
    }
    if (child && acknowledged && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.kill();
      try { await closed; }
      catch (cleanup) { failure = new AggregateError([failure, cleanup], `${String(failure)}\nObserver cleanup failed: ${String(cleanup)}`); }
    }
    retainPanelObserverFailure(target, failure);
  } finally {
    if (child?.connected) child.disconnect();
    child?.stderr?.destroy();
    child?.unref();
  }
}

export function panelOwner(): NonNullable<HostTarget["owner"]> {
  const owner = readProcessIdentity(process.pid);
  if (!owner) throw new Error("Cannot establish panel owner's process-start identity");
  return owner;
}
