/**
 * The state a continuously connected client would have built from Pi's
 * records, kept so a late or recovering client can be given it at a snapshot
 * boundary: fire-and-forget UI state, open dialogs, and the live tail of
 * in-flight work. Completed messages are not kept; they come from the session
 * tree in the snapshot.
 */
import { isRecord, type InputContext, type JsonRecord, type SessionIdentity, stripAnsi } from "./protocol.ts";

export interface StateLimits {
  /** Bytes of tail records before streaming updates stop being kept. */
  tailBytes: number;
  /** Status, widget and dialog entries kept per kind; the oldest go first. */
  uiEntries: number;
  /** Bytes of status and widget records kept; the oldest go first. */
  uiBytes: number;
}

export const DEFAULT_STATE_LIMITS: StateLimits = { tailBytes: 32 * 1024 * 1024, uiEntries: 256, uiBytes: 4 * 1024 * 1024 };

export type MuxStatus = "starting" | "working" | "idle" | "blocked";
export type Blocked = { reason: "dialog"; method: string; title: string | null } | { reason: "worker-waiting" };

/** True when a model switch may proceed: idle, or a waiting worker, whose run has ended and whose human may switch before continuing. */
export function acceptsModelChange(status: { status: MuxStatus; blocked: Blocked | null }): boolean {
  return status.status === "idle" || status.blocked?.reason === "worker-waiting";
}

interface TailEntry { key: string; record: JsonRecord; bytes: number }

const DELTA_KINDS = new Set(["text_delta", "thinking_delta", "toolcall_delta"]);
const WORKER_STATUS_KEY = "worker-frame";

/** Tail keys that belong to an agent run and end with it. */
function isRunKey(key: string): boolean {
  return !key.startsWith("bash:") && key !== "compaction";
}

class BoundedMap {
  private readonly entries = new Map<string, { record: JsonRecord; bytes: number }>();
  private bytes = 0;
  private readonly limits: StateLimits;

  constructor(limits: StateLimits) {
    this.limits = limits;
  }

  set(key: string, record: JsonRecord, bytes: number): void {
    this.delete(key);
    this.entries.set(key, { record, bytes });
    this.bytes += bytes;
    for (const [oldest, value] of this.entries) {
      if (this.entries.size <= this.limits.uiEntries && this.bytes <= this.limits.uiBytes) break;
      this.entries.delete(oldest);
      this.bytes -= value.bytes;
    }
  }

  delete(key: string): void {
    const existing = this.entries.get(key);
    if (!existing) return;
    this.entries.delete(key);
    this.bytes -= existing.bytes;
  }

  records(): JsonRecord[] {
    return [...this.entries.values()].map((entry) => entry.record);
  }
}

export class MuxState {
  session: SessionIdentity | null = null;
  /** Authoritative branch anchor; null means contextual input must be refused. */
  inputContext: InputContext | null = null;
  model: unknown = null;
  thinkingLevel: string | null = null;
  runActive = false;
  compacting = false;
  /** Tail keys whose streaming updates stopped being kept because the tail was full. */
  private readonly truncated = new Set<string>();
  private tail: TailEntry[] = [];
  private tailBytes = 0;
  private title: JsonRecord | undefined;
  private queue: JsonRecord | undefined;
  private readonly statuses: BoundedMap;
  private readonly widgets: BoundedMap;
  private readonly dialogs = new Map<string, JsonRecord>();
  private workerWaiting = false;
  private readonly limits: StateLimits;

  constructor(limits: StateLimits = DEFAULT_STATE_LIMITS) {
    this.limits = limits;
    this.statuses = new BoundedMap(limits);
    this.widgets = new BoundedMap(limits);
  }

  /** Session events from Pi's stdout, in order; `bytes` is the record's serialized size. */
  observeEvent(record: JsonRecord, bytes: number): void {
    switch (record.type) {
      case "agent_start":
        if (!this.runActive) {
          this.runActive = true;
          this.dropTail(isRunKey);
          this.push("agent", record, bytes, false);
        }
        return;
      case "agent_settled":
        this.runActive = false;
        this.dropTail(isRunKey);
        return;
      case "turn_start": this.replace("turn", record, bytes); return;
      case "turn_end": this.remove("turn"); return;
      case "message_start": this.replace("msg", record, bytes); return;
      case "message_update": if (this.has("msg")) this.pushUpdate(record, bytes); return;
      case "message_end": {
        this.remove("msg");
        const message = record.message;
        if (isRecord(message) && message.role === "toolResult" && typeof message.toolCallId === "string") this.remove(`tool:${message.toolCallId}`);
        return;
      }
      case "tool_execution_start":
        if (typeof record.toolCallId === "string") this.replace(`tool:${record.toolCallId}`, record, bytes);
        return;
      case "tool_execution_update":
      case "tool_execution_end": {
        const key = `tool:${String(record.toolCallId)}`;
        if (this.has(key)) this.push(key, record, bytes, record.type === "tool_execution_update");
        return;
      }
      case "compaction_start": this.compacting = true; this.replace("compaction", record, bytes); return;
      case "compaction_end": this.compacting = false; this.remove("compaction"); return;
      case "auto_retry_start": this.replace("retry", record, bytes); return;
      case "auto_retry_end": this.remove("retry"); return;
      case "summarization_retry_scheduled":
      case "summarization_retry_attempt_start": this.replace("summary-retry", record, bytes); return;
      case "summarization_retry_finished": this.remove("summary-retry"); return;
      case "queue_update": this.queue = record; return;
      case "session_info_changed":
        if (this.session) this.session = { ...this.session, name: typeof record.name === "string" ? record.name : null };
        return;
      case "thinking_level_changed":
        if (typeof record.level === "string") this.thinkingLevel = record.level;
        return;
    }
  }

  /** Fire-and-forget extension UI requests that describe lasting state. */
  observeUi(record: JsonRecord, bytes: number): void {
    if (record.method === "setTitle") this.title = record;
    else if (record.method === "setStatus" && typeof record.statusKey === "string") {
      const text = typeof record.statusText === "string" ? record.statusText : undefined;
      if (text === undefined) this.statuses.delete(record.statusKey);
      else this.statuses.set(record.statusKey, record, bytes);
      if (record.statusKey === WORKER_STATUS_KEY) this.workerWaiting = text !== undefined && stripAnsi(text).startsWith("worker:waiting");
    } else if (record.method === "setWidget" && typeof record.widgetKey === "string") {
      if (Array.isArray(record.widgetLines)) this.widgets.set(record.widgetKey, record, bytes);
      else this.widgets.delete(record.widgetKey);
    }
  }

  openDialog(record: JsonRecord): void {
    this.dialogs.set(String(record.id), record);
    for (const id of this.dialogs.keys()) {
      if (this.dialogs.size <= this.limits.uiEntries) break;
      this.dialogs.delete(id);
    }
  }

  closeDialog(id: string): boolean {
    return this.dialogs.delete(id);
  }

  hasDialog(id: string): boolean {
    return this.dialogs.has(id);
  }

  dialogIds(): string[] {
    return [...this.dialogs.keys()];
  }

  bashStart(bashId: string, record: JsonRecord, bytes: number): void {
    this.push(`bash:${bashId}`, record, bytes, false);
  }

  bashUpdate(bashId: string, record: JsonRecord, bytes: number): void {
    const key = `bash:${bashId}`;
    if (this.has(key)) this.push(key, record, bytes, true);
  }

  bashEnd(bashId: string): void {
    this.remove(`bash:${bashId}`);
  }

  /** A replaced runtime starts idle: its predecessor's run never settles on the wire. */
  resetRun(): void {
    this.runActive = false;
    this.compacting = false;
    this.dropTail((key) => !key.startsWith("bash:"));
  }

  /** Records that rebuild UI state and in-flight work, in the order the contract specifies. */
  replay(): JsonRecord[] {
    return [
      ...this.title ? [this.title] : [],
      ...this.statuses.records(),
      ...this.widgets.records(),
      ...this.queue ? [this.queue] : [],
      ...this.tail.map((entry) => entry.record),
      ...this.dialogs.values(),
    ];
  }

  status(): { status: MuxStatus; blocked: Blocked | null } {
    if (!this.session) return { status: "starting", blocked: null };
    const dialog = this.dialogs.values().next().value;
    const blocked: Blocked | null = dialog
      ? { reason: "dialog", method: String(dialog.method), title: typeof dialog.title === "string" ? dialog.title : null }
      : this.workerWaiting ? { reason: "worker-waiting" } : null;
    if (blocked) return { status: "blocked", blocked };
    const bashRunning = this.tail.some((entry) => entry.key.startsWith("bash:"));
    return { status: this.runActive || this.compacting || bashRunning ? "working" : "idle", blocked: null };
  }

  private has(key: string): boolean {
    return this.tail.some((entry) => entry.key === key);
  }

  private replace(key: string, record: JsonRecord, bytes: number): void {
    this.remove(key);
    this.push(key, record, bytes, false);
  }

  private remove(key: string): void {
    this.dropTail((entryKey) => entryKey === key);
  }

  private dropTail(matches: (key: string) => boolean): void {
    const kept = this.tail.filter((entry) => !matches(entry.key));
    if (kept.length === this.tail.length) return;
    this.tail = kept;
    this.tailBytes = kept.reduce((sum, entry) => sum + entry.bytes, 0);
    for (const key of this.truncated) if (!kept.some((entry) => entry.key === key)) this.truncated.delete(key);
  }

  get tailTruncated(): boolean {
    return this.truncated.size > 0;
  }

  /** Streaming records are dropped once the tail is full; structural ones never are. */
  private push(key: string, record: JsonRecord, bytes: number, streaming: boolean): void {
    if (streaming && (this.truncated.has(key) || this.tailBytes + bytes > this.limits.tailBytes)) {
      // A gap inside one stream would corrupt its replay, so the rest of it goes too.
      this.truncated.add(key);
      return;
    }
    this.tail.push({ key, record, bytes });
    this.tailBytes += bytes;
  }

  /** Adjacent deltas of one content block merge into one record with the same effect. */
  private pushUpdate(record: JsonRecord, bytes: number): void {
    const last = this.tail.at(-1);
    const event = record.assistantMessageEvent;
    const previous = last?.record.assistantMessageEvent;
    if (last?.key === "msg" && last.record.type === "message_update" && isRecord(event) && isRecord(previous)
      && DELTA_KINDS.has(String(event.type)) && event.type === previous.type && event.contentIndex === previous.contentIndex
      && typeof event.delta === "string" && typeof previous.delta === "string") {
      const added = event.delta.length;
      if (this.truncated.has("msg") || this.tailBytes + added > this.limits.tailBytes) {
        this.truncated.add("msg");
        return;
      }
      last.record = { ...record, assistantMessageEvent: { ...event, delta: previous.delta + event.delta } };
      last.bytes += added;
      this.tailBytes += added;
      return;
    }
    this.push("msg", record, bytes, true);
  }
}
