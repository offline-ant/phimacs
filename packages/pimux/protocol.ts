/**
 * Shared names and shapes of the pimux protocol (see README.md, the contract).
 * Pi's own records stay opaque JSON; only the fields pimux routes on are typed.
 */

export const PROTOCOL_VERSION = 2;
export const RUNTIME_CAPABILITIES = ["snapshot", "stop", "detached", "contextual-input", "models"] as const;

/**
 * The router's opaque selected-file/branch anchor, not a snapshot generation or
 * the continuously advancing projection head. Ordinary appends and refreshes do
 * not invalidate steering. A session/tree replacement creates a new contextId.
 * Clients capture this exact snapshot.inputContext when composing an action and
 * send it as pimuxContext; the router removes that metadata before forwarding.
 */
export interface InputContext {
  sessionFile: string | null;
  leafId: string | null;
  contextId: string;
}

/** Every non-getter Pi command, including dialog replies/abort, carries this. */
export interface ContextualCommand extends JsonRecord {
  type: string;
  pimuxContext: InputContext;
}

export function parseInputContext(value: unknown): InputContext | undefined {
  if (!isRecord(value) || !(value.sessionFile === null || typeof value.sessionFile === "string")
    || !(value.leafId === null || typeof value.leafId === "string")
    || typeof value.contextId !== "string" || value.contextId.length === 0 || value.contextId.length > 512) return undefined;
  return { sessionFile: value.sessionFile, leafId: value.leafId, contextId: value.contextId };
}

const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  "get_state", "get_messages", "get_entries", "get_tree", "get_commands", "get_fork_messages",
  "get_session_stats", "get_last_assistant_text", "get_available_models", "get_available_thinking_levels",
  "get_steering_messages", "get_follow_up_messages", "get_session_name",
]);

/** Unknown commands fail closed: only explicit observations bypass context. */
export function isReadOnlyCommand(type: string): boolean { return READ_ONLY_COMMANDS.has(type); }

/** Status key prefix the wrapper consumes instead of forwarding. */
export const COMPANION_STATUS_PREFIX = "pimux:";
/** Status key carrying companion records (JSON text) from Pi to the wrapper. */
export const COMPANION_STATUS_KEY = "pimux:companion";
/** Internal extension command the wrapper sends to take a snapshot. */
export const SNAPSHOT_COMMAND = "pimux-snapshot";
/** Internal command for correlated in-process catalog refresh and model selection. */
export const MODELS_COMMAND = "pimux-models";

export type ModelsAction =
  | { action: "list"; force?: boolean }
  | { action: "set"; provider: string; modelId: string };

/** Public picker metadata; provider request configuration stays inside Pi. */
export interface ModelDescriptor {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  input: readonly string[];
  contextWindow: number;
}

export interface ModelControlError { code: string; message: string }
export type ModelsOutcome =
  | { success: true; data: { models: readonly ModelDescriptor[] } | { model: ModelDescriptor; thinkingLevel: string } }
  | { success: false; error: ModelControlError };

/** Validate client/companion command arguments at the JSON boundary. */
export function parseModelsAction(value: unknown): ModelsAction | undefined {
  if (!isRecord(value)) return undefined;
  if (value.action === "list" && (value.force === undefined || typeof value.force === "boolean")) {
    return { action: "list", ...value.force === undefined ? {} : { force: value.force } };
  }
  if (value.action === "set" && typeof value.provider === "string" && value.provider.length > 0
    && !/[\s/]/.test(value.provider) && typeof value.modelId === "string" && value.modelId.length > 0
    && !/\s/.test(value.modelId)) return { action: "set", provider: value.provider, modelId: value.modelId };
  return undefined;
}

/** Listing refreshes the provider catalog, but does not change conversation input. */
export function isReadOnlyRequest(request: JsonRecord): boolean {
  return (request.type === "pimux_models" && request.action === "list")
    || (typeof request.type === "string" && isReadOnlyCommand(request.type));
}
/** Client-invoked extension command that moves the session leaf in place: `/pimux-tree-navigate [--summarize] <entryId>`. */
export const TREE_NAVIGATE_COMMAND = "pimux-tree-navigate";
/** customType of the custom entry that persists an unsummarized leaf move across Pi restarts. */
export const TREE_NAVIGATION_MARKER_TYPE = "pimux:navigate-tree";

/** Extension UI methods that wait for an `extension_ui_response`. */
export const DIALOG_METHODS: ReadonlySet<string> = new Set(["select", "confirm", "input", "editor"]);

export type JsonRecord = Record<string, unknown>;

export type Include = "entries" | "messages";
export const ALL_INCLUDES: readonly Include[] = ["entries", "messages"];

export type Placement = "root" | "worker" | "interactive-fork";

export interface SessionIdentity {
  file: string | null;
  id: string;
  name: string | null;
  cwd: string;
}

/** Session state the companion reads in one synchronous section. */
export interface SnapshotData {
  session: SessionIdentity;
  model: unknown;
  thinkingLevel: string;
  idle: boolean;
  leafId: string | null;
  /** Every session entry in append order: flat, because a session's tree nests one level per entry. */
  entries?: unknown[];
  messages?: unknown[];
  /** Why a change's snapshot carries no history; only the identity above is known to be current. */
  historyError?: string;
}

/** Public socket snapshot. A null context preserves identity but disables input. */
export interface PimuxSnapshot extends SnapshotData {
  type: "pimux_snapshot";
  generation: number;
  reason: "attach" | "request" | "gap" | "session_changed" | "tree_changed";
  inputContext: InputContext | null;
  replay: number;
  run: { active: boolean; compacting: boolean; tailTruncated: boolean };
}

/** Records the companion sends through `setStatus(COMPANION_STATUS_KEY, JSON)`. */
export type CompanionRecord =
  | { kind: "identity"; reason: "startup" | "reload"; session: SessionIdentity; model: unknown; thinkingLevel: string }
  | { kind: "session"; reason: "new" | "resume" | "fork"; previousSessionFile: string | null; data: SnapshotData }
  | { kind: "tree"; newLeafId: string | null; oldLeafId: string | null; data: SnapshotData }
  | { kind: "snapshot"; generation: number; data: SnapshotData }
  | { kind: "snapshot-failed"; generation: number; error: string }
  | { kind: "model"; model: unknown; previousModel: unknown; source: string }
  | { kind: "prompts-ended" }
  | ({ kind: "models-result"; requestId: string } & ModelsOutcome);

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses `--include`-style lists; undefined means all. */
export function parseIncludes(value: unknown): Include[] | undefined {
  if (value === undefined) return [...ALL_INCLUDES];
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const result: Include[] = [];
  for (const item of value) {
    if (item !== "entries" && item !== "messages") return undefined;
    if (!result.includes(item)) result.push(item);
  }
  return result;
}

export function parsePlacement(value: string | undefined): Placement {
  return value === "worker" || value === "interactive-fork" ? value : "root";
}

/** Removes ANSI escape sequences, which themed status text may contain. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}
