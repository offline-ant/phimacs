import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentEndEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ERROR_CLAIM_EVENT, ERROR_CONTINUE_EVENT, type ErrorClaim, type ErrorContinue } from "./error-events.ts";
import { initializeNesting } from "./nesting.ts";
import { SELF_COMPACT_HANDOFF_EVENT, type SelfCompactHandoff } from "./self-compact-handoff.ts";
import { readProcessIdentity, type ProcessIdentity } from "@phimacs/pimux/process-identity";
import { createPrivateJson, writePrivateJson } from "@phimacs/pimux/private-files";
import { endParentTask, isProcessIdentity, parentTaskEnded, readParentTaskBinding, watchParentTask, type ParentTaskBinding } from "./parent-task.ts";

const WORKER_ROOT_PREFIX = "pi-orchestration-worker-";
const RETURN_WORKER_COMMAND = "worker-return";
const CANCEL_WORKER_COMMAND = "worker-cancel";
const SUBWORKER_TOOLS = new Set(["do", "microdo", "delegate", "fresh_look"]);
// Public provider hook; see README "Completion and waiting".
const RECOVERY_POLICY_EVENT = "pi-provider:recovery-policy";
const RECOVERY_STATUS_EVENT = "pi-provider:recovery-status";
const FIRST_ACTION_SUBWORKER_WARNING =
  "This is an automated warning heuristic. You are in a worker frame. Do not simply forward the entire task; investigate it and/or split it into a distinct subtask. Continue working, and retry the worker call if this warning was triggered in error.";

const MAIN_RESULT_PROMPT_PREFIX =
  "Complete the worker task and return only the parent-facing result or blocker.";

const BRIEF_RESULT_PROMPT_PREFIX = [
  "Complete this bounded task autonomously to the best of your ability using the inherited conversation and available tools.",
  "Stay within scope; report a blocker rather than guessing missing requirements. Do not forward the whole assignment to another worker.",
  "Return only the parent-facing report, at most three sentences covering the outcome, verification, and any blocker.",
].join("\n");

const RETROSPECTIVE_PROMPT = [
  "The main result has already been saved for the parent. Do not repeat it, do not continue the task, and do not call tools.",
  "Return only substantial observations you noticed outside the task, or important details not included in the main result, that are worth preserving.",
  "If there is nothing substantial, return exactly: everything was ok",
].join("\n");

export interface WorkerRequestFile {
  id: string;
  task: string;
  tools: string[];
  model: { provider: string; id: string };
  thinkingLevel: NonNullable<ExtensionContext["thinkingLevel"]>;
  /** Brief requests finish on the main result; ordinary requests add a retrospective. */
  resultPolicy: "brief" | "retrospective";
  resultPath: string;
  statusPath?: string;
}

/** Something a human did to this worker, and how many model messages it had sent by then. */
export interface WorkerGuidance {
  position: number;
  text: string;
}

export interface WorkerResultFile {
  id: string;
  result: string;
  retrospective?: string;
  guidance?: WorkerGuidance[];
  /** Model messages this worker request sent in total; the scale of guidance positions. */
  modelMessages?: number;
  isError?: boolean;
  sessionFile?: string;
  timestamp: string;
  contextPercent?: number | null;
}

export interface WorkerStatusFile {
  id?: string;
  state: "running" | "waiting" | "retrospective" | "error" | "closed";
  /** The worker process's complete start identity; liveness depends on it alone. */
  process: ProcessIdentity;
  resultPath?: string;
  sessionFile?: string;
  contextPercent?: number | null;
  /** Why a stopped worker is waiting for a human. */
  waitingReason?: string;
  /** Provider-owned recovery deadline, in absolute epoch milliseconds. */
  retryAt?: number;
  updatedAt: string;
}

export interface WorkerArtifactPaths {
  artifactDir: string;
  requestPath: string;
  resultPath: string;
  statusPath: string;
  promptPath: string;
  resultMarkdownPath: string;
  retrospectiveMarkdownPath: string;
}

type WorkerPhase = "result" | "retrospective";

interface ActiveWorkerRequest {
  request: WorkerRequestFile;
  context: ExtensionContext;
  pendingCompaction?: string;
  hasTakenToolAction: boolean;
  phase: WorkerPhase;
  mainResult?: string;
  /** Latest assistant text of this worker run, never the inherited conversation. */
  latestReply?: string;
  modelMessages: number;
  guidance: WorkerGuidance[];
  pendingFailure?: string;
  /** Set while a stopped worker waits for a human; any new agent run clears it. */
  waitingReason?: string;
  retryAt?: number;
  /** /worker-return owns completion; abort and settlement events must not act. */
  returning: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isWorkerRequestFile(value: unknown): value is WorkerRequestFile {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.task === "string"
    && Array.isArray(value.tools)
    && value.tools.every((tool) => typeof tool === "string")
    && isRecord(value.model)
    && typeof value.model.provider === "string"
    && typeof value.model.id === "string"
    && typeof value.thinkingLevel === "string"
    && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value.thinkingLevel)
    && (value.resultPolicy === "brief" || value.resultPolicy === "retrospective")
    && typeof value.resultPath === "string"
    && (value.statusPath === undefined || typeof value.statusPath === "string");
}

function isWorkerGuidance(value: unknown): value is WorkerGuidance {
  return isRecord(value) && typeof value.position === "number" && typeof value.text === "string";
}

function isWorkerResultFile(value: unknown): value is WorkerResultFile {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.result === "string"
    && typeof value.timestamp === "string"
    && (value.retrospective === undefined || typeof value.retrospective === "string")
    && (value.guidance === undefined || (Array.isArray(value.guidance) && value.guidance.every(isWorkerGuidance)))
    && (value.modelMessages === undefined || typeof value.modelMessages === "number")
    && (value.isError === undefined || typeof value.isError === "boolean")
    && (value.sessionFile === undefined || typeof value.sessionFile === "string")
    && (value.contextPercent === undefined || typeof value.contextPercent === "number" || value.contextPercent === null);
}

function latestAssistantMessage(messages: AgentEndEvent["messages"]): Extract<AgentEndEvent["messages"][number], { role: "assistant" }> | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

function assistantTextContent(message: Extract<AgentEndEvent["messages"][number], { role: "assistant" }>): string | undefined {
  const text = message.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("")
    .trim();
  return text || undefined;
}

function assistantMessageText(message: Extract<AgentEndEvent["messages"][number], { role: "assistant" }>): string {
  return message.errorMessage?.trim() || assistantTextContent(message) || `Assistant stopped with reason '${message.stopReason}' before returning a final worker result.`;
}

function getContextPercent(ctx: ExtensionContext): number | null | undefined {
  return ctx.getContextUsage()?.percent;
}

function writeTextArtifact(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, content, { encoding: "utf8", mode: 0o600 });
}

function atomicWriteJsonNoOverwrite(filePath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    createPrivateJson(filePath, payload);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Worker result already exists: ${filePath}`);
    throw error;
  }
}

function atomicWriteJson(filePath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  writePrivateJson(filePath, payload);
}

function parseCommandText(args: string | undefined): string {
  const trimmed = (args ?? "").trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function makeWorkerId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createWorkerArtifacts(): WorkerArtifactPaths {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), WORKER_ROOT_PREFIX));
  fs.chmodSync(artifactDir, 0o700);
  return {
    artifactDir,
    requestPath: path.join(artifactDir, "request.json"),
    resultPath: path.join(artifactDir, "result.json"),
    statusPath: path.join(artifactDir, "status.json"),
    promptPath: path.join(artifactDir, "prompt.md"),
    resultMarkdownPath: path.join(artifactDir, "result.md"),
    retrospectiveMarkdownPath: path.join(artifactDir, "retrospective.md"),
  };
}

export function formatWorkerMoreInfo(paths: WorkerArtifactPaths): string {
  const usefulFiles = ["prompt.md", "result.md", "retrospective.md", "request.json", "result.json", "status.json"];
  return [`More info in ${paths.artifactDir}`, `Useful files: ${usefulFiles.join(", ")}`].join("\n");
}

export function appendWorkerMoreInfo(message: string, paths: WorkerArtifactPaths): string {
  const trimmed = message.trimEnd();
  if (!trimmed) return formatWorkerMoreInfo(paths);
  if (trimmed.includes(paths.artifactDir)) return trimmed;
  return `${trimmed}\n\n${formatWorkerMoreInfo(paths)}`;
}

/** Leads with what a human did, so the parent can judge whether the result finishes the task. */
export function formatWorkerResult(result: WorkerResultFile): string {
  const guidance = result.guidance?.length ? [
    `> User guidance: what a human did in this worker. [n] counts the model messages it had sent by then, of ${result.modelMessages ?? "unknown"}. If the result below does not finish the task, continue the worker with do resume.`,
    ...result.guidance.map(({ position, text }) => `[${position}] ${text.trim().replaceAll("\n", "\n    ")}`),
    "",
    "",
  ].join("\n") : "";
  if (result.retrospective === undefined) return `${guidance}${result.result}`;
  return `${guidance}${result.result.trimEnd()}\n\n---\n\nRetrospective:\n${result.retrospective}`;
}

/** The worker's first prompt. It never starts with "/", so no frontend treats it as a context change. */
export function workerPrompt(request: WorkerRequestFile): string {
  const prefix = request.resultPolicy === "brief" ? BRIEF_RESULT_PROMPT_PREFIX : MAIN_RESULT_PROMPT_PREFIX;
  return `${prefix}\n\n${request.task}`;
}

/** The request sits beside the parent task lease; prompt.md holds the exact first prompt the parent sends. */
export function writeWorkerRequest(paths: WorkerArtifactPaths, request: WorkerRequestFile): void {
  atomicWriteJson(paths.requestPath, request);
  fs.writeFileSync(paths.promptPath, workerPrompt(request), { encoding: "utf8", mode: 0o600 });
}

export function formatWorkerRetryTime(retryAt: number): string {
  return new Date(retryAt).toLocaleString(undefined, {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false, timeZoneName: "longOffset",
  });
}

export function readWorkerStatus(statusPath: string): WorkerStatusFile | undefined {
  if (!fs.existsSync(statusPath)) return undefined;
  const parsed = JSON.parse(fs.readFileSync(statusPath, "utf8")) as unknown;
  if (!isRecord(parsed) || typeof parsed.state !== "string" || typeof parsed.updatedAt !== "string") return undefined;
  if (!isProcessIdentity(parsed.process)) {
    throw new Error(`Invalid worker process identity at ${statusPath}`);
  }
  return parsed as unknown as WorkerStatusFile;
}

export function writeWorkerStatus(statusPath: string | undefined, status: Omit<WorkerStatusFile, "updatedAt" | "process">): void {
  if (!statusPath) return;
  const identity = readProcessIdentity(process.pid);
  if (!identity) throw new Error("Cannot establish worker process-start identity");
  atomicWriteJson(statusPath, { ...status, process: identity, updatedAt: new Date().toISOString() });
}

export function parseWorkerResult(raw: string, resultPath: string, expectedId: string): WorkerResultFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid worker result JSON at ${resultPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isWorkerResultFile(parsed)) {
    throw new Error(`Invalid worker result shape at ${resultPath}`);
  }
  if (parsed.id !== expectedId) {
    throw new Error(`Worker result id mismatch at ${resultPath}: expected ${expectedId}, got ${parsed.id}`);
  }
  return parsed;
}

function writeFinalResult(
  ctx: ExtensionContext,
  active: ActiveWorkerRequest,
  result: string,
  isError = false,
  retrospective?: string,
): void {
  const contextPercent = getContextPercent(ctx);
  writeTextArtifact(path.join(path.dirname(active.request.resultPath), "result.md"), result);
  if (retrospective !== undefined) {
    writeTextArtifact(path.join(path.dirname(active.request.resultPath), "retrospective.md"), retrospective);
  }

  const payload: WorkerResultFile = {
    id: active.request.id,
    result,
    retrospective,
    ...active.guidance.length > 0 && { guidance: active.guidance, modelMessages: active.modelMessages },
    isError,
    sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
    timestamp: new Date().toISOString(),
    contextPercent: contextPercent ?? null,
  };
  atomicWriteJsonNoOverwrite(active.request.resultPath, payload);
  writeWorkerStatus(active.request.statusPath, {
    id: active.request.id,
    state: "closed",
    resultPath: active.request.resultPath,
    sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
    contextPercent: contextPercent ?? null,
  });
}

export default function workerFrameExtension(pi: ExtensionAPI): void {
  let activeRequest: ActiveWorkerRequest | undefined;
  /** The leased request, loaded at startup, until its exact first prompt arrives. */
  let pendingRequest: WorkerRequestFile | undefined;
  let parentBinding: ParentTaskBinding | undefined;
  let stopParentWatch: (() => void) | undefined;
  let parentTerminated = false;
  let requestFinished = false;

  function stopWorker(ctx: ExtensionContext, reason: string): void {
    if (parentTerminated) return;
    parentTerminated = true;
    stopParentWatch?.();
    stopParentWatch = undefined;
    const request = activeRequest;
    activeRequest = undefined;
    try {
      if (request) {
        request.returning = true;
        writeWorkerStatus(request.request.statusPath, { id: request.request.id, state: "error", waitingReason: reason,
          resultPath: request.request.resultPath, sessionFile: ctx.sessionManager.getSessionFile() ?? undefined });
      }
      publishRecoveryPolicy();
      refreshWorkerUi(ctx);
    } finally {
      // shutdown() waits until the session is idle, but a worker whose parent ended must
      // stop its current run now. Pi's mode handles SIGTERM by aborting the run and
      // disposing the runtime; signal only this owned process, never a foreign PID.
      try { ctx.shutdown(); }
      finally { process.kill(process.pid, "SIGTERM"); }
    }
  }

  function failStartup(ctx: ExtensionContext, reason: string): void {
    ctx.ui.notify(reason, "error");
    // A rejected internal request must not leave a live worker whose parent
    // waits forever for status. Never terminate an ordinary root invoking it.
    if (parentBinding || process.env.PI_ORCHESTRATION_PLACEMENT === "worker") stopWorker(ctx, reason);
    else throw new Error(reason);
  }

  function checkParent(ctx: ExtensionContext): boolean {
    if (parentTerminated) return false;
    if (parentBinding) {
      const reason = parentTaskEnded(parentBinding);
      if (reason) { stopWorker(ctx, reason); return false; }
    }
    return true;
  }

  function monitorParent(ctx: ExtensionContext): void {
    stopParentWatch?.();
    stopParentWatch = undefined;
    try {
      parentBinding = readParentTaskBinding();
      if (parentBinding && !parentTerminated) stopParentWatch = watchParentTask(parentBinding, (reason) => stopWorker(ctx, reason));
    } catch (error) { stopWorker(ctx, `Invalid parent task ownership: ${String(error)}`); }
  }

  function publishRecoveryPolicy(): void {
    const request = activeRequest;
    // Capture decides where replies go, not how the provider handles quota.
    const allowed = request?.phase !== "retrospective";
    if (request && !allowed) request.retryAt = undefined;
    pi.events.emit(RECOVERY_POLICY_EVENT, { allowed });
  }

  function availableWorkerTools(requestedTools: string[]): string[] {
    const available = new Set(pi.getAllTools().map((tool) => tool.name));
    return [...new Set(requestedTools)].filter((tool) => available.has(tool));
  }

  function refreshWorkerUi(ctx: ExtensionContext): void {
    const request = activeRequest;
    if (!request) {
      ctx.ui.setStatus("worker-frame", undefined);
      ctx.ui.setWidget("worker-frame", undefined);
      return;
    }

    if (request.waitingReason !== undefined) {
      ctx.ui.setStatus("worker-frame", ctx.ui.theme.fg("warning", "worker:waiting"));
      ctx.ui.setWidget("worker-frame", [
        "Worker is waiting for you.",
        request.waitingReason,
        "Type a message to continue it; its final reply goes to the parent.",
        "Use /worker-return [text] to hand back now.",
      ]);
      return;
    }

    if (request.retryAt !== undefined) {
      ctx.ui.setStatus("worker-frame", ctx.ui.theme.fg("warning", "worker:quota-wait"));
      ctx.ui.setWidget("worker-frame", [
        `Waiting for provider quota; retry scheduled at ${formatWorkerRetryTime(request.retryAt)}.`,
        "Escape cancels recovery. No tools are replayed.",
      ]);
      return;
    }

    const label = request.phase === "result" ? "worker:running" : "worker:retrospective";
    ctx.ui.setStatus("worker-frame", ctx.ui.theme.fg("accent", label));
    ctx.ui.setWidget("worker-frame", undefined);
  }

  function writeActiveWorkerStatus(ctx: ExtensionContext, request: ActiveWorkerRequest): void {
    const state = request.waitingReason !== undefined
      ? "waiting"
      : request.phase === "result" ? "running" : "retrospective";
    writeWorkerStatus(request.request.statusPath, {
      id: request.request.id,
      state,
      resultPath: request.request.resultPath,
      sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
      contextPercent: getContextPercent(ctx) ?? null,
      waitingReason: request.waitingReason,
      retryAt: request.retryAt,
    });
  }

  function enterWaiting(ctx: ExtensionContext, request: ActiveWorkerRequest, reason: string): void {
    request.waitingReason = reason;
    writeActiveWorkerStatus(ctx, request);
    refreshWorkerUi(ctx);
    ctx.ui.notify(`${reason} The worker is waiting for you: type a message to continue it, or use /worker-return [text] to hand back now.`, "warning");
  }

  function beginRetrospective(ctx: ExtensionContext, request: ActiveWorkerRequest, result: string): void {
    request.mainResult = result;
    request.phase = "retrospective";
    publishRecoveryPolicy();
    writeTextArtifact(path.join(path.dirname(request.request.resultPath), "result.md"), result);
    writeActiveWorkerStatus(ctx, request);
    refreshWorkerUi(ctx);
    pi.sendUserMessage(RETROSPECTIVE_PROMPT, { deliverAs: "followUp" });
  }

  function completeWorkerRequest(
    ctx: ExtensionContext,
    request: ActiveWorkerRequest,
    result: string,
    isError = false,
    retrospective?: string,
  ): void {
    writeFinalResult(ctx, request, result, isError, retrospective);
    requestFinished = true;
    activeRequest = undefined;
    publishRecoveryPolicy();
    refreshWorkerUi(ctx);
    ctx.shutdown();
  }

  /** Missing, unreadable, invalid or foreign requests fail startup and stop the owned worker. */
  function loadLeasedRequest(ctx: ExtensionContext, binding: ParentTaskBinding): void {
    const requestPath = path.join(path.dirname(binding.file), "request.json");
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(requestPath, "utf8"));
    } catch (error) {
      failStartup(ctx, `Could not read worker request: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!isWorkerRequestFile(parsed)) {
      failStartup(ctx, "Invalid worker request file.");
      return;
    }
    if (parsed.id !== binding.parent.taskId) {
      stopWorker(ctx, "Worker request does not belong to its parent task lease");
      return;
    }
    if (fs.existsSync(parsed.resultPath)) {
      ctx.ui.notify("This worker request already has a final result.", "warning");
      return;
    }
    pendingRequest = parsed;
  }

  /** Applies the request's model, thinking and tools before Pi starts the run of its first prompt. */
  async function startRequest(ctx: ExtensionContext, parsed: WorkerRequestFile): Promise<boolean> {
    activeRequest = {
      request: parsed,
      context: ctx,
      hasTakenToolAction: false,
      phase: "result",
      modelMessages: 0,
      guidance: [],
      returning: false,
    };
    const request = activeRequest;
    try {
      const model = ctx.modelRegistry.find(parsed.model.provider, parsed.model.id);
      if (!model || !(await pi.setModel(model))) {
        throw new Error(`Worker model unavailable: ${parsed.model.provider}/${parsed.model.id}`);
      }
      if (activeRequest !== request) return false;
      pi.setThinkingLevel(parsed.thinkingLevel);
      pi.setActiveTools(availableWorkerTools(parsed.tools));
      publishRecoveryPolicy();
      writeActiveWorkerStatus(ctx, request);
      refreshWorkerUi(ctx);
      return checkParent(ctx);
    } catch (error) {
      if (activeRequest !== request) return false;
      const message = `Could not start worker request: ${error instanceof Error ? error.message : String(error)}`;
      completeWorkerRequest(ctx, request, message, true);
      ctx.ui.notify(message, "error");
      return false;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    monitorParent(ctx);
    initializeNesting();
    refreshWorkerUi(ctx);
    if (parentBinding && !parentTerminated && !activeRequest && !requestFinished) loadLeasedRequest(ctx, parentBinding);
  });

  pi.on("session_tree", async (_event, ctx) => {
    refreshWorkerUi(ctx);
  });

  pi.on("agent_start", async (_event, ctx) => {
    const request = activeRequest;
    if (!request || request.waitingReason === undefined) return;
    request.waitingReason = undefined;
    writeActiveWorkerStatus(ctx, request);
    refreshWorkerUi(ctx);
  });

  pi.on("message_end", async (event) => {
    if (!activeRequest || event.message.role !== "assistant") return;
    activeRequest.modelMessages++;
    activeRequest.latestReply = assistantTextContent(event.message) ?? activeRequest.latestReply;
  });

  // Pi handles slash commands and compaction rejections before this event, so
  // it sees only what a human actually sent.
  pi.on("input", async (event, ctx) => {
    if (!checkParent(ctx)) return { action: "handled" };
    const pending = pendingRequest;
    if (pending && event.text === workerPrompt(pending)) {
      pendingRequest = undefined;
      return { action: await startRequest(ctx, pending) ? "continue" : "handled" };
    }
    const request = activeRequest;
    if (request && event.source !== "extension") request.guidance.push({ position: request.modelMessages, text: event.text });
    return { action: "continue" };
  });

  pi.on("tool_call", async (event) => {
    const request = activeRequest;
    if (!request || request.phase !== "result") return undefined;

    const isFirstToolAction = !request.hasTakenToolAction;
    request.hasTakenToolAction = true;
    // Ordinary workers may offload a small side task immediately; a microdo
    // worker still gets the forwarding warning if it starts by delegating.
    if (isFirstToolAction && SUBWORKER_TOOLS.has(event.toolName)
      && (event.toolName !== "microdo" || request.request.resultPolicy === "brief")) {
      return { block: true, reason: FIRST_ACTION_SUBWORKER_WARNING };
    }
    return undefined;
  });

  pi.registerCommand(CANCEL_WORKER_COMMAND, {
    description: "Cancel this exact parent-owned task without a result or retrospective. Usage: /worker-cancel",
    handler: async (args, ctx) => {
      if (args.trim()) throw new Error("Usage: /worker-cancel");
      if (parentTerminated) return;
      if (requestFinished) throw new Error("Worker request already finished; cancellation cannot retract its result");
      const binding = parentBinding ?? readParentTaskBinding();
      if (!binding) throw new Error("Worker cancellation requires an exact parent task lease");
      // Ending the existing authority precedes local shutdown. Parent cleanup
      // observes that same terminal lease; an uncertain command acknowledgement
      // never authorizes the frontend to kill/relaunch or discard this view.
      endParentTask(binding);
      parentBinding = binding;
      stopWorker(ctx, `Worker task ${binding.parent.taskId} cancelled by /worker-cancel`);
    },
  });

  pi.registerCommand(RETURN_WORKER_COMMAND, {
    description: "Hand back to the parent now, stopping any current work and skipping the retrospective. Usage: /worker-return [text]",
    handler: async (args, ctx) => {
      const request = activeRequest;
      if (!request) {
        ctx.ui.notify("No active worker request to return.", "warning");
        return;
      }
      if (request.returning) {
        ctx.ui.notify("Worker is already returning.", "warning");
        return;
      }
      const text = parseCommandText(args) || undefined;
      const result = request.mainResult ?? text ?? request.latestReply;
      if (result === undefined) {
        ctx.ui.notify("Nothing to return yet. Use /worker-return <text> to hand back an explicit message.", "warning");
        return;
      }

      request.returning = true;
      try {
        if (!ctx.isIdle()) await ctx.abort();
        await ctx.waitForIdle();
      } catch (error) {
        request.returning = false;
        throw error;
      }
      if (activeRequest !== request) {
        ctx.ui.notify("Worker request is no longer active.", "warning");
        return;
      }
      if (request.mainResult === undefined) {
        request.guidance.push({ position: request.modelMessages, text: "Handed back early with /worker-return; the worker did not finish on its own." });
      }
      completeWorkerRequest(ctx, request, result, false, request.mainResult === undefined ? undefined : text);
      ctx.ui.notify("Returned to the parent.", "info");
    },
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!activeRequest || activeRequest.returning || fs.existsSync(activeRequest.request.resultPath)) return;
    const message = latestAssistantMessage(event.messages);
    const handoff = activeRequest.pendingCompaction;
    if (handoff && message?.stopReason === "toolUse"
      && message.content.some((block) => block.type === "toolCall" && block.id === handoff)
      && event.messages.some((item) => item.role === "toolResult" && item.toolCallId === handoff && !item.isError)) {
      activeRequest.pendingFailure = undefined;
      return;
    }
    activeRequest.pendingCompaction = undefined;
    // Terminating tool batches can end a run without final assistant text.
    // Wait for Pi settlement before treating that as a recoverable failure.
    if (!message || message.stopReason === "toolUse") {
      activeRequest.pendingFailure = message
        ? "Worker stopped after a tool batch without final result text."
        : "Worker stopped without an assistant message.";
      return;
    }

    if (message.stopReason === "error" || message.stopReason === "aborted") {
      activeRequest.pendingFailure = assistantMessageText(message);
      return;
    }
    activeRequest.pendingFailure = undefined;

    if (activeRequest.phase === "retrospective") {
      const retrospective = message.stopReason === "stop"
        ? (assistantTextContent(message) ?? "retrospective unavailable: assistant returned no retrospective text.")
        : `retrospective unavailable: assistant stopped with reason '${message.stopReason}'. ${assistantMessageText(message)}`;
      try {
        const request = activeRequest;
        completeWorkerRequest(ctx, request, request.mainResult ?? "", false, retrospective);
        ctx.ui.notify("Finished worker request with result and retrospective.", "info");
      } catch (error) {
        ctx.ui.notify(`Failed to write worker retrospective result: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
      return;
    }

    if (message.stopReason === "stop") {
      const result = assistantTextContent(message);
      if (!result) {
        try {
          completeWorkerRequest(ctx, activeRequest, "Worker stopped without final result text.", true);
        } catch (error) {
          ctx.ui.notify(`Failed to report empty worker result: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }

      if (activeRequest.request.resultPolicy === "brief") {
        completeWorkerRequest(ctx, activeRequest, result);
      } else {
        beginRetrospective(ctx, activeRequest, result);
      }
      return;
    }

    try {
      completeWorkerRequest(ctx, activeRequest, assistantMessageText(message), true);
    } catch (error) {
      ctx.ui.notify(`Failed to write worker failure result: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  });

  function settleWorkerFailure(ctx: ExtensionContext, request: ActiveWorkerRequest): void {
    if (request.returning || request.pendingFailure === undefined || fs.existsSync(request.request.resultPath)) return;

    const failure = request.pendingFailure;
    request.pendingFailure = undefined;
    if (request.phase === "retrospective") {
      try {
        completeWorkerRequest(
          ctx,
          request,
          request.mainResult ?? "",
          false,
          `retrospective unavailable: worker run ended without a result. ${failure}`,
        );
      } catch (error) {
        ctx.ui.notify(`Failed to report unavailable worker retrospective: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
      return;
    }

    enterWaiting(ctx, request, `Worker run ended without a result: ${failure}`);
  }

  const unsubscribeHandoff = pi.events.on(SELF_COMPACT_HANDOFF_EVENT, (data) => {
    const handoff = data as SelfCompactHandoff;
    const request = activeRequest;
    if (!request) return;
    if (handoff.state === "pending") {
      request.pendingCompaction = handoff.toolCallId;
    } else if (request.pendingCompaction === handoff.toolCallId) {
      request.pendingCompaction = undefined;
      if (handoff.state === "failed") {
        request.pendingFailure = handoff.reason;
        // Compaction callbacks run after agent_settled; there may be no later lifecycle event.
        settleWorkerFailure(request.context, request);
      }
    }
  });

  const unsubscribeRecovery = pi.events.on(RECOVERY_STATUS_EVENT, (data) => {
    const request = activeRequest;
    if (!request || request.phase !== "result"
      || !isRecord(data) || data.sessionId !== request.context.sessionManager.getSessionId()) return;
    const retryAt = data.retryAt;
    if (retryAt !== undefined && (typeof retryAt !== "number" || !Number.isSafeInteger(retryAt) || retryAt <= 0)) return;
    request.retryAt = retryAt;
    writeActiveWorkerStatus(request.context, request);
    refreshWorkerUi(request.context);
  });

  const unsubscribeSwitchCheck = pi.events.on("pi-orchestration:switch-check", (data) => {
    if (activeRequest && isRecord(data)) data.blocked = true;
  });

  // Only the main task can continue: a failed retrospective ends the worker at settlement.
  const unsubscribeErrorClaim = pi.events.on(ERROR_CLAIM_EVENT, (data) => {
    if (parentTerminated || (activeRequest && (activeRequest.phase !== "result" || activeRequest.returning))) (data as ErrorClaim).claimed = true;
  });

  // A dialog answer is human input, though Pi sees it with extension source.
  const unsubscribeErrorContinue = pi.events.on(ERROR_CONTINUE_EVENT, (data) => {
    activeRequest?.guidance.push({ position: activeRequest.modelMessages, text: (data as ErrorContinue).text });
  });

  pi.on("session_shutdown", () => {
    stopParentWatch?.();
    stopParentWatch = undefined;
    unsubscribeSwitchCheck();
    unsubscribeErrorClaim();
    unsubscribeErrorContinue();
    unsubscribeHandoff();
    unsubscribeRecovery();
    if (activeRequest) {
      activeRequest.retryAt = undefined;
      writeActiveWorkerStatus(activeRequest.context, activeRequest);
      const ctx = activeRequest.context;
      activeRequest = undefined;
      refreshWorkerUi(ctx);
    }
    // Provider shutdown cancels its active request; do not leave a mode-based
    // disable behind for another session or a subsequent extension reload.
    publishRecoveryPolicy();
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (activeRequest) settleWorkerFailure(ctx, activeRequest);
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (!activeRequest) return;
    writeActiveWorkerStatus(ctx, activeRequest);
  });
}
