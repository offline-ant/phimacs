/** Cooperative transition guard. Native Pi storage operations outside these hooks remain unguarded. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { acquireClaim, canonicalSessionPath, lookupClaim, reconcileClaim, type ClaimHandle } from "./ownership.ts";
import { processIdentityStatus, readProcessIdentity, sameProcessIdentity } from "./process-identity.ts";

export const MANAGED_CLAIM_ENV = "PHIMACS_MANAGED_CLAIM";
export const GUARD_STATUS_KEY = "pimux:guard";
const KEY = Symbol.for("phimacs:managed-session-guard");
interface GuardState { initial: ClaimHandle; handles: Map<string, ClaimHandle>; failure?: string }

function state(): GuardState | undefined {
  const globals = globalThis as typeof globalThis & { [KEY]?: GuardState };
  if (globals[KEY]) return globals[KEY];
  const serialized = process.env[MANAGED_CLAIM_ENV];
  if (!serialized) return undefined;
  const initial = JSON.parse(serialized) as ClaimHandle;
  const current = lookupClaim(initial.file);
  const self = readProcessIdentity(process.pid);
  if (!current || current.token !== initial.token || current.owner.id !== initial.owner.id || !self
    || !current.owner.pi || !sameProcessIdentity(current.owner.pi, self)) throw new Error("Managed session claim was not transferred to this Pi");
  initial.owner = current.owner;
  globals[KEY] = { initial, handles: new Map([[initial.file, initial]]) };
  if (initial.owner.kind === "tui") {
    const wrapper = initial.owner.wrapper;
    const monitor = setInterval(() => { if (processIdentityStatus(wrapper) === "dead") process.kill(process.pid, "SIGTERM"); }, 250);
    monitor.unref();
    process.once("exit", () => clearInterval(monitor));
  }
  return globals[KEY];
}

/**
 * Reserve a destination before an extension initializes its file. Only this
 * managed Pi may reserve; the capability is registered with the transition guard
 * and retained until actual writer exit, including cancellation/failure. This is
 * not a release/handoff API and cannot authorize another Pi to open the file.
 */
export function reserveManagedSession(file: string): ClaimHandle {
  const held = state();
  if (!held || held.failure) throw new Error(held?.failure ?? "Start Pi through `phimacs pi` before creating a session file.");
  const canonical = canonicalSessionPath(file);
  const known = held.handles.get(canonical);
  if (known) { reconcileClaim(known); return known; }
  const next = acquireClaim(canonical, held.initial.owner);
  held.handles.set(next.file, next);
  return next;
}

/**
 * Reserve FILE as reserveManagedSession does when this Pi was given a managed claim.
 * Only a genuinely unmanaged Pi, which never received a claim, gets undefined and
 * keeps stock Pi semantics. A malformed, lost, conflicting or failed claim still throws.
 */
export function reserveSessionIfManaged(file: string): ClaimHandle | undefined {
  const globals = globalThis as typeof globalThis & { [KEY]?: GuardState };
  if (!globals[KEY] && process.env[MANAGED_CLAIM_ENV] === undefined) return undefined;
  return reserveManagedSession(file);
}

/** Loaded once per runtime; process-wide capabilities survive Pi's extension rebinds. */
export function installManagedSessionGuard(pi: ExtensionAPI): void {
  if (!process.env[MANAGED_CLAIM_ENV]) return;
  let held: GuardState | undefined;
  let initializationError: string | undefined;
  try { held = state(); } catch (error) { initializationError = String(error); }
  const report = (ctx: ExtensionContext, handle?: ClaimHandle): void => {
    const error = held?.failure ?? initializationError;
    ctx.ui.setStatus(GUARD_STATUS_KEY, JSON.stringify(error ? { ready: false, error } : { ready: true, handle }));
  };
  const fatal = (ctx: ExtensionContext, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    if (held) held.failure = message;
    else initializationError = message;
    report(ctx);
    ctx.ui.notify(`Managed session ownership failed: ${message}`, "error");
    // Notification-only hooks cannot veto initialization. Terminate this owned Pi,
    // not a foreign PID; the launcher refuses readiness and verifies actual exit.
    process.kill(process.pid, "SIGTERM");
  };
  pi.on("session_before_switch", (event, ctx) => {
    try {
      if (initializationError || held?.failure) throw new Error(initializationError ?? held?.failure);
      if (event.targetSessionFile) report(ctx, reserveManagedSession(event.targetSessionFile));
    } catch (error) {
      ctx.ui.notify(`Session remains owned elsewhere: ${error instanceof Error ? error.message : String(error)}`, "warning");
      return { cancel: true };
    }
    return undefined;
  });
  pi.on("session_start", (_event, ctx) => {
    try {
      const file = ctx.sessionManager.getSessionFile();
      if (!file) throw new Error("Managed sessions require persistent exact file paths");
      report(ctx, reserveManagedSession(file));
    } catch (error) { fatal(ctx, error); }
  });
  // Old and provisional claims intentionally stay until writer exit: Pi has
  // no authoritative failure/flush settlement for every extension transition.
}

export default installManagedSessionGuard;
