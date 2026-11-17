import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { acquireClaim, reconcileClaim, releaseClaim } from "@phimacs/pimux/ownership";
import { readProcessIdentity } from "@phimacs/pimux/process-identity";
import { fileURLToPath } from "node:url";
import { SessionManager, type ExtensionContext, type SessionEntry, type SessionHeader } from "@earendil-works/pi-coding-agent";
import { cleanContextCliArgs, EPHEMERAL_WORKER_CONTEXTS, type EphemeralWorkerTool } from "./delegate-policy.ts";
import { workerTitle } from "./worker-title.ts";

export function modelCliArgs(model: { provider: string; id: string } | undefined, thinkingLevel: string): string[] {
  if (!model) throw new Error("Current session has no selected model; cannot start a child Pi process.");
  // Pi treats this prefix as provider syntax even with --provider. A bare id
  // such as example/review could otherwise silently start example's review model.
  if (model.id.toLowerCase().startsWith(`${model.provider.toLowerCase()}/`)) {
    throw new Error(`Cannot start child model ${model.provider}/${model.id}: Pi's CLI interprets the model id's provider prefix ambiguously.`);
  }
  return ["--provider", model.provider, "--model", model.id, "--thinking", thinkingLevel];
}

/** Initialize one new file under a stopped-file lease; never rewrite a session. */
export function flushSessionFile(sessionManager: SessionManager, sessionFile: string): void {
  if (sessionManager.getSessionFile()) throw new Error("Session initialization requires an in-memory manager; persistent writers may outlive the preparation lease");
  const header = sessionManager.getHeader();
  if (!header) throw new Error("New session has no header");
  const entries: Array<SessionHeader | SessionEntry> = [header, ...sessionManager.getEntries()];
  const identity = readProcessIdentity(process.pid);
  if (!identity) throw new Error("Cannot establish session preparation process identity");
  const lease = acquireClaim(sessionFile, { id: randomUUID(), kind: "lease", wrapper: identity, pi: null });
  try {
    fs.mkdirSync(path.dirname(lease.file), { recursive: true, mode: 0o700 });
    // The claimed canonical name, not a potentially retargeted caller alias.
    fs.writeFileSync(lease.file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { mode: 0o600, flag: "wx" });
    reconcileClaim(lease);
  } finally {
    // writeFileSync has closed its descriptor on success or failure. No mutable
    // SessionManager points at this file, so no preparation writer survives.
    releaseClaim(lease);
  }
}

/** Allocate using Pi's header/path rules, but perform all history edits in memory. */
export function createPreparedSession(cwd: string, parentSession?: string, entries: readonly SessionEntry[] = []): { session: SessionManager; sessionFile: string } {
  const allocated = SessionManager.create(cwd, process.env.PHIMACS_TEST_ROOT
    ? path.join(process.env.PHIMACS_TEST_ROOT, "sessions") : undefined, parentSession ? { parentSession } : undefined);
  const sessionFile = allocated.getSessionFile();
  const header = allocated.getHeader();
  if (!sessionFile || !header) throw new Error("Could not allocate a persistent session path/header");
  return { session: SessionManager.inMemory(cwd, undefined, [structuredClone(header), ...structuredClone(entries)]), sessionFile };
}

export function getPreToolCallLeafId(
  sessionManager: Pick<SessionManager, "getBranch">,
  toolName: string,
  toolCallId: string,
): string | null {
  const branch = sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    if (entry.message.content.some((item) => item.type === "toolCall" && item.id === toolCallId && item.name === toolName)) {
      return entry.parentId ?? null;
    }
  }
  throw new Error(`Could not identify ${toolName} tool call ${toolCallId} in the current session branch; refusing to fork an unmatched transcript.`);
}

/**
 * The latest entry a running session has finished. Entries are written whole, but the branch can
 * still end on calls without results, an unanswered prompt or a failed reply awaiting retry.
 */
export function getLastSettledEntryId(branch: SessionEntry[]): string | null {
  const results = new Set<string>();
  let lastResult: string | undefined;
  for (const entry of branch.toReversed()) {
    if (entry.type === "compaction" || entry.type === "branch_summary") return entry.id;
    if (entry.type !== "message") continue;
    const { message } = entry;
    if (message.role === "toolResult") {
      results.add(message.toolCallId);
      lastResult ??= entry.id;
    } else if (message.role === "assistant") {
      const failed = message.stopReason === "error" || message.stopReason === "aborted";
      if (!failed && message.content.every((item) => item.type !== "toolCall" || results.has(item.id))) return lastResult ?? entry.id;
      results.clear();
      lastResult = undefined;
    }
  }
  return null;
}

export function resolveCwd(base: string, folder?: string): string {
  const cwd = path.resolve(base, folder ?? ".");
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`folder does not exist or is not a directory: ${cwd}`);
  }
  return cwd;
}

export function prepareFreshSession(cwd: string, purpose: string, data: unknown, title: string): { sessionFile: string; sessionId: string } {
  const { session, sessionFile } = createPreparedSession(cwd);
  session.appendCustomEntry(`pi-orchestration:${purpose}`, data);
  session.appendSessionInfo(title);
  flushSessionFile(session, sessionFile);
  return { sessionFile, sessionId: session.getSessionId() };
}

export function prepareDelegateSession(
  /** With `remote`, folder was resolved on that host; the local cwd stays the caller's. */
  request: { tool: EphemeralWorkerTool; folder?: string; task: string; remote?: string },
  ctx: ExtensionContext,
  call: { toolName: string; toolCallId: string },
  runtime: { model: { provider: string; id: string }; thinkingLevel: string },
): { cwd: string; sessionFile: string; sessionId: string; args: string[] } {
  if (EPHEMERAL_WORKER_CONTEXTS[request.tool] === "inherit" && request.folder !== undefined) {
    throw new Error(`${request.tool} does not accept folder; use delegate for a standalone assignment in another directory.`);
  }
  const cwd = request.remote === undefined ? resolveCwd(ctx.cwd, request.folder) : ctx.cwd;
  const remote = request.remote === undefined ? {} : { remote: request.remote };
  const args = modelCliArgs(runtime.model, runtime.thinkingLevel);
  const context = EPHEMERAL_WORKER_CONTEXTS[request.tool];
  const title = workerTitle(request.task);
  if (context !== "inherit") {
    const { sessionFile, sessionId } = prepareFreshSession(cwd, "delegate", { tool: request.tool, context, ...remote, createdAt: new Date().toISOString() }, title);
    return { cwd, sessionFile, sessionId, args: [...args, ...cleanContextCliArgs(context, fileURLToPath(import.meta.resolve("@phimacs/orchestration/worker-frame")))] };
  }
  const parentSession = ctx.sessionManager.getSessionFile();
  if (!parentSession || !fs.existsSync(parentSession)) throw new Error(`Current session is not persisted; cannot start ${request.tool}.`);
  const leafId = getPreToolCallLeafId(ctx.sessionManager, call.toolName, call.toolCallId);
  const { session: forked, sessionFile } = createPreparedSession(cwd, parentSession, ctx.sessionManager.getEntries());
  if (leafId === null) forked.resetLeaf();
  else forked.branch(leafId);
  forked.appendCustomEntry("pi-orchestration:delegate-runtime", { task: request.task, parentSession, childSession: sessionFile, cwd, ...remote });
  // Titles are file-wide metadata: replace inherited titles before the claimed write.
  forked.appendSessionInfo(title);
  flushSessionFile(forked, sessionFile);
  return { cwd, sessionFile, sessionId: forked.getSessionId(), args };
}
