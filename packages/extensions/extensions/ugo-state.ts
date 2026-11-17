// Ugo loop state as persisted in and read back from the session branch.
import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { PresentGuidanceParams } from "./guidance-core.ts";

export const STATE_CUSTOM_TYPE = "pi-ant:ugo-state";
export const RESULT_CUSTOM_TYPE = "pi-ant:ugo-guidance";
export const MESSAGE_CUSTOM_TYPE = "pi-ant:ugo-message";
export const PRESENT_GUIDANCE_TOOL = "present_guidance";

type UgoPhase =
  | "guide"
  | "do"
  | "do_retrospective"
  | "paused"
  | "awaiting_decision"
  | "empty";

export interface UgoState {
  active: boolean;
  phase: UgoPhase;
  iteration: number;
  originalTools: string[];
  previousGuidance?: PresentGuidanceParams;
  lastGuidance?: PresentGuidanceParams;
  doPrompt?: string;
  doCompleted?: boolean;
  doMainResponse?: string;
  previousReflection?: string;
  pauseRequested?: boolean;
  reason?: string;
}

export type ReplacementSessionContext = ExtensionCommandContext & {
  sendMessage: (...args: Parameters<ExtensionAPI["sendMessage"]>) => Promise<void>;
  sendUserMessage: (...args: Parameters<ExtensionAPI["sendUserMessage"]>) => Promise<void>;
};

type CustomStateEntryLike =
  | Extract<SessionEntry, { type: "custom" }>
  | Extract<SessionEntry, { type: "custom_message" }>;

interface MessageLike {
  role?: unknown;
  content?: unknown;
}

interface MessageEntryLike {
  type?: unknown;
  message?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isGuidanceStatus(
  value: unknown,
): value is PresentGuidanceParams["status"] {
  return (
    value === "CONTINUE_WORK" ||
    value === "UPDATE_WORK" ||
    value === "REQUIRE_HUMAN_DECISION" ||
    value === "EMPTY_WORKBOARD"
  );
}

function isPresentGuidanceParams(
  value: unknown,
): value is PresentGuidanceParams {
  if (!isRecord(value)) return false;
  return (
    isGuidanceStatus(value.status) &&
    typeof value.item === "string" &&
    typeof value.reason === "string" &&
    (value.nextPrompt === undefined || typeof value.nextPrompt === "string") &&
    (value.workboardUpdate === undefined ||
      typeof value.workboardUpdate === "string")
  );
}

function normalizePhase(value: unknown): UgoPhase | undefined {
  if (
    value === "guide" ||
    value === "do" ||
    value === "do_retrospective" ||
    value === "paused" ||
    value === "awaiting_decision" ||
    value === "empty"
  ) {
    return value;
  }
  return undefined;
}

function isUgoState(value: unknown): value is UgoState {
  if (!isRecord(value)) return false;
  return (
    typeof value.active === "boolean" &&
    normalizePhase(value.phase) !== undefined &&
    typeof value.iteration === "number" &&
    Array.isArray(value.originalTools) &&
    value.originalTools.every((tool) => typeof tool === "string")
  );
}

function getCustomStateEntries(ctx: ExtensionContext): CustomStateEntryLike[] {
  return ctx.sessionManager
    .getBranch()
    .filter(
      (entry): entry is CustomStateEntryLike =>
        entry.type === "custom" || entry.type === "custom_message",
    );
}

function getStateFromDetails(details: unknown): UgoState | undefined {
  if (!isRecord(details)) return undefined;
  return isUgoState(details.state) ? details.state : undefined;
}

export function getLatestState(ctx: ExtensionContext): UgoState | undefined {
  const entries = getCustomStateEntries(ctx);
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (
      entry.type === "custom" &&
      entry.customType === STATE_CUSTOM_TYPE &&
      isUgoState(entry.data)
    )
      return entry.data;
    if (entry.type === "custom_message" && entry.customType === MESSAGE_CUSTOM_TYPE) {
      const state = getStateFromDetails(entry.details);
      if (state) return state;
    }
  }
  return undefined;
}

export function getLatestGuidance(
  ctx: ExtensionContext,
): PresentGuidanceParams | undefined {
  const entries = getCustomStateEntries(ctx);
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (
      entry.type === "custom" &&
      entry.customType === RESULT_CUSTOM_TYPE &&
      isPresentGuidanceParams(entry.data)
    )
      return entry.data;
  }
  return undefined;
}

export function withoutPresentGuidance(tools: string[]): string[] {
  return tools.filter((tool) => tool !== PRESENT_GUIDANCE_TOOL);
}

export function uniqueTools(tools: string[]): string[] {
  return [...new Set(tools)];
}

export function persistState(sessionManager: SessionManager, state: UgoState): void {
  sessionManager.appendCustomEntry(STATE_CUSTOM_TYPE, state);
}

export function appendUgoMessage(
  sessionManager: SessionManager,
  content: string,
  details: unknown,
): void {
  sessionManager.appendCustomMessageEntry(
    MESSAGE_CUSTOM_TYPE,
    content,
    true,
    details,
  );
}

export function hasReplacementMessageMethods(
  ctx: ExtensionContext | ReplacementSessionContext,
): ctx is ReplacementSessionContext {
  return "sendMessage" in ctx;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: unknown) => {
      if (!isRecord(block)) return "";
      return block.type === "text" && typeof block.text === "string"
        ? block.text
        : "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

function textFromMessage(message: unknown, role: "assistant" | "user"): string {
  if (!isRecord(message)) return "";
  const candidate = message as MessageLike;
  if (candidate.role !== role) return "";
  return textFromContent(candidate.content);
}

function lastMessageTextFromContext(
  ctx: ExtensionContext,
  role: "assistant" | "user",
): string {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index] as MessageEntryLike;
    if (entry.type !== "message") continue;
    const text = textFromMessage(entry.message, role);
    if (text.trim().length > 0) return text;
  }
  return "";
}

export function lastAssistantTextFromContext(ctx: ExtensionContext): string {
  return lastMessageTextFromContext(ctx, "assistant");
}

export function latestAssistantMessage(
  messages: AgentEndEvent["messages"],
): Extract<AgentEndEvent["messages"][number], { role: "assistant" }> | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

export function lastUserTextFromContext(ctx: ExtensionContext): string {
  return lastMessageTextFromContext(ctx, "user");
}
