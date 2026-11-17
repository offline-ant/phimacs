/**
 * The router between one Pi RPC process and its attached frontends. It owns no
 * I/O: the wrapper feeds it Pi's stdout lines and client lines, and gives it a
 * writer for Pi's stdin and a sink per client.
 */
import { Client, type QueueLimits, DEFAULT_QUEUE_LIMITS, type Sink } from "./client.ts";
import {
  COMPANION_STATUS_KEY, COMPANION_STATUS_PREFIX, type CompanionRecord, DIALOG_METHODS, isRecord, type JsonRecord,
  ALL_INCLUDES, isReadOnlyCommand, parseInputContext, parseIncludes, PROTOCOL_VERSION, RUNTIME_CAPABILITIES, SNAPSHOT_COMMAND, type SnapshotData,
} from "./protocol.ts";
import { DEFAULT_STATE_LIMITS, MuxState, type StateLimits } from "./state.ts";

export type SnapshotReason = "attach" | "request" | "gap" | "session_changed" | "tree_changed";

export interface MuxOptions {
  muxId: string;
  socketPath: string;
  piPid: number;
  writeToPi(record: JsonRecord): void;
  /** Identity or status changed; the wrapper republishes discovery. */
  onStatus(): void;
  /** Bounded private diagnostics; no client is a privileged output sink. */
  onDiagnostic?(line: string): void;
  /** Called at an authoritative companion boundary, including zero-client readiness. */
  onSnapshot?(data: SnapshotData): void;
  /** Startup is not input-ready until the runtime transaction commits. */
  canAcceptCommands?(): boolean;
  /** While this returns a reason, input other than aborts and dialog answers is refused with it. */
  inputRefusal?(): string | undefined;
  /** Runtime-owned, identity-bound stop. The callback retains idempotent receipts. */
  onStop?(operationId: string): Promise<JsonRecord>;
  maxPendingRequests?: number;
  queueLimits?: QueueLimits;
  stateLimits?: StateLimits;
  snapshotTimeoutMs?: number;
}

interface PendingRequest {
  clientId: number | null;
  hasId: boolean;
  originalId: unknown;
  bashId?: string;
  changesContext?: boolean;
  /** Forwarded input, not an observation: Pi may still start work for it. */
  input?: boolean;
}

/** Gated input may still end or answer existing work. */
const GATE_ALLOWED: ReadonlySet<string> = new Set(["abort", "abort_bash", "abort_retry", "extension_ui_response"]);
interface PendingSnapshot {
  clientId?: number;
  reason: SnapshotReason;
  timer: ReturnType<typeof setTimeout>;
  resolve?(data: SnapshotData): void;
  reject?(error: Error): void;
}

const json = (record: unknown): string => JSON.stringify(record);

export class Mux {
  readonly state: MuxState;
  private readonly clients = new Map<number, Client>();
  private readonly requests = new Map<string, PendingRequest>();
  private readonly snapshots = new Map<number, PendingSnapshot>();
  private readonly dialogTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly options: MuxOptions;
  private readonly queueLimits: QueueLimits;
  private nextClientId = 0;
  private nextRequest = 0;
  private nextBash = 0;
  private generation = 0;
  private statusSignature = "";
  private finished = false;
  private nextEditorNotice = 0;
  private editorNoticeBytes = 0;
  private editorNotices: JsonRecord[] = [];
  private readonly stopping = new Set<number>();
  private readonly readyClients = new Set<number>();
  private readonly contextTransitions = new Set<string>();
  private nextContext = 0;

  constructor(options: MuxOptions) {
    this.options = options;
    this.queueLimits = options.queueLimits ?? DEFAULT_QUEUE_LIMITS;
    this.state = new MuxState(options.stateLimits ?? DEFAULT_STATE_LIMITS);
  }

  get clientCount(): number { return this.clients.size; }
  get pendingRequestCount(): number { return this.requests.size; }
  get pendingSnapshotCount(): number { return this.snapshots.size; }
  get dialogTimerCount(): number { return this.dialogTimers.size; }
  /** Forwarded input commands that Pi has not answered yet. */
  get pendingInputCount(): number { return [...this.requests.values()].filter(request => request.input).length; }

  addClient(sink: Sink): Client {
    if (this.finished) throw new Error("Pi has exited");
    const client = new Client(++this.nextClientId, sink, this.queueLimits, {
      overflow: (target) => this.recover(target),
      terminal: (target) => this.removeClient(target),
    });
    this.clients.set(client.id, client);
    client.enqueue(json({
      type: "pimux_hello", protocol: PROTOCOL_VERSION, capabilities: RUNTIME_CAPABILITIES,
      muxId: this.options.muxId, clientId: client.id,
      piPid: this.options.piPid, socket: this.options.socketPath,
    }), "response");
    if (!client.closed) this.bootstrap(client, "attach");
    return client;
  }

  removeClient(client: Client): void {
    client.close();
    this.clients.delete(client.id);
    this.stopping.delete(client.id);
    this.readyClients.delete(client.id);
    for (const [id, request] of this.requests) {
      if (request.clientId !== client.id) continue;
      if (request.bashId || request.changesContext || request.input) {
        // Accepted input, shell or transition work still needs its boundary (Pi may
        // start work for it, e.g. after an async input hook), but no draft, response
        // ID or former client ownership survives disconnection.
        request.clientId = null;
        request.originalId = undefined;
        request.hasId = false;
      } else this.requests.delete(id);
    }
    for (const [generation, pending] of this.snapshots) {
      if (pending.clientId !== client.id) continue;
      clearTimeout(pending.timer);
      this.snapshots.delete(generation);
    }
  }

  /** Uses the companion's exact stream boundary without manufacturing a client. */
  takeSnapshot(): Promise<SnapshotData> {
    if (this.finished) return Promise.reject(new Error("Pi has exited"));
    if (this.snapshots.size >= 4096) return Promise.reject(new Error("Too many pending snapshots"));
    return new Promise((resolve, reject) => {
      const generation = ++this.generation;
      const timer = this.snapshotTimer(generation);
      this.snapshots.set(generation, { reason: "request", timer, resolve, reject });
      this.requestSnapshot(generation, ALL_INCLUDES);
    });
  }

  /** One line of Pi's stdout. */
  piLine(line: string): void {
    if (this.finished) return;
    let record: unknown;
    try { record = JSON.parse(line); } catch { record = undefined; }
    if (!isRecord(record)) {
      this.diagnostic(`Malformed Pi output: ${line}`);
      return;
    }
    if (record.type === "response") this.piResponse(record, line);
    else if (record.type === "extension_ui_request") this.piUi(record, line);
    else if (record.type === "bash_execution_update") this.piBashUpdate(record, line);
    else {
      this.state.observeEvent(record, line.length);
      this.broadcast(line);
    }
    this.notifyStatus();
  }

  /** One line a client sent. */
  clientLine(client: Client, line: string): void {
    if (this.finished || client.closed || this.clients.get(client.id) !== client) return;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch (error) {
      this.respond(client, { type: "response", command: "parse", success: false,
        error: `Failed to parse command: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    if (!isRecord(record)) {
      this.respond(client, { type: "response", command: "parse", success: false, error: "Failed to parse command: not a JSON object" });
      return;
    }
    if (typeof record.type !== "string" || record.type.length === 0) {
      this.respond(client, { type: "response", command: "parse", success: false, error: "Command type must be a nonempty string" });
      return;
    }
    if (record.type.startsWith("pimux_")) {
      this.pimuxCommand(client, record);
      return;
    }
    if (!isReadOnlyCommand(record.type)) {
      let error: string | undefined;
      const expected = parseInputContext(record.pimuxContext);
      const actual = this.state.inputContext;
      const refusal = GATE_ALLOWED.has(record.type) ? undefined : this.options.inputRefusal?.();
      if (this.options.canAcceptCommands?.() === false) error = "Runtime startup has not committed";
      else if (refusal) error = refusal;
      else if (!this.readyClients.has(client.id) || client.muteGeneration !== null || client.queuedLines > 0) error = "This client has not received a successful snapshot/live boundary";
      else if (!actual || (this.contextTransitions.size > 0 && record.type !== "extension_ui_response")) error = "Runtime input context is pending or unknown";
      else if (!expected || expected.contextId !== actual.contextId || expected.sessionFile !== actual.sessionFile || expected.leafId !== actual.leafId) error = "Stale or missing input context; recover this action in its original conversation";
      if (error) {
        this.respond(client, { ...("id" in record ? { id: record.id } : {}), type: "response", command: record.type,
          success: false, delivery: "rejected", error: `${error}; input was not forwarded` });
        return;
      }
    }
    // Transport metadata never becomes a native Pi command field.
    const { pimuxContext: _context, inputContext: _browserContext, ...command } = record;
    if (record.type === "extension_ui_response") {
      const id = String(record.id);
      // First answer wins; later answers to a closed dialog are dropped.
      if (!this.state.hasDialog(id)) return;
      try { this.options.writeToPi(command); }
      catch (error) {
        this.diagnostic(`Dialog answer delivery is uncertain: ${String(error)}`);
        this.respond(client, { type: "response", command: record.type, id: record.id, success: false,
          delivery: "uncertain", error: "Dialog answer delivery is uncertain; await authoritative closure, do not resend automatically" });
        return;
      }
      this.closeDialog(id, "answered", client.id);
      return;
    }
    if (this.requests.size >= (this.options.maxPendingRequests ?? 4096)) {
      this.respond(client, { ...("id" in record ? { id: record.id } : {}), type: "response", command: record.type,
        success: false, error: "Too many pending requests; connection closed without forwarding input" });
      this.removeClient(client);
      return;
    }
    const id = `c${client.id}/${++this.nextRequest}`;
    const request: PendingRequest = { clientId: client.id, hasId: "id" in record, originalId: record.id,
      input: !isReadOnlyCommand(record.type) };
    request.changesContext = ["new_session", "switch_session", "fork", "clone", "navigate_tree"].includes(record.type)
      || (record.type === "prompt" && typeof record.message === "string" && record.message.trimStart().startsWith("/"));
    this.requests.set(id, request);
    if (request.changesContext) this.contextTransitions.add(id);
    if (record.type === "bash") {
      request.bashId = `b${++this.nextBash}`;
      const start = { type: "pimux_bash_start", bashId: request.bashId, command: record.command,
        excludeFromContext: record.excludeFromContext === true, clientId: client.id };
      const startLine = json(start);
      this.state.bashStart(request.bashId, start, startLine.length);
      this.broadcast(startLine);
      this.notifyStatus();
    }
    try { this.options.writeToPi({ ...command, id }); }
    catch (error) {
      // A partial write is uncertain. Retain any transition fence until an
      // authoritative response; a reconnect never authorizes paid-work replay.
      this.diagnostic(`Command delivery is uncertain: ${String(error)}`);
      this.respond(client, { ...("id" in record ? { id: record.id } : {}), type: "response", command: record.type,
        success: false, delivery: "uncertain", error: "Command delivery is uncertain; do not resend automatically" });
    }
  }

  /** Pi exited: the last record every client receives. */
  finish(exit: { code: number | null; signal: string | null; stderrTail: string }): void {
    if (this.finished) return;
    this.finished = true;
    for (const timer of this.dialogTimers.values()) clearTimeout(timer);
    this.dialogTimers.clear();
    for (const pending of this.snapshots.values()) {
      clearTimeout(pending.timer);
      pending.reject?.(new Error("Pi exited before the snapshot boundary"));
    }
    this.snapshots.clear();
    this.requests.clear();
    this.stopping.clear();
    this.readyClients.clear();
    this.contextTransitions.clear();
    const line = json({ type: "pimux_exit", ...exit });
    for (const client of this.clients.values()) client.enqueue(line, "response");
  }

  private diagnostic(line: string): void {
    this.options.onDiagnostic?.(line.slice(0, 4096));
  }

  private respond(client: Client, record: JsonRecord): void {
    client.enqueue(json(record), "response");
  }

  private broadcast(line: string): void {
    for (const client of this.clients.values()) if (client.muteGeneration === null) client.enqueue(line, "live");
  }

  private notifyStatus(): void {
    const { session, model, thinkingLevel } = this.state;
    const signature = json([this.state.status(), session, model, thinkingLevel]);
    if (signature === this.statusSignature) return;
    this.statusSignature = signature;
    this.options.onStatus();
  }

  private pimuxCommand(client: Client, record: JsonRecord): void {
    const reply = (fields: JsonRecord): void => this.respond(client, {
      ...("id" in record ? { id: record.id } : {}), type: "response", command: record.type, ...fields,
    });
    if (record.protocol !== undefined && record.protocol !== PROTOCOL_VERSION) {
      reply({ success: false, error: `Unsupported pimux protocol: ${String(record.protocol)}` });
      return;
    }
    if (record.type === "pimux_stop") {
      if (record.expectedMuxId !== this.options.muxId || typeof record.operationId !== "string"
        || record.operationId.trim().length === 0 || record.operationId.length > 256) {
        reply({ success: false, error: "Stop requires the expected mux identity and a nonempty operationId (at most 256 characters)" });
        return;
      }
      if (!this.options.onStop) {
        reply({ success: false, error: "Runtime stop control is unavailable" });
        return;
      }
      if (this.stopping.has(client.id)) {
        reply({ success: false, error: "This client already has a stop request in progress; reconcile its operation receipt" });
        return;
      }
      this.stopping.add(client.id);
      const operationId = record.operationId;
      void Promise.resolve().then(() => this.options.onStop!(operationId)).then(
        (data) => { if (!this.finished) reply({ success: true, data }); },
        (error: unknown) => {
          if (!this.finished) reply({ success: false, error: error instanceof Error ? error.message : String(error) });
        },
      ).finally(() => this.stopping.delete(client.id));
      return;
    }
    if (record.type !== "pimux_bootstrap") {
      reply({ success: false, error: `Unknown pimux command: ${String(record.type)}` });
      return;
    }
    const include = parseIncludes(record.include);
    if (!include) {
      reply({ success: false, error: "include must be a non-empty array of \"entries\" and \"messages\"" });
      return;
    }
    client.include = include;
    reply({ success: true, data: { generation: this.bootstrap(client, "request") } });
  }

  /** Withholds live records from the client until the snapshot boundary of a new generation. */
  private bootstrap(client: Client, reason: SnapshotReason): number {
    for (const [previous, pending] of this.snapshots) {
      if (pending.clientId !== client.id) continue;
      clearTimeout(pending.timer);
      this.snapshots.delete(previous);
    }
    const generation = ++this.generation;
    this.readyClients.delete(client.id);
    client.muteGeneration = generation;
    this.snapshots.set(generation, { clientId: client.id, reason, timer: this.snapshotTimer(generation) });
    this.requestSnapshot(generation, client.include);
    return generation;
  }

  private snapshotTimer(generation: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => this.failSnapshot(generation, "Pi did not answer the snapshot request in time"),
      this.options.snapshotTimeoutMs ?? 30_000);
    timer.unref();
    return timer;
  }

  private requestSnapshot(generation: number, include: readonly string[]): void {
    try {
      this.options.writeToPi({ type: "prompt", id: `pimux:${generation}`, message: `/${SNAPSHOT_COMMAND} ${generation} ${include.join(",")}` });
    } catch (error) {
      this.failSnapshot(generation, error instanceof Error ? error.message : String(error));
    }
  }

  private recover(client: Client): void {
    const dropped = client.takeDropped();
    const generation = this.bootstrap(client, "gap");
    client.enqueueSnapshot(json({ type: "pimux_gap", generation, dropped }), generation);
  }

  private failSnapshot(generation: number, error: string): void {
    const pending = this.snapshots.get(generation);
    if (!pending) return;
    this.snapshots.delete(generation);
    clearTimeout(pending.timer);
    pending.reject?.(new Error(error));
    const client = pending.clientId === undefined ? undefined : this.clients.get(pending.clientId);
    if (!client || client.muteGeneration !== generation) return;
    client.muteGeneration = null;
    this.readyClients.delete(client.id);
    client.enqueue(json({ type: "pimux_snapshot_failed", generation, error }), "response");
  }

  private sendSnapshot(client: Client, generation: number, reason: SnapshotReason, data: SnapshotData): void {
    const replay = [...this.state.replay(), ...this.editorNotices];
    const { entries, messages, ...rest } = data;
    client.muteGeneration = null;
    client.enqueueSnapshot(json({
      type: "pimux_snapshot", generation, reason, ...rest, inputContext: this.state.inputContext,
      ...client.include.includes("entries") && entries !== undefined ? { entries } : {},
      ...client.include.includes("messages") && messages !== undefined ? { messages } : {},
      run: { active: this.state.runActive, compacting: this.state.compacting, tailTruncated: this.state.tailTruncated },
      replay: replay.length,
    }), generation);
    for (const record of replay) client.enqueueSnapshot(json(record), generation);
    client.enqueueSnapshot(json({ type: "pimux_live", generation }), generation, true);
    if (!data.historyError && this.state.inputContext && !client.closed) this.readyClients.add(client.id);
    else this.readyClients.delete(client.id);
  }

  private adopt(data: SnapshotData, replaceContext = false): void {
    if (data.historyError) this.state.inputContext = null;
    else if (replaceContext || !this.state.inputContext || this.state.inputContext.sessionFile !== data.session.file
      || this.state.session?.id !== data.session.id) {
      this.state.inputContext = { sessionFile: data.session.file, leafId: data.leafId, contextId: `${this.options.muxId}/${++this.nextContext}` };
    }
    this.state.session = data.session;
    this.state.model = data.model;
    this.state.thinkingLevel = data.thinkingLevel;
    this.options.onSnapshot?.(data);
  }

  private piResponse(record: JsonRecord, line: string): void {
    const id = record.id;
    if (typeof id === "string" && id.startsWith("pimux:")) {
      if (record.success === false) this.failSnapshot(Number(id.slice(6)), String(record.error ?? "snapshot request failed"));
      return;
    }
    const request = typeof id === "string" ? this.requests.get(id) : undefined;
    if (!request) {
      this.diagnostic(`Unroutable Pi response: ${line}`);
      return;
    }
    this.requests.delete(id as string);
    const out: JsonRecord = { ...record };
    if (request.hasId) out.id = request.originalId;
    else delete out.id;
    const data = out.data;
    if (out.command === "get_commands" && isRecord(data) && Array.isArray(data.commands)) {
      out.data = { ...data, commands: data.commands.filter((command) => !isRecord(command) || command.name !== SNAPSHOT_COMMAND) };
    }
    const client = request.clientId === null ? undefined : this.clients.get(request.clientId);
    if (client) this.respond(client, out);
    if (request.changesContext) {
      this.contextTransitions.delete(id as string);
      // Even a cancelled transition needs a fresh owning boundary before input.
      for (const peer of this.clients.values()) this.bootstrap(peer, "request");
    }
    if (request.bashId) {
      this.state.bashEnd(request.bashId);
      this.broadcast(json({
        type: "pimux_bash_end", bashId: request.bashId, success: record.success === true,
        ...record.success === true ? { result: record.data } : { error: record.error },
      }));
    }
  }

  private piBashUpdate(record: JsonRecord, line: string): void {
    const request = typeof record.id === "string" ? this.requests.get(record.id) : undefined;
    if (!request?.bashId) {
      this.broadcast(line);
      return;
    }
    const { id: _id, ...rest } = record;
    const shared = { ...rest, bashId: request.bashId };
    const sharedLine = json(shared);
    this.state.bashUpdate(request.bashId, shared, sharedLine.length);
    const ownLine = json(request.hasId ? { ...shared, id: request.originalId } : shared);
    for (const client of this.clients.values()) {
      if (client.muteGeneration === null) client.enqueue(client.id === request.clientId ? ownLine : sharedLine, "live");
    }
  }

  private piUi(record: JsonRecord, line: string): void {
    const method = record.method;
    if (method === "setStatus" && typeof record.statusKey === "string" && record.statusKey.startsWith(COMPANION_STATUS_PREFIX)) {
      if (record.statusKey === COMPANION_STATUS_KEY && typeof record.statusText === "string") {
        let companion: unknown;
        try { companion = JSON.parse(record.statusText); } catch { companion = undefined; }
        if (isRecord(companion)) this.companion(companion as unknown as CompanionRecord);
      }
      return;
    }
    if (typeof method === "string" && DIALOG_METHODS.has(method)) {
      const id = String(record.id);
      this.state.openDialog(record);
      for (const [dialogId, timer] of this.dialogTimers) {
        if (dialogId !== id && this.state.hasDialog(dialogId)) continue;
        clearTimeout(timer);
        this.dialogTimers.delete(dialogId);
      }
      if (typeof record.timeout === "number" && record.timeout > 0) {
        const timer = setTimeout(() => this.closeDialog(id, "timeout"), Math.min(record.timeout, 2_147_483_647));
        timer.unref();
        this.dialogTimers.set(id, timer);
      }
      this.broadcast(line);
      return;
    }
    if (method === "set_editor_text") {
      // Pi provides no causal request ID here. Even one pending prompt may
      // overlap a delayed callback from an earlier request; never guess a draft.
      const text = Buffer.from(typeof record.text === "string" ? record.text : "");
      const maximumTextBytes = 4 * 1024 * 1024 - 4096;
      let truncated = text.length > maximumTextBytes;
      let recoveryText = text.subarray(0, maximumTextBytes).toString("utf8");
      while (Buffer.byteLength(json(recoveryText)) > maximumTextBytes) {
        recoveryText = recoveryText.slice(0, Math.floor(recoveryText.length / 2));
        truncated = true;
      }
      const notice = { type: "pimux_editor_text", noticeId: ++this.nextEditorNotice,
        text: recoveryText, truncated,
        sessionFile: this.state.session?.file ?? null,
        reason: truncated ? "Ambiguous origin; recovery text is truncated to the private cache limit"
          : "Pi supplied no causal request identity; recover text explicitly" };
      this.editorNotices.push(notice);
      this.editorNoticeBytes += Buffer.byteLength(json(notice));
      while (this.editorNotices.length > 256 || this.editorNoticeBytes > 4 * 1024 * 1024) {
        this.editorNoticeBytes -= Buffer.byteLength(json(this.editorNotices.shift()));
      }
      for (const client of this.clients.values()) client.enqueue(json(notice), "response");
      if (truncated) this.diagnostic("Editor recovery text was truncated; Pi did not overwrite any draft");
      return;
    }
    this.state.observeUi(record, line.length);
    this.broadcast(line);
  }

  private closeDialog(id: string, reason: "answered" | "timeout" | "ended", clientId?: number): void {
    if (!this.state.closeDialog(id)) return;
    const timer = this.dialogTimers.get(id);
    if (timer) clearTimeout(timer);
    this.dialogTimers.delete(id);
    // A snapshot can be pending when Pi times a dialog out. Closure is an
    // out-of-band invalidation, retained even across replaced output sequences.
    const closed = json({ type: "pimux_dialog_closed", id, reason, ...clientId === undefined ? {} : { clientId } });
    for (const client of this.clients.values()) client.enqueue(closed, "response");
    this.notifyStatus();
  }

  private companion(record: CompanionRecord): void {
    switch (record.kind) {
      case "identity":
        if (this.state.session?.file !== record.session.file || this.state.session?.id !== record.session.id) {
          this.state.inputContext = null;
          this.readyClients.clear();
        }
        this.state.session = record.session;
        this.state.model = record.model;
        this.state.thinkingLevel = record.thinkingLevel;
        return;
      case "model":
        this.state.model = record.model;
        this.broadcast(json({ type: "pimux_model_changed", model: record.model, previousModel: record.previousModel, source: record.source }));
        return;
      case "prompts-ended":
        for (const id of this.state.dialogIds()) this.closeDialog(id, "ended");
        return;
      case "snapshot": {
        const pending = this.snapshots.get(record.generation);
        if (!pending) return;
        this.snapshots.delete(record.generation);
        clearTimeout(pending.timer);
        try {
          this.adopt(record.data);
          pending.resolve?.(record.data);
          const client = pending.clientId === undefined ? undefined : this.clients.get(pending.clientId);
          if (client?.muteGeneration === record.generation) this.sendSnapshot(client, record.generation, pending.reason, record.data);
        } catch (error) {
          pending.reject?.(error instanceof Error ? error : new Error(String(error)));
          const client = pending.clientId === undefined ? undefined : this.clients.get(pending.clientId);
          if (client?.muteGeneration === record.generation) {
            client.muteGeneration = null;
            this.readyClients.delete(client.id);
            this.respond(client, { type: "pimux_snapshot_failed", generation: record.generation,
              error: error instanceof Error ? error.message : String(error) });
          }
          this.diagnostic(`Snapshot safety initialization failed: ${String(error)}`);
        }
        return;
      }
      case "snapshot-failed":
        this.failSnapshot(record.generation, record.error);
        return;
      case "session": {
        for (const id of this.state.dialogIds()) this.closeDialog(id, "ended");
        this.state.resetRun();
        this.adopt(record.data, true);
        const generation = ++this.generation;
        const { session } = record.data;
        this.everyClient(json({
          type: "pimux_session_changed", generation, reason: record.reason, sessionFile: session.file,
          previousSessionFile: record.previousSessionFile, sessionId: session.id, sessionName: session.name, cwd: session.cwd,
        }), generation, "session_changed", record.data);
        return;
      }
      case "tree": {
        this.adopt(record.data, true);
        const generation = ++this.generation;
        this.everyClient(json({ type: "pimux_tree_changed", generation, leafId: record.newLeafId, oldLeafId: record.oldLeafId }),
          generation, "tree_changed", record.data);
        return;
      }
    }
  }

  /** A boundary for every client at once: the change record, then a snapshot of the new state. */
  private everyClient(change: string, generation: number, reason: SnapshotReason, data: SnapshotData): void {
    for (const client of this.clients.values()) {
      client.enqueueSnapshot(change, generation);
      this.sendSnapshot(client, generation, reason, data);
    }
  }
}
