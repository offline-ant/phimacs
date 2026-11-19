import path from 'node:path';
import { WebSocket } from 'ws';
import { startRuntime, stopRuntime, resolveRuntime, lookupTerminalReceipt, type RuntimeReceipt, type StartRuntimeOptions, type TerminalReceipt } from '@phimacs/pimux/runtime';
import { canonicalSessionPath } from '@phimacs/pimux/ownership';
import { muxDirectory } from '@phimacs/pimux/discovery';
import fs from 'node:fs';
import type { JsonRecord, LiveClient, SessionSpawnOverrides } from './types.js';
import { expandHome } from './config.js';
import { PiRpcSession, SessionOpenError } from './sessions.js';
import { reconcileRuntimeExit, requireSessionFile } from './runtime-recovery.js';
import { workerExitReport } from './runtime-exit.js';
import { pimuxEntryById, pimuxSharing, probePimux, type PimuxEntry, type PimuxSharing } from './pimux.js';
import { observeWorkerExit } from './close-worker.js';

/** Session-opening `pi` flags: the file must come from `sessionFile`, so attach-or-spawn resolution sees it. */
const SESSION_OPENING_ARGS = new Set(['--session', '--session-id', '--fork', '--continue', '-c', '--resume', '-r']);
export function assertNoSessionArgs(args: string[] | undefined) {
  for (const arg of args ?? []) {
    const flag = arg.startsWith('--') ? arg.split('=')[0] : arg;
    if (SESSION_OPENING_ARGS.has(flag)) throw new Error(`args must not open a session (${flag}); pass sessionFile instead`);
  }
}

const MAX_CLIENT_BACKLOG_BYTES = 64 * 1024 * 1024;
const PIMUX_RETRY_MS = 50;

export class LiveSessionManager {
  sessions: Map<string, PiRpcSession>;
  clients: Set<LiveClient>;
  pendingResumes: Map<string, Promise<{ session: PiRpcSession; refreshed: boolean }>>;
  terminatingResumes: Map<string, Promise<void>>;
  private startingSessions = new Set<PiRpcSession>();
  private pendingAttaches = new Map<string, Promise<PiRpcSession>>();
  private recoveringRoots = new Map<string, Promise<PiRpcSession>>();
  /** Called whenever an attached view opens or closes, so the agent overview can show it. */
  onAttachmentsChanged: () => void = () => {};
  /** Called whenever the set of agents some browser views changes. */
  onViewsChanged: () => void = () => {};
  /** How long an attached view nobody shows stays connected before it is released. */
  releaseDelayMs = 30000;
  /** The live session each browser socket shows; a socket absent here shows nothing. */
  private views = new Map<LiveClient, string>();
  private releaseTimers = new Map<string, ReturnType<typeof setTimeout>>();
  maxClientBacklogBytes = MAX_CLIENT_BACKLOG_BYTES;
  /** How long opening a shared session waits for a pimux still starting. */
  pimuxStartWaitMs = 5000;

  readonly runtime: { start: (options: StartRuntimeOptions) => Promise<RuntimeReceipt>; stop: typeof stopRuntime; resolve: typeof resolveRuntime };
  constructor(runtime: { start?: (options: StartRuntimeOptions) => Promise<RuntimeReceipt>; stop?: typeof stopRuntime; resolve?: typeof resolveRuntime } = {}) {
    this.runtime = { start: runtime.start ?? startRuntime, stop: runtime.stop ?? stopRuntime, resolve: runtime.resolve ?? resolveRuntime };
    this.sessions = new Map();
    this.clients = new Set();
    this.pendingResumes = new Map();
    this.terminatingResumes = new Map();
  }
  addClient(ws: LiveClient) { this.clients.add(ws); }
  removeClient(ws: LiveClient) {
    this.clients.delete(ws);
    this.view(ws, null);
  }
  /** A browser declares which live session it shows; unknown ids show nothing. */
  view(client: LiveClient, sessionId: string | null) {
    const next = sessionId && this.sessions.has(sessionId) ? sessionId : null;
    const previous = this.views.get(client) ?? null;
    if (previous === next) return;
    if (next) this.views.set(client, next);
    else this.views.delete(client);
    if (previous) this.awaitViewer(previous);
    if (next) this.cancelRelease(next);
    this.onViewsChanged();
  }
  viewerCount(sessionId: string) {
    let count = 0;
    for (const viewed of this.views.values()) if (viewed === sessionId) count++;
    return count;
  }
  /** Mux ids of the agents some browser shows. */
  viewedMuxIds() {
    const ids = new Set<string>();
    for (const id of this.views.values()) {
      const muxId = this.sessions.get(id)?.attachment?.muxId;
      if (muxId) ids.add(muxId);
    }
    return ids;
  }
  /** An attached view nobody shows is released after `releaseDelayMs`; a view cancels that. */
  awaitViewer(sessionId: string) {
    this.cancelRelease(sessionId);
    const session = this.sessions.get(sessionId);
    if (!session?.attachment || this.viewerCount(sessionId)) return;
    const timer = setTimeout(() => {
      this.releaseTimers.delete(sessionId);
      const current = this.sessions.get(sessionId);
      if (current !== session || this.viewerCount(sessionId)) return;
      this.disconnect(session, 'released').catch(() => {});
    }, this.releaseDelayMs);
    timer.unref?.();
    this.releaseTimers.set(sessionId, timer);
  }
  private cancelRelease(sessionId: string) {
    const timer = this.releaseTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.releaseTimers.delete(sessionId);
  }
  /**
   * Disconnect one view without stopping its agent. A worker's view stays until
   * its parent task's cleanup is observed, so its report arrives; only a
   * release of a still-running worker's unshown view detaches it outright.
   */
  async disconnect(session: PiRpcSession, reason = 'closed_by_user') {
    if (session.attachedOwner?.placement === 'worker' && (session.exited || reason !== 'released')) {
      await (session.transport?.close() ?? Promise.resolve());
      observeWorkerExit(session);
      return;
    }
    await this.delete(session.id, reason);
  }
  /** Stalled browsers reconnect through a snapshot instead of unbounded buffering. */
  sendTo(client: LiveClient, payload: string) {
    if (client.readyState !== WebSocket.OPEN) return;
    if (client.bufferedAmount > this.maxClientBacklogBytes) {
      client.terminate();
      this.removeClient(client);
      return;
    }
    client.send(payload);
  }
  broadcast(data: unknown) {
    const payload = JSON.stringify(data);
    for (const client of this.clients) this.sendTo(client, payload);
  }
  broadcastUpdated(id: string) {
    const s = this.sessions.get(id);
    if (s) this.broadcast({ type: 'live_session_updated', session: s.metadata() });
  }
  list() { return Array.from(this.sessions.values()).map((s) => s.metadata()); }
  get(id: string) { return this.sessions.get(id); }
  findBySessionFile(sessionFile: string) {
    const resolved = path.resolve(sessionFile);
    return Array.from(this.sessions.values()).find((session) => session.referencesSessionFile(resolved));
  }
  findByMuxId(muxId: string) {
    return Array.from(this.sessions.values()).find((session) => session.attachment?.muxId === muxId && !session.terminating && !session.exited);
  }
  hasStartingSession(sessionFile: string) {
    const resolved = path.resolve(sessionFile);
    return Array.from(this.startingSessions).some((session) => session.sessionFile && path.resolve(session.sessionFile) === resolved);
  }
  hasPendingResume(sessionFile: string) { return this.pendingResumes.has(canonicalSessionPath(sessionFile)); }
  hasTerminatingResume(sessionFile: string) { return this.terminatingResumes.has(path.resolve(sessionFile)); }
  /** Create and resume share resolution; neither may open a second writer. */
  async create({ cwd, model, sessionFile, args, env }: { cwd?: string; model?: string; sessionFile?: string } & SessionSpawnOverrides) {
    assertNoSessionArgs(args);
    const resolved = path.resolve(expandHome(cwd || process.cwd()));
    if (sessionFile) {
      const { session } = await this.resume({ sessionFile: path.resolve(expandHome(sessionFile)), cwd: resolved, model, args, env });
      return session;
    }
    const session = new PiRpcSession(this, { cwd: resolved, modelSpec: (model || '').trim(), args, env });
    return this.startSession(session);
  }
  private async startSession(session: PiRpcSession) {
    // A create can open an existing file too; it is not in pendingResumes.
    // Keep it visible to pre-spawn rollback checks until readiness/cleanup ends.
    this.startingSessions.add(session);
    try {
      await session.start();
      if (session.exited) throw new SessionOpenError('Runtime connection ended during startup; reconcile its identity before retrying', 503, session.attachment?.muxId);
    } finally {
      this.startingSessions.delete(session);
    }
    const existing = session.attachment ? this.findByMuxId(session.attachment.muxId) : undefined;
    if (existing) { await session.terminate('duplicate_view'); return existing; }
    this.sessions.set(session.id, session);
    this.broadcast({ type: 'live_session_created', session: session.metadata() });
    this.onAttachmentsChanged();
    this.awaitViewer(session.id);
    return session;
  }
  /** Attaches a tab to a pimux-shared Pi, or returns the tab already attached to it. */
  async attach(entry: PimuxEntry, expectedSessionFile?: string): Promise<{ session: PiRpcSession; started: boolean }> {
    const existing = this.findByMuxId(entry.muxId);
    if (existing) return { session: requireSessionFile(existing, expectedSessionFile), started: false };
    const pending = this.pendingAttaches.get(entry.muxId);
    if (pending) return { session: requireSessionFile(await pending, expectedSessionFile), started: false };
    const attaching = (async () => {
      const session = new PiRpcSession(this, { cwd: entry.cwd, sessionFile: expectedSessionFile ?? entry.session?.file ?? null, sessionName: entry.session?.name ?? null, pimux: entry });
      await session.start(expectedSessionFile);
      const duplicate = this.findByMuxId(entry.muxId);
      if (duplicate) { await session.terminate('duplicate_view'); return requireSessionFile(duplicate, expectedSessionFile); }
      for (const old of this.sessions.values()) if (old.exited && old.attachment?.muxId === entry.muxId) this.removeExited(old.id, 'reconnected');
      this.sessions.set(session.id, session);
      this.broadcast({ type: 'live_session_created', session: session.metadata() });
      this.onAttachmentsChanged();
      this.awaitViewer(session.id);
      return session;
    })().finally(() => this.pendingAttaches.delete(entry.muxId));
    this.pendingAttaches.set(entry.muxId, attaching);
    return { session: await attaching, started: true };
  }
  /** Join one read-only service recovery; never submit input or start a writer. */
  recoverRoot(view: PiRpcSession, expectedSessionFile?: string): Promise<PiRpcSession> {
    const pending = this.recoveringRoots.get(view.id);
    if (pending) return pending.then(session => requireSessionFile(session, expectedSessionFile));
    const attachment = view.attachment!;
    const env = { ...process.env, PIMUX_DIR: path.dirname(attachment.socket) };
    const operation = Promise.resolve().then(async () => {
      const terminal = lookupTerminalReceipt(attachment.muxId, env);
      if (terminal?.rootClosed === true && reconcileRuntimeExit(this, attachment.muxId)) throw new SessionOpenError('This agent was closed', 410, attachment.muxId);
      const receipt = await this.runtime.resolve(attachment.muxId, env);
      if (this.get(view.id) !== view || view.terminating) throw new SessionOpenError('View disconnected during recovery', 503, attachment.muxId);
      if (!receipt) {
        if (reconcileRuntimeExit(this, attachment.muxId)) throw new SessionOpenError('This agent was closed', 410, attachment.muxId);
        throw new SessionOpenError('No service successor or terminal evidence; view retained', 503, attachment.muxId);
      }
      const entry = pimuxEntryById(receipt.muxId, path.dirname(receipt.socket));
      if (!entry || entry.piPid !== receipt.piPid || entry.socket !== receipt.socket) throw new SessionOpenError('Service successor discovery is unavailable', 503, receipt.muxId);
      await view.reconnect(entry, expectedSessionFile);
      this.broadcastUpdated(view.id);
      this.onAttachmentsChanged();
      return view;
    }).finally(() => this.recoveringRoots.delete(view.id));
    this.recoveringRoots.set(view.id, operation);
    return operation;
  }

  /** Reconnect this identity or its recorded successor; never relaunch a missing agent. */
  async attachById(muxId: string, expectedSessionFile?: string) {
    const existing = this.findByMuxId(muxId);
    if (existing) return { session: requireSessionFile(existing, expectedSessionFile), started: false };
    const view = [...this.sessions.values()].find(view => view.attachment?.muxId === muxId);
    if (view?.serviceRoot && !view.terminating) return { session: await this.recoverRoot(view, expectedSessionFile), started: false };
    const socket = view?.attachment?.socket;
    const directory = socket ? path.dirname(socket) : muxDirectory();
    const current = pimuxEntryById(muxId, directory);
    const terminal = lookupTerminalReceipt(muxId, { ...process.env, PIMUX_DIR: directory });
    if (view?.attachedOwner?.placement !== 'worker' && terminal?.placement !== 'worker'
      && terminal?.rootClosed !== true
      && (current?.service || terminal?.service || fs.existsSync(path.join(directory, 'service.sock')))) {
      const receipt = await this.runtime.resolve(muxId, { ...process.env, PIMUX_DIR: directory });
      if (receipt) {
        const successor = pimuxEntryById(receipt.muxId, path.dirname(receipt.socket));
        if (!successor || successor.piPid !== receipt.piPid || successor.socket !== receipt.socket) throw new SessionOpenError('Service successor discovery is unavailable', 503, receipt.muxId);
        return this.attach(successor, expectedSessionFile);
      }
    }
    if (reconcileRuntimeExit(this, muxId)) throw new SessionOpenError('This agent was closed', 410, muxId);
    const entry = await this.whenReachable(async () => {
      const found = pimuxEntryById(muxId, socket ? path.dirname(socket) : undefined);
      if (!found) return null;
      const reachability = await probePimux(found);
      return reachability === 'stale' ? null : { entry: found, reachability };
    }, 'The shared Pi session does not accept connections yet; try again in a moment');
    if (!entry) {
      if (reconcileRuntimeExit(this, muxId)) throw new SessionOpenError('This agent was closed', 410, muxId);
      throw new SessionOpenError('Runtime is unavailable; its termination was not acknowledged', 503, muxId);
    }
    return this.attach(entry, expectedSessionFile);
  }
  /** Unreachable live or uncertain owners still exclude another writer. */
  private pimuxFor(file: string): Promise<PimuxEntry | null> {
    return this.whenReachable(() => pimuxSharing(file), 'This session is shared by another frontend that does not accept connections right now; it was not opened here.');
  }
  /** Follows `look` while its pimux is starting, so a tab opened at that moment attaches instead of failing. */
  private async whenReachable(look: () => Promise<PimuxSharing | null>, refusal: string): Promise<PimuxEntry | null> {
    const deadline = Date.now() + this.pimuxStartWaitMs;
    for (;;) {
      const sharing = await look();
      if (!sharing) return null;
      if (sharing.reachability === 'reachable') return sharing.entry;
      if (sharing.entry.status !== 'starting' || Date.now() >= deadline) throw new SessionOpenError(refusal, 409, sharing.entry.muxId);
      await new Promise((resolve) => setTimeout(resolve, PIMUX_RETRY_MS));
    }
  }
  async resume(options: { sessionFile: string; cwd: string; model?: string; entries?: JsonRecord[]; sessionName?: string | null; refresh?: boolean } & SessionSpawnOverrides): Promise<{ session: PiRpcSession; started: boolean; refreshed: boolean }> {
    const { sessionFile, cwd, model, entries, sessionName, args, env, refresh } = options;
    assertNoSessionArgs(args);
    const resolved = canonicalSessionPath(sessionFile);
    const pending = this.pendingResumes.get(resolved);
    if (pending) {
      const result = await pending;
      if (refresh && !result.refreshed) return this.resume(options);
      return { ...result, session: requireSessionFile(result.session, resolved), started: false };
    }
    let started = false;
    // Concurrent callers join the same startup before it can settle.
    const resumePromise = Promise.resolve().then(async () => {
      try {
        const terminating = this.terminatingResumes.get(resolved);
        if (terminating) await terminating;
        const existing = this.findBySessionFile(resolved);
        if (existing) {
          if (existing.exited && existing.attachment) return { session: (await this.attachById(existing.attachment.muxId, resolved)).session, refreshed: false };
          if (existing.terminating) throw new SessionOpenError('Previous view is disconnecting; wait for that operation to settle', 503, existing.attachment?.muxId);
          if (refresh) await existing.refresh(resolved);
          return { session: existing, refreshed: !!refresh };
        }
        const shared = await this.pimuxFor(resolved);
        if (shared) {
          const attached = await this.attach(shared, resolved);
          if (refresh) await attached.session.refresh(resolved);
          return { session: attached.session, refreshed: !!refresh };
        }
        const session = new PiRpcSession(this, { cwd, modelSpec: (model || '').trim(), sessionFile: resolved, entries, sessionName, args, env });
        const readySession = await this.startSession(session);
        started = readySession.startOutcome === 'started';
        return { session: requireSessionFile(readySession, resolved), refreshed: false };
      } finally {
        this.pendingResumes.delete(resolved);
      }
    });
    this.pendingResumes.set(resolved, resumePromise);
    return { ...await resumePromise, started };
  }
  async delete(id: string, reason = 'closed_by_user', receipt?: TerminalReceipt) {
    const session = this.sessions.get(id);
    if (!session) return false;
    const resolvedFile = session.sessionFile && !session.attachment ? path.resolve(session.sessionFile) : null;
    if (receipt) session.terminalReceipt = receipt;
    const termination = session.terminate(reason).then(() => {
      this.removeExited(id, session.attachment ? session.detachReason : reason, undefined, false, receipt);
    }).finally(() => {
      if (resolvedFile && this.terminatingResumes.get(resolvedFile) === termination) this.terminatingResumes.delete(resolvedFile);
    });
    if (resolvedFile) this.terminatingResumes.set(resolvedFile, termination);
    await termination;
    return true;
  }
  /** `notice` marks `message` as news rather than a failure. */
  removeExited(id: string, reason: string, message?: string, notice = false, receipt?: TerminalReceipt) {
    const session = this.sessions.get(id);
    if (!session) return;
    const report = reason !== 'reconnected' && session.attachedOwner?.placement === 'worker' ? workerExitReport(session.attachment?.exit ?? receipt ?? session.terminalReceipt) : undefined;
    if (report) { message = report.message; notice = report.notice; }
    this.sessions.delete(id);
    this.cancelRelease(id);
    let viewed = false;
    for (const [client, viewedId] of this.views) if (viewedId === id) { this.views.delete(client); viewed = true; }
    if (viewed) this.onViewsChanged();
    this.broadcast({ type: 'live_session_closed', sessionId: id, reason, ...(message ? { message, notice } : {}) });
    if (session.attachment) this.onAttachmentsChanged();
  }
  async shutdown() {
    const results = await Promise.allSettled(Array.from(this.sessions.keys(), (id) => this.delete(id, 'server_shutdown')));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), `${failures.length} view disconnect(s) unconfirmed`);
  }
}

export const liveManager = new LiveSessionManager();
