import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { processIdentityStatus, sameProcessIdentity } from "@phimacs/pimux/process-identity";
import type { HostTarget } from "./host-types.ts";
import { createEmacsHost } from "./hosts/emacs.ts";
import { createHerdrHost } from "./hosts/herdr.ts";
import { createTmuxHost } from "./hosts/tmux.ts";
import { removePanelOutput } from "./panel-output.ts";
import { isProcessIdentity } from "./parent-task.ts";
import { claimNameForOperation, readTarget, removeTarget, saveTarget } from "./workers.ts";

const execute = promisify(execFile);
const exec: ExtensionAPI["exec"] = async (command, args, options) => {
  try {
    const { stdout, stderr } = await execute(command, args, { ...options, maxBuffer: 1024 * 1024 });
    return { stdout, stderr, code: 0, killed: false, truncated: false };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: string; stderr?: string; killed?: boolean };
    const truncated = failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
    if (typeof failure.code !== "number" && !failure.killed && !truncated) throw error;
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: typeof failure.code === "number" ? failure.code : 1, killed: failure.killed === true || truncated, truncated };
  }
};

async function closeNativePanel(target: HostTarget): Promise<void> {
  const api = { exec };
  const host = target.host === "tmux" ? createTmuxHost(api, target.endpoint)
    : target.host === "herdr" ? createHerdrHost(api, target.endpoint)
      : createEmacsHost(api, target.endpoint);
  await host.close(target);
}

interface PanelOwnerServices {
  status: typeof processIdentityStatus;
  read: typeof readTarget;
  claim: typeof claimNameForOperation;
  close: typeof closeNativePanel;
  removeOutput: typeof removePanelOutput;
  remove: typeof removeTarget;
  save: typeof saveTarget;
  diagnostic?: (file: string, detail: string) => void;
  wait: () => Promise<void>;
}
const SERVICES: PanelOwnerServices = {
  status: processIdentityStatus, read: readTarget, claim: claimNameForOperation,
  close: closeNativePanel, removeOutput: removePanelOutput, remove: removeTarget, save: saveTarget,
  diagnostic(file, detail) {
    const directory = fs.lstatSync(path.dirname(file));
    if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0) throw new Error("Unsafe observer diagnostic directory");
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeSync(fd, `${detail}\n`); } finally { fs.closeSync(fd); }
  },
  wait: () => delay(250),
};

function samePanel(expected: HostTarget, current: HostTarget | undefined): current is HostTarget {
  return current !== undefined && current.kind === "shell" && current.host === expected.host
    && current.endpoint === expected.endpoint && current.id === expected.id && current.outputPath === expected.outputPath
    && current.observerErrorPath === expected.observerErrorPath && isDeepStrictEqual(current.nativeSurface, expected.nativeSurface)
    && isDeepStrictEqual(current.panel, expected.panel)
    && current.owner !== undefined && expected.owner !== undefined && sameProcessIdentity(current.owner, expected.owner);
}

export function validatePanelOwner(target: HostTarget, services: Pick<PanelOwnerServices, "read"> = SERVICES): void {
  if (target.kind !== "shell" || !isProcessIdentity(target.owner)) throw new Error("Panel lifetime requires an exact creating process identity");
  if (!samePanel(target, services.read(target.name))) throw new Error("Panel registry ownership changed before observer readiness");
}

/** Keep diagnostics even if the registry cannot be read; never overwrite a
 * replacement name. Failures in diagnostic retention preserve the original. */
export function retainPanelObserverFailure(target: HostTarget, error: unknown, services: PanelOwnerServices = SERVICES): never {
  const errors: unknown[] = [error];
  const detail = `Native panel observer failed: ${error instanceof Error ? error.message : String(error)}`;
  // This path also runs while panel-start already holds the name claim. Never
  // read/check/save the registry here: an unlocked diagnostic write can replace
  // a newly registered panel. Keep bootstrap/out-of-claim errors private only.
  if (target.observerErrorPath) {
    try { services.diagnostic?.(target.observerErrorPath, detail); }
    catch (diagnosticError) { errors.push(diagnosticError); }
  }
  if (errors.length > 1) throw new AggregateError(errors, `${detail}\nDiagnostic retention failed: ${errors.slice(1).map(String).join("; ")}`);
  throw error;
}

/** Unknown creator liveness and frontend disconnection never authorize cleanup.
 * All failures, including reads/claims/waits/releases, retain diagnostics. */
export async function observePanelOwner(target: HostTarget, services: PanelOwnerServices = SERVICES): Promise<void> {
  try {
    if (target.kind !== "shell" || !isProcessIdentity(target.owner)) throw new Error("Panel lifetime requires an exact creating process identity");
    for (;;) {
      if (!samePanel(target, services.read(target.name))) return;
      if (services.status(target.owner) !== "dead") { await services.wait(); continue; }
      const release = await services.claim(target.name);
      try {
        const current = services.read(target.name);
        if (!samePanel(target, current)) return;
        try {
          await services.close(current);
          services.removeOutput(current.outputPath);
          services.remove(current.name);
        } catch (error) {
          // The name claim still proves this exact registration is ours.
          const detail = `Native panel cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
          try { services.save({ ...current, closeError: [current.closeError, detail].filter(Boolean).join("\n") }); }
          catch (recordError) { throw new AggregateError([error, recordError], `${detail}\nCould not retain cleanup diagnostic: ${String(recordError)}`); }
          throw error;
        }
      } finally { release(); }
      return;
    }
  } catch (error) { retainPanelObserverFailure(target, error, services); }
}

/** Readiness is validation, not cleanup completion. The start/disconnect gate
 * prevents an already-dead creator from letting the observer finish before its
 * launcher has received readiness. Creator loss opens the gate too. */
export async function runPanelObserver(target: HostTarget, ready: () => Promise<void>, started: () => Promise<void>, start: Promise<void>, services: PanelOwnerServices = SERVICES): Promise<void> {
  try {
    validatePanelOwner(target, services);
    await ready();
    await start;
    await started();
  } catch (error) { retainPanelObserverFailure(target, error, services); }
  await observePanelOwner(target, services);
}

// Node runs the main module from its real path; compare real paths so a
// symlinked invocation does not silently skip the entry point.
if (process.argv[1] && fs.existsSync(process.argv[1]) && pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url) {
  const target = JSON.parse(process.argv[2] ?? "null") as HostTarget;
  let begin: () => void = () => {};
  const start = new Promise<void>((resolve) => { begin = resolve; });
  const requested = (message: unknown): void => { if (message === "start") begin(); };
  process.on("message", requested);
  process.once("disconnect", begin);
  if (!process.connected) begin();
  const send = (message: string): Promise<void> => new Promise((resolve, reject) => {
    if (!process.connected) { resolve(); return; }
    process.send!(message, (error) => {
      // Creator loss is not observer failure; owned cleanup must still run.
      if (error && process.connected) reject(error); else resolve();
    });
  });
  try { await runPanelObserver(target, () => send("ready"), () => send("started"), start); }
  catch (error) {
    // The owning routines already retained both registry and private diagnostics.
    if (process.connected) await send(`error:${error instanceof Error ? error.message : String(error)}`).catch(() => undefined);
    process.exitCode = 1;
  } finally {
    process.removeListener("message", requested);
    process.removeListener("disconnect", begin);
    if (process.connected) process.disconnect();
  }
}
