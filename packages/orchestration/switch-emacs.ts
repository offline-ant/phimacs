import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { availableHosts } from "./host.ts";
import { emacsOperation, emacsPoll, type EmacsExec } from "./hosts/emacs.ts";
import { assertSharedSwitch, type PreparedSwitch, type SwitchSource } from "./switch-destinations.ts";

const execute = promisify(execFile);
const READY_TIMEOUT_MS = 120_000;

/** `pi.exec`-style runner over execFile: nonzero exits resolve, missing programs reject. */
export const execEmacs: EmacsExec = async (command, args, options) => {
  try {
    const { stdout, stderr } = await execute(command, args, { ...options, maxBuffer: 1024 * 1024 });
    return { code: 0, stdout, stderr, killed: false };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: string; stderr?: string; killed?: boolean };
    const killed = failure.killed === true;
    if (typeof failure.code !== "number" && !killed) throw error;
    return { code: typeof failure.code === "number" ? failure.code : 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", killed };
  }
};

/**
 * A daemon started here outlives this Pi; it must not inherit this process's
 * frontend or worker identity. Sessions get theirs from the companion.
 */
export function emacsLauncherEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...environment };
  for (const key of ["PI_REMOTE", "PI_NESTED", "PI_ORCHESTRATION_HOST", "PI_ORCHESTRATION_ENDPOINT", "PI_ORCHESTRATION_TARGET",
    "PI_ORCHESTRATION_CONTROL", "PI_ORCHESTRATION_PLACEMENT", "PI_ORCHESTRATION_PARENT", "PHIMACS_PARENT_TASK", "PHIMACS_PARENT_TASK_FILE", "PHIMACS_MANAGED_CLAIM", "PIMUX_DISCOVERY", "HERDR_ENV", "HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID", "TMUX", "TMUX_PANE"]) {
    delete env[key];
  }
  return env;
}

/**
 * The destination daemon's socket. An explicitly selected Emacs host endpoint
 * must already run; otherwise the explicitly configured absolute checkout
 * launcher resolves its socket and starts only its isolated daemon.
 */
export async function emacsDaemon(environment: NodeJS.ProcessEnv, exec: EmacsExec = execEmacs): Promise<string> {
  const explicit = availableHosts(environment).find((host) => host.kind === "emacs")?.endpoint;
  if (explicit) {
    const result = await exec("emacsclient", ["--socket-name", explicit, "--eval", "t"], { timeout: 10_000 }).catch(() => undefined);
    if (result?.code !== 0 || result.killed) throw new Error(`Cannot reach the Emacs server ${explicit}; /switch starts only the daemon of PHIMACS_EMACS_LAUNCHER.`);
    return explicit;
  }
  const launcher = environment.PHIMACS_EMACS_LAUNCHER;
  if (!launcher || !path.isAbsolute(launcher)) throw new Error("Set PHIMACS_EMACS_LAUNCHER to the checkout's absolute launcher, or select an already-running Emacs endpoint.");
  try { fs.accessSync(launcher, fs.constants.X_OK); }
  catch { throw new Error("The checkout's Emacs launcher is not executable."); }
  let result: Awaited<ReturnType<EmacsExec>>;
  try {
    result = await exec(launcher, ["--no-frame", "--json"], { timeout: 120_000, env: emacsLauncherEnvironment(environment) });
  } catch { throw new Error("The checkout's Emacs launcher failed; no other launcher was tried."); }
  // Startup output (such as terminal cursor sequences) may precede the value.
  const printed = result.stdout.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trim().split("\n").at(-1) ?? "";
  let socket: unknown;
  try { socket = (JSON.parse(printed) as { socket?: unknown }).socket; } catch { socket = undefined; }
  if (result.code !== 0 || result.killed || typeof socket !== "string" || !path.isAbsolute(socket)) {
    throw new Error(`The checkout's Emacs launcher did not confirm its Emacs daemon: ${(result.stderr || result.stdout).trim().split("\n").at(-1) ?? ""}`);
  }
  return socket;
}

export async function prepareEmacsSwitch(source: SwitchSource, endpoint: string, exec: EmacsExec = execEmacs): Promise<PreparedSwitch> {
  assertSharedSwitch(source);
  const muxId = source.runtime.muxId;
  const call = (data: Record<string, unknown>) => emacsOperation(exec, endpoint, data);
  return {
    async start() {
      const id = randomUUID();
      // An ordinary root session: the companion's session environment hook
      // supplies this daemon's host, endpoint and target identity.
      const { PI_ORCHESTRATION_TARGET: _target, ...env } = source.env;
      let opened: Record<string, unknown> | undefined;
      try {
        opened = await call({ operation: "switch", id, sessionFile: source.sessionFile, cwd: source.cwd, args: [], env, muxId });
        if (opened.muxId !== muxId) throw new Error("Emacs did not acknowledge the requested shared runtime");
        const deadline = Date.now() + READY_TIMEOUT_MS;
        while (true) {
          const state = await emacsPoll(() => call({ operation: "switch-state", id }));
          if (state?.ready === true) {
            if (state.muxId !== muxId) throw new Error("Emacs did not confirm the same shared runtime; no session-file fallback is permitted");
            break;
          }
          if (typeof state?.failure === "string") throw new Error(state.failure);
          if (state?.state === "missing") throw new Error("The Emacs session buffer was closed during startup");
          if (state && state.state !== "running" && opened.refreshed !== true) throw new Error("Pi exited during startup");
          if (Date.now() >= deadline) throw new Error("Emacs session readiness timed out");
          await delay(50);
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : "no confirmation";
        // Cleanup may detach only this operation's new view, never an existing
        // view or the shared agent. An uncertain cleanup remains an error.
        let cleanupFailure = "";
        if (opened && opened.refreshed !== true) {
          try { await call({ operation: "switch-state", id, close: true, detachOnly: true, muxId }); }
          catch (cleanup) { cleanupFailure = ` New-view cleanup is uncertain: ${cleanup instanceof Error ? cleanup.message : String(cleanup)}.`; }
        }
        throw new Error(`Emacs switch failed (${reason}). No source view was closed.${cleanupFailure}`);
      }
      const buffer = typeof opened.buffer === "string" ? opened.buffer : "?";
      return `Emacs ${endpoint}, attached buffer ${buffer} (runtime ${muxId})`;
    },
  };
}
