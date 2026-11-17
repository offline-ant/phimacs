/**
 * An ordinary protocol-2 socket peer for `pimux agent`: it observes one runtime
 * and rebuilds the runtime's own status (MuxState, the discovery status source)
 * from each snapshot's identity, its replay and later live records. It never
 * sends input; prompts use the separate contextual request path.
 */
import * as net from "node:net";
import type { DiscoveryRecord } from "./discovery.ts";
import { LineSplitter } from "./jsonl.ts";
import { DIALOG_METHODS, isRecord, PROTOCOL_VERSION, type JsonRecord, type SessionIdentity } from "./protocol.ts";
import { validateSocket } from "./runtime-control.ts";
import { MuxState, type Blocked, type MuxStatus } from "./state.ts";

export interface AgentStatus { status: MuxStatus; blocked: Blocked | null }

/** Text of one user or assistant message; tool output and thinking are omitted. */
export interface TextMessage { role: "user" | "assistant"; text: string }

export type AgentUpdate =
  /** A complete snapshot/live boundary, or one live record after it. */
  | { kind: "observed"; record: JsonRecord | null }
  /** Pi exited (`pimux_exit`) or the connection ended without a boundary. */
  | { kind: "ended"; exit: JsonRecord | null; error: string };

export class AgentConnection {
  readonly muxId: string;
  private readonly socket: net.Socket;
  private state = new MuxState();
  private generation: number | undefined;
  private boundary = false;
  private messages: unknown[] = [];
  /** Latest in-flight message from replay/live streaming records. */
  private streaming: unknown;
  private ended = false;
  private readonly listener: (update: AgentUpdate) => void;

  constructor(record: DiscoveryRecord, listener: (update: AgentUpdate) => void) {
    this.muxId = record.muxId;
    this.listener = listener;
    validateSocket(record.socket);
    this.socket = net.connect(record.socket);
    let hello = false;
    const lines = new LineSplitter((line) => {
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { parsed = undefined; }
      if (!isRecord(parsed)) return this.end(null, "Malformed runtime record");
      if (!hello) {
        if (parsed.type !== "pimux_hello" || parsed.protocol !== PROTOCOL_VERSION || parsed.muxId !== record.muxId
          || (record.piPid !== null && parsed.piPid !== record.piPid)) return this.end(null, "Runtime identity/protocol mismatch");
        hello = true;
      } else this.receive(parsed, line.length);
    }, 128 * 1024 * 1024, () => this.end(null, "Runtime record exceeds its bound"));
    this.socket.on("data", (chunk: Buffer) => lines.push(chunk));
    this.socket.once("error", (error) => this.end(null, error.message));
    this.socket.once("close", () => this.end(null, "Runtime connection closed"));
  }

  /** Status as of the last complete boundary plus the live records after it. */
  status(): AgentStatus { return this.state.status(); }

  /** Whether a complete snapshot/live boundary has been observed and no newer one is pending. */
  get live(): boolean { return this.boundary; }

  /** The session the last snapshot named. */
  get session(): SessionIdentity | null { return this.state.session; }

  /** Completed user/assistant text messages in Pi's active projection, oldest first. */
  textMessages(): TextMessage[] { return this.messages.flatMap((message) => textMessage(message) ?? []); }

  /** Text of the assistant message still streaming, if any. */
  inFlightText(): string | null {
    const message = textMessage(this.streaming);
    return message?.role === "assistant" && message.text ? message.text : null;
  }

  close(): void {
    this.ended = true;
    this.socket.destroy();
  }

  private receive(record: JsonRecord, bytes: number): void {
    const type = record.type;
    if (type === "pimux_snapshot") {
      // A newer snapshot abandons an unfinished older sequence.
      this.generation = typeof record.generation === "number" ? record.generation : undefined;
      this.boundary = false;
      this.state = new MuxState();
      // The runtime's own snapshot identity (wire input from a verified same-user socket).
      this.state.session = isRecord(record.session) ? record.session as unknown as SessionIdentity : null;
      const run = isRecord(record.run) ? record.run : {};
      this.state.runActive = run.active === true;
      this.state.compacting = run.compacting === true;
      this.messages = Array.isArray(record.messages) ? record.messages : [];
      this.streaming = undefined;
      return;
    }
    if (type === "pimux_live") {
      if (record.generation !== this.generation || this.generation === undefined) return;
      this.boundary = true;
      this.listener({ kind: "observed", record: null });
      return;
    }
    if (type === "pimux_exit") return this.end(record, "Pi exited");
    if (type === "pimux_snapshot_failed") return this.end(null, `Runtime snapshot failed: ${String(record.error)}`);
    if (type === "pimux_gap" || type === "pimux_session_changed" || type === "pimux_tree_changed") {
      // The next snapshot of this generation replaces everything known.
      this.boundary = false;
      return;
    }
    if (type === "response" || type === "pimux_editor_text") return;
    if (this.generation === undefined) return;
    this.observe(record, bytes);
    if (this.boundary) this.listener({ kind: "observed", record });
  }

  /** The same transitions the runtime applies to its own state, in record order. */
  private observe(record: JsonRecord, bytes: number): void {
    switch (record.type) {
      case "extension_ui_request":
        if (typeof record.method === "string" && DIALOG_METHODS.has(record.method)) this.state.openDialog(record);
        else this.state.observeUi(record, bytes);
        return;
      case "pimux_dialog_closed": this.state.closeDialog(String(record.id)); return;
      case "pimux_bash_start": this.state.bashStart(String(record.bashId), record, bytes); return;
      case "pimux_bash_end": this.state.bashEnd(String(record.bashId)); return;
      case "message_start":
      case "message_update": this.streaming = record.message; break;
      case "message_end":
        this.streaming = undefined;
        this.messages.push(record.message);
        break;
    }
    this.state.observeEvent(record, bytes);
  }

  private end(exit: JsonRecord | null, error: string): void {
    if (this.ended) return;
    this.ended = true;
    this.boundary = false;
    this.socket.destroy();
    this.listener({ kind: "ended", exit, error });
  }
}

function textMessage(message: unknown): TextMessage | undefined {
  if (!isRecord(message) || (message.role !== "user" && message.role !== "assistant")) return undefined;
  const content = message.content;
  const text = typeof content === "string" ? content
    : Array.isArray(content) ? content.flatMap((part) => isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n")
    : "";
  return text.trim() ? { role: message.role, text } : undefined;
}
