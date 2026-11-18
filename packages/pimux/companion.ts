/**
 * Pi extension loaded only by the pimux wrapper (`--extension`), never by the
 * package manifest. It reports what Pi's RPC stream does not: session
 * replacement, model selection, tree navigation, the end of open dialogs and
 * consistent snapshots. Its only channel out is `ctx.ui.setStatus` with a
 * reserved key the wrapper consumes. It also blocks session replacement in
 * orchestration workers and keeps Pi from orphaning tool processes when the
 * wrapper dies.
 */
import * as fs from "node:fs";
import { installManagedSessionGuard } from "./guard.ts";
import { installModelControl } from "./model-control.ts";
import { processIdentityStatus, readProcessIdentity, type ProcessIdentity } from "./process-identity.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  ALL_INCLUDES, COMPANION_STATUS_KEY, type CompanionRecord, type Include, parsePlacement, SNAPSHOT_COMMAND, type SnapshotData,
} from "./protocol.ts";

const ORPHAN_GUARD = Symbol.for("pimux:orphan-guard");

/** Parent PID and process group from /proc (Linux); undefined elsewhere. */
function procStat(pid: number | "self"): { ppid: number; pgrp: number } | undefined {
  try {
    const text = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    return { ppid: Number(fields[1]), pgrp: Number(fields[2]) };
  } catch {
    return undefined;
  }
}

/**
 * When the wrapper is killed (frontends such as Pilish close with SIGKILL), Pi's
 * next stdout write fails with EPIPE and Pi exits without its shutdown, leaving
 * detached tool process groups running. Once orphaned, the exit kills child
 * process groups Pi leads, as Pi's own SIGTERM handling would, and removes the
 * wrapper's discovery entry, which the wrapper could not.
 */
function installOrphanGuard(): void {
  const globals = globalThis as typeof globalThis & { [ORPHAN_GUARD]?: true };
  if (globals[ORPHAN_GUARD]) return;
  globals[ORPHAN_GUARD] = true;
  const wrapper = procStat("self")?.ppid;
  if (wrapper === undefined) return;
  // A broken pipe means the wrapper is gone; Pi's own write path then exits.
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});
  const discovery = process.env.PIMUX_DISCOVERY;
  const wrapperIdentity = process.env.PIMUX_WRAPPER_IDENTITY
    ? JSON.parse(process.env.PIMUX_WRAPPER_IDENTITY) as ProcessIdentity : readProcessIdentity(wrapper);
  // An idle orphan may never write again. Check the exact parent identity as
  // well as pipe failures so zero-client durability cannot strand a writer.
  const monitor = setInterval(() => {
    if (wrapperIdentity && processIdentityStatus(wrapperIdentity) === "dead") process.kill(process.pid, "SIGTERM");
  }, 250);
  monitor.unref();
  process.on("exit", () => {
    clearInterval(monitor);
    const self = procStat("self");
    if (!self || self.ppid === wrapper) return;
    if (discovery?.endsWith(".json")) removeDiscovery(discovery, wrapper);
    let names: string[];
    try { names = fs.readdirSync("/proc"); } catch { return; }
    for (const name of names) {
      const pid = Number(name);
      if (!Number.isInteger(pid) || pid === process.pid) continue;
      const stat = procStat(pid);
      if (stat?.ppid !== process.pid || stat.pgrp !== pid || stat.pgrp === self.pgrp) continue;
      try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
    }
  });
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Removes the entry only if it still names the dead wrapper. */
function removeDiscovery(file: string, wrapper: number): void {
  try {
    if ((JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: unknown }).pid !== wrapper) return;
    fs.rmSync(`${file.slice(0, -5)}.sock`, { force: true });
    fs.rmSync(file, { force: true });
  } catch { /* already gone */ }
}

export default function pimuxCompanion(pi: ExtensionAPI): void {
  installOrphanGuard();
  installManagedSessionGuard(pi);
  const placement = parsePlacement(process.env.PI_ORCHESTRATION_PLACEMENT);
  // Pi binds a replacement runtime twice; announce each runtime's session once.
  let announced = false;
  let promptsEnded: ReturnType<typeof setImmediate> | undefined;

  const send = (ctx: ExtensionContext, record: CompanionRecord): void => {
    ctx.ui.setStatus(COMPANION_STATUS_KEY, JSON.stringify(record));
  };

  installModelControl(pi, send);

  /**
   * Must stay synchronous: its position in Pi's stdout is the snapshot boundary.
   * Entries stay flat: `getTree()` nests one level per entry, which a long session
   * cannot serialize.
   */
  const snapshot = (ctx: ExtensionContext, include: readonly Include[]): SnapshotData => {
    const manager = ctx.sessionManager;
    return {
      session: { file: manager.getSessionFile() ?? null, id: manager.getSessionId(), name: manager.getSessionName() ?? null, cwd: manager.getCwd() },
      model: ctx.model ?? null,
      thinkingLevel: pi.getThinkingLevel(),
      idle: ctx.isIdle(),
      leafId: manager.getLeafId(),
      ...include.includes("entries") ? { entries: manager.getEntries() } : {},
      ...include.includes("messages") ? { messages: manager.buildSessionProjection().messages } : {},
    };
  };

  /** A snapshot that cannot be taken or sent falls back to identity alone, so frontends still learn of the change. */
  const sendChange = (ctx: ExtensionContext, change: (data: SnapshotData) => CompanionRecord): void => {
    try {
      send(ctx, change(snapshot(ctx, ALL_INCLUDES)));
    } catch (error) {
      send(ctx, change({ ...snapshot(ctx, []), historyError: errorText(error) }));
    }
  };

  pi.on("session_start", (event, ctx) => {
    if (announced) return;
    announced = true;
    if (event.reason === "startup" || event.reason === "reload") {
      const manager = ctx.sessionManager;
      send(ctx, { kind: "identity", reason: event.reason, model: ctx.model ?? null, thinkingLevel: pi.getThinkingLevel(),
        session: { file: manager.getSessionFile() ?? null, id: manager.getSessionId(), name: manager.getSessionName() ?? null, cwd: manager.getCwd() } });
    } else {
      const { reason } = event;
      const previousSessionFile = event.previousSessionFile ?? null;
      sendChange(ctx, (data) => ({ kind: "session", reason, previousSessionFile, data }));
    }
  });

  pi.on("session_tree", (event, ctx) => {
    sendChange(ctx, (data) => ({ kind: "tree", newLeafId: event.newLeafId, oldLeafId: event.oldLeafId, data }));
  });

  pi.on("model_select", (event, ctx) => {
    send(ctx, { kind: "model", model: event.model, previousModel: event.previousModel ?? null, source: event.source });
  });

  // Pi reports only the aggregate: the outermost dialog's start and the end of the last one.
  // A dialog opened right after another closed starts before the end is delivered, so the
  // end is confirmed one macrotask later, after any such start.
  pi.on("ui_prompt_start", () => {
    if (promptsEnded) clearImmediate(promptsEnded);
    promptsEnded = undefined;
  });
  pi.on("ui_prompt_end", (_event, ctx) => {
    if (promptsEnded) clearImmediate(promptsEnded);
    promptsEnded = setImmediate(() => {
      promptsEnded = undefined;
      try { send(ctx, { kind: "prompts-ended" }); } catch { /* runtime replaced meanwhile */ }
    });
  });

  if (placement === "worker") {
    // A worker's parent follows its session file for previews, results and resume.
    const refuse = (ctx: ExtensionContext): { cancel: true } => {
      ctx.ui.notify("Orchestration workers keep their session: new session, resume and fork are disabled here.", "warning");
      return { cancel: true };
    };
    pi.on("session_before_switch", (_event, ctx) => refuse(ctx));
    pi.on("session_before_fork", (_event, ctx) => refuse(ctx));
  }

  pi.registerCommand(SNAPSHOT_COMMAND, {
    description: "Internal pimux command",
    handler: async (args, ctx) => {
      const [requested, include] = args.trim().split(/\s+/);
      const generation = Number(requested);
      const includes = (include ?? "").split(",").filter((item): item is Include => item === "entries" || item === "messages");
      try {
        send(ctx, { kind: "snapshot", generation, data: snapshot(ctx, includes) });
      } catch (error) {
        send(ctx, { kind: "snapshot-failed", generation, error: errorText(error) });
      }
    },
  });
}
