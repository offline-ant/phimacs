// Live views: the agent this browser shows, open/close, socket reconciliation and snapshot sync.
// A view is Tau's attachment to one pimux agent; the server releases views no browser shows.

import { app, localAbortStates, settledWhileStopping, state, sharedDialogGenerations, DIALOG_METHODS, sharedDialogs, closedLiveSessionIds, piQueues, interactionStates, operationRevisions, sessionStateRevisions, queuedPrompts, compactRequests, compactionStarts, currentMessageSteps, type LiveSessionSnapshotData } from './app-state.js';
import { processQueuedExtensionUIRequest, suspendCurrentDialogForViewSwitch, reconcileInteractionState, showRunningCompaction } from './rpc-events.js';
import { assistantBlocks, toolCardRenderer, agentSidebar, sessionHistory, beginViewSelection, dialogHandler, clearResolvedDialog, flashStatusError, messageRenderer, modelPickerController, wsClient, treeViewController, cwdCompletion, modelCompletion, messagesContainer, sessionStatsCard, messageInput, sendBtn, closeSidebarOnMobile, showSidebarOnMobile } from './app-main.js';
import { showTypingIndicator, updateUI, updateContextPill, clearConversation, stopFollowing, renderSessionHistory, updateAgentTitle } from './session-view.js';
import type { LiveSession, AppEvent } from './app-types.js';
import { renderQueuedMessages, restoreUnsentInput, attachSharedAgent, focusComposer, keepUnsentInput, observeInputContext, inputContexts, bindComposerContext, flushQueue, inputContextOf, captureCommandTarget, unsentInput, activeViewCanNavigate } from './composer.js';
import type { OverviewAgent } from './agent-sidebar.js';
import { agentFromHash, agentHash } from './agent-link.js';

// ═══════════════════════════════════════
// WebSocket event handlers
// ═══════════════════════════════════════

/** Apply a view's authoritative snapshot. */
export function onLiveSessionSnapshot(e: Event) {
  const snapshot = (e as CustomEvent<LiveSessionSnapshotData>).detail;
  if (snapshot.sessionId && snapshot.session) {
    const previous = contextGenerations.get(snapshot.sessionId);
    if (snapshot.generation !== undefined && previous !== undefined && snapshot.generation <= previous) return;
    if (snapshot.generation !== undefined) contextGenerations.set(snapshot.sessionId, snapshot.generation);
    upsertLiveSession(snapshot.session);
  }
  if (snapshot.sessionId && Array.isArray(snapshot.dialogs)) reconcileSharedDialogs(snapshot.sessionId, snapshot.dialogs, snapshot.generation);
  if (!app.viewingActiveSession || snapshot.sessionId !== app.activeLiveSessionId) return;
  const rendered = appliedGenerations.get(snapshot.sessionId);
  if (typeof snapshot.generation === 'number' && rendered !== undefined && rendered >= snapshot.generation) return;
  applyLiveSessionSnapshot(snapshot);
  if (typeof snapshot.generation === 'number') appliedGenerations.set(snapshot.sessionId, snapshot.generation);
  processQueuedExtensionUIRequest(snapshot.sessionId);
}

/** Apply one view's metadata update. */
export function onLiveSessionUpdated(e: Event) {
  const detail = (e as CustomEvent<LiveSession>).detail;
  const previousAbortState = app.liveSessions.find(session => session.id === detail.id)?.abortState;
  upsertLiveSession(detail);
  restoreReconnectedView();
  // Native Abort acknowledgement can establish idle without agent_settled.
  // Never let an acknowledgement for an older operation stop a newer one:
  // the server's isStreaming metadata already accounts for that race.
  const acknowledgedStop = (previousAbortState && previousAbortState !== 'idle' && detail.abortState === 'idle') ||
    (!!detail.attached && localAbortStates.has(detail.id) && detail.isStreaming === false);
  if (acknowledgedStop) {
    localAbortStates.delete(detail.id);
    settledWhileStopping.delete(detail.id);
    if (detail.id === app.activeLiveSessionId && app.viewingActiveSession && detail.isStreaming === false) {
      state.setStreaming(false);
      assistantBlocks.setWorking(false);
      toolCardRenderer.settleNestedCalls();
      showTypingIndicator(false);
    }
  }
  if (app.viewingActiveSession && detail?.id === app.activeLiveSessionId) {
    applyActiveSessionMetadata(detail);
    updateUI();
  }
}

/** Apply the server's full live-session state after (re)connecting. */
export function onStateUpdate(e: Event) {
  const detail = (e as CustomEvent<{ liveSessions?: LiveSession[]; agents?: OverviewAgent[] }>).detail;
  const wasViewingLive = app.viewingActiveSession;
  const firstState = !app.hasReceivedInitialServerState;
  app.hasReceivedInitialServerState = true;
  // A restarted Tau has no views: the shared agents behind them may well run on.
  const remaining = new Set((detail.liveSessions || []).map(session => session.id));
  for (const session of app.liveSessions.filter(item => !remaining.has(item.id))) {
    if (app.viewingActiveSession && session.id === app.activeLiveSessionId && session.attached) app.reattachMuxId ??= session.attached.muxId;
  }
  setLiveSessions(detail.liveSessions || []);
  agentSidebar.update(detail.agents || []);
  if (!firstState) scheduleSidebarRefresh();
  if (restoreReconnectedView()) return;
  if (firstState && agentFromHash(location.hash)) {
    showAgentFromUrl();
  } else if (wasViewingLive && app.liveSessions.some(s => s.id === app.activeLiveSessionId)) {
    // Reconnected to the same server: its view survived; reread its state.
    void selectLiveSession(app.activeLiveSessionId!, app.resumeQueuedInput, beginViewSelection(false));
  } else {
    if (app.activeLiveSessionId && !app.liveSessions.some(s => s.id === app.activeLiveSessionId)) {
      app.voiceInput?.cancel();
      app.activeLiveSessionId = null;
      app.activeLiveSessionFile = null;
      renderQueuedMessages();
      renderAgentList();
    }
    // With nothing shown, the agent list is what a phone comes to see.
    if (firstState && !app.activeLiveSessionId) showSidebarOnMobile();
    updateLiveSessionInputState();
    restoreUnsentInput();
  }
  // Tau came back: the agent on screen when it stopped is the one to return to.
  if (!firstState && app.reattachMuxId) {
    const muxId = app.reattachMuxId;
    app.reattachMuxId = null;
    if (!app.liveSessions.some(session => session.id === app.activeLiveSessionId && session.attached?.muxId === muxId)) {
      // The overview can lag behind the runtime we already know.
      const selection = beginViewSelection(false);
      void attachSharedAgent(muxId, selection).then(opened => {
        if (selection !== app.viewSelection) return;
        if (opened) focusComposer();
        else showSidebarOnMobile();
      });
    }
  }
  reportView();
}

let reportedView: { sessionId: string | null; connection: number } | null = null;
/** Tells the server which view this socket shows, so it keeps that one attached and releases the rest. */
export function reportView() {
  if (wsClient.ws?.readyState !== WebSocket.OPEN) return;
  const sessionId = app.viewingActiveSession ? app.activeLiveSessionId : null;
  if (reportedView?.sessionId === sessionId && reportedView.connection === app.connectionRevision) return;
  reportedView = { sessionId, connection: app.connectionRevision };
  wsClient.send({ type: 'view', sessionId });
}

/** The mux id of the agent this browser shows, if any. */
export function currentMuxId(): string | null {
  if (!app.viewingActiveSession) return null;
  return app.liveSessions.find(session => session.id === app.activeLiveSessionId)?.attached?.muxId ?? null;
}

/** Keeps the shown agent in the URL without adding history entries. */
function showAgentInUrl(muxId: string | null) {
  const hash = agentHash(muxId);
  if (location.hash === hash || (!hash && !location.hash.startsWith('#agent='))) return;
  history.replaceState(history.state, '', location.pathname + location.search + hash);
}

/** The sidebar's status and current-agent highlight follow every view change. */
export function renderAgentList() {
  agentSidebar.render();
  updateAgentTitle();
}

/**
 * pimux generation of the last shared-view snapshot this view rendered. The
 * server publishes a snapshot and then its replayed in-flight work over the
 * WebSocket before it answers the HTTP snapshot request, so an HTTP answer
 * that is not newer would erase that replay.
 */
const appliedGenerations = new Map<string, number>();
const contextGenerations = new Map<string, number>();

/** A shared view's open dialogs at a pimux boundary replace those this browser holds for it. */
function reconcileSharedDialogs(sessionId: string, dialogs: AppEvent[], generation?: number) {
  if (!app.liveSessions.find(session => session.id === sessionId)?.attached) return;
  const previous = sharedDialogGenerations.get(sessionId);
  // An HTTP answer for a boundary already received over the socket cannot
  // reopen a dialog closed (or erase one opened) by the subsequent replay.
  if (generation !== undefined && previous !== undefined && generation <= previous) return;
  if (generation !== undefined) sharedDialogGenerations.set(sessionId, generation);
  const open = new Map(dialogs.filter(dialog => DIALOG_METHODS.has(String(dialog.method)) && typeof dialog.id === 'string')
    .map(dialog => [String(dialog.id), dialog]));
  sharedDialogs.set(sessionId, open);
  const current = dialogHandler.currentRequest;
  const restoreFocus = current?.sessionId === sessionId && !open.has(String(current.id)) ? clearResolvedDialog() : false;
  renderAgentList();
  processQueuedExtensionUIRequest();
  if (restoreFocus && app.viewingActiveSession && sessionId === app.activeLiveSessionId) focusComposer();
  // The snapshot caller applies metadata before updating input/dispatch. A
  // boundary that closes a dialog may simultaneously establish a busy run.
}

/** Another frontend answered it, or Pi stopped waiting: no browser may still offer it. */
export function closeSharedDialog(sessionId: string, id: string) {
  if (!app.liveSessions.find(session => session.id === sessionId)?.attached) return;
  sharedDialogs.get(sessionId)?.delete(id);
  const current = dialogHandler.currentRequest;
  let restoreFocus = false;
  if (current?.sessionId === sessionId && String(current.id) === id) {
    restoreFocus = clearResolvedDialog();
    processQueuedExtensionUIRequest();
  }
  renderAgentList();
  if (app.viewingActiveSession && app.activeLiveSessionId === sessionId) {
    updateUI();
    if (restoreFocus) focusComposer();
  }
}

/** A URL naming another agent (a /switch tau link, a bookmark, the back button) shows that agent. */
export function showAgentFromUrl() {
  const muxId = agentFromHash(location.hash);
  if (!muxId || muxId === currentMuxId()) return;
  void attachSharedAgent(muxId).then(opened => {
    if (opened) { closeSidebarOnMobile(); focusComposer(); }
    else showSidebarOnMobile();
  });
}

// ═══════════════════════════════════════
// Views
// ═══════════════════════════════════════

/** Start an agent in a directory: a group's `+` passes it directly, the New agent dialog through its form. */
export async function startAgent(cwd: string, model = '', selection = beginViewSelection()): Promise<boolean> {
  const res = await fetch('/api/live-sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd, model }),
  });
  const data = await res.json();
  if (!res.ok || data.error || !data.session) throw new Error(data.error || 'Failed to start the agent');
  rememberOpenedSession(data.session);
  if (selection !== app.viewSelection) return false;
  await selectLiveSession(data.session.id, true, selection);
  closeSidebarOnMobile();
  focusComposer();
  return true;
}

/** Start an agent from the New agent dialog. */
export async function submitNewLiveSession(e: SubmitEvent) {
  e.preventDefault();
  const cwd = newLiveSessionCwd.value.trim();
  if (!cwd) return;
  newLiveSessionSubmit.disabled = true;
  newLiveSessionSubmit.textContent = 'Starting…';
  const selection = beginViewSelection();
  try {
    if (await startAgent(cwd, newLiveSessionModel.value.trim(), selection)) {
      closeNewLiveSessionModal();
      newLiveSessionModel.value = '';
    }
  } catch (err) {
    if (selection === app.viewSelection) messageRenderer.renderError((err instanceof Error ? err.message : '') || 'Failed to start the agent');
  } finally {
    if (selection === app.viewSelection) {
      newLiveSessionSubmit.disabled = false;
      newLiveSessionSubmit.textContent = 'Start agent';
    }
  }
}

export const newLiveSessionOverlay = document.getElementById('new-live-session-overlay');
export const newLiveSessionModal = document.getElementById('new-live-session-modal');
export const newLiveSessionCwd = document.getElementById('new-live-session-cwd') as HTMLInputElement;
export const newLiveSessionModel = document.getElementById('new-live-session-model') as HTMLInputElement;
const newLiveSessionSubmit = document.getElementById('new-live-session-submit')!;

function setLiveSessions(sessions: LiveSession[]) {
  sessions = sessions.filter(session => !closedLiveSessionIds.has(session.id));
  ++app.liveSessionsRevision;
  const remaining = new Set(sessions.map(session => session.id));
  for (const removed of app.liveSessions.filter(session => !remaining.has(session.id))) keepUnsentInput(removed);
  for (const session of sessions) observeInputContext(session);
  app.liveSessions = sessions || [];
  renderAgentList();
}

/** No view is shown any more: the header must not keep describing the last one. */
function clearActiveSessionHeader() {
  modelPickerController.setModelState('', 'off');
  app.sessionTotalCost = 0;
  app.lastInputTokens = 0;
  app.lastUsage = null;
  updateContextPill();
}

export function handleLiveSessionClosed(closedId: string, message?: string, notice = false, reason?: string) {
  if (!closedId) return;
  closedLiveSessionIds.add(closedId);
  const session = app.liveSessions.find(session => session.id === closedId);
  if (session) keepUnsentInput(session);
  ++app.liveSessionsRevision;
  appliedGenerations.delete(closedId);
  contextGenerations.delete(closedId);
  inputContexts.delete(closedId);
  sharedDialogs.delete(closedId);
  sharedDialogGenerations.delete(closedId);
  piQueues.delete(closedId);
  app.liveSessions = app.liveSessions.filter(s => s.id !== closedId);
  app.messageQueue = app.messageQueue.filter(cmd => cmd.sessionId !== closedId);
  app.pendingExtensionUIRequests = app.pendingExtensionUIRequests.filter(req => req.sessionId !== closedId);
  interactionStates.delete(closedId);
  operationRevisions.delete(closedId);
  sessionStateRevisions.delete(closedId);
  localAbortStates.delete(closedId);
  settledWhileStopping.delete(closedId);
  queuedPrompts.delete(closedId);
  compactRequests.delete(closedId);
  compactionStarts.delete(closedId);
  if (dialogHandler.currentRequest?.sessionId === closedId) {
    dialogHandler.clearCurrentDialog();
    processQueuedExtensionUIRequest();
  }
  renderQueuedMessages();
  if (session && message && !notice && (app.activeLiveSessionId !== closedId || !app.viewingActiveSession)) {
    const diagnostic = `${viewTitle(session)}: ${message}`;
    flashStatusError(diagnostic, 8000);
    messageRenderer.renderError(diagnostic);
  }
  if (app.activeLiveSessionId === closedId) {
    if (reason !== 'reconnected') beginViewSelection(false);
    bindComposerContext(null);
    const wasViewingActive = app.viewingActiveSession;
    app.voiceInput?.cancel();
    app.activeLiveSessionId = null;
    app.activeLiveSessionFile = null;
    if (reason !== 'reconnected' && reason !== 'server_shutdown') showAgentInUrl(null);
    currentMessageSteps.clear();
    app.pendingAssistantError = null;
    app.retryStatusElement = null;
    state.reset();
    showTypingIndicator(false);
    if (wasViewingActive) {
      if (!message) clearConversation();
      if (message) {
        // A shared Pi exited or its connection was lost: say why, below the
        // conversation, which stays readable.
        app.viewingActiveSession = false;
        assistantBlocks.setWorking(false);
        if (notice) messageRenderer.renderNotice(message);
        else messageRenderer.renderError(message);
        clearActiveSessionHeader();
        updateLiveSessionInputState();
        updateUI();
      } else {
        app.viewingActiveSession = false;
        messageRenderer.renderWelcome();
        clearActiveSessionHeader();
        updateLiveSessionInputState();
        updateUI();
      }
    } else {
      updateLiveSessionInputState();
      updateUI();
    }
  }
  renderAgentList();
}

/** A peer can reconnect this mux without this browser issuing the request. */
export function restoreReconnectedView(): boolean {
  const session = app.reattachMuxId && app.liveSessions.find(session => session.attached?.muxId === app.reattachMuxId && (session.inputReady || session.readOnly));
  if (!session) return false;
  app.reattachMuxId = null;
  void selectLiveSession(session.id, app.resumeQueuedInput, app.viewSelection);
  return true;
}

export function upsertLiveSession(session: LiveSession) {
  if (!session || closedLiveSessionIds.has(session.id)) return;
  ++app.liveSessionsRevision;
  observeInputContext(session);
  sessionStateRevisions.set(session.id, (sessionStateRevisions.get(session.id) || 0) + 1);
  const idx = app.liveSessions.findIndex(s => s.id === session.id);
  if (idx >= 0) {
    const movedFile = app.liveSessions[idx].sessionFile !== session.sessionFile;
    const renamed = app.liveSessions[idx].sessionName !== (session.sessionName ?? app.liveSessions[idx].sessionName);
    app.liveSessions[idx] = { ...app.liveSessions[idx], ...session };
    if (movedFile) scheduleSidebarRefresh();
    if (renamed && session.id === app.activeLiveSessionId) updateUI();
  } else {
    app.liveSessions.push(session);
    renderAgentList();
  }
}

/** A late open can add a background view, but cannot roll back a view already known here. */
export function rememberOpenedSession(session: LiveSession) {
  // An open response can have been captured before a socket snapshot, even
  // when this is still the chosen view. Its metadata is only a fallback.
  if (!app.liveSessions.some(current => current.id === session.id)) upsertLiveSession(session);
}

function basename(p: string) {
  return (p || '').split(/[/\\]/).filter(Boolean).pop() || p || 'session';
}

/** The name the sidebar shows for this view's agent. */
export function viewTitle(session: LiveSession) {
  return session.sessionName || agentSidebar.find(session.attached?.muxId ?? null)?.name || session.attached?.name || basename(session.cwd || '');
}

/** History comes from disk: picks up sessions that appeared or moved, once a burst of changes settles. */
export function scheduleSidebarRefresh() {
  if (app.sidebarRefreshTimer !== null) clearTimeout(app.sidebarRefreshTimer);
  app.sidebarRefreshTimer = setTimeout(() => {
    app.sidebarRefreshTimer = null;
    // A reconnect refreshes it anyway.
    if (wsClient.ws?.readyState === WebSocket.OPEN) void sessionHistory.refresh();
  }, 400);
}

export async function selectLiveSession(id: string, resumeQueue = true, selection = beginViewSelection()): Promise<void> {
  if (selection !== app.viewSelection) return;
  app.voiceInput?.cancel();
  const session = app.liveSessions.find(s => s.id === id);
  if (!session) return;
  app.resumeQueuedInput = resumeQueue;
  suspendCurrentDialogForViewSwitch(id);
  treeViewController.closeIfOpen();
  stopFollowing();
  app.activeLiveSessionId = id;
  app.viewingActiveSession = true;
  showAgentInUrl(session.attached?.muxId ?? null);
  reportView();
  renderAgentList();
  renderQueuedMessages();
  applyActiveSessionMetadata(session);
  restoreUnsentInput();
  // Selection and its context become interactive together. A socket snapshot
  // may already be authoritative while the HTTP refresh is still in flight.
  updateLiveSessionInputState();
  currentMessageSteps.clear();
  app.pendingAssistantError = null;
  app.retryStatusElement = null;
  state.reset();
  state.setStreaming(!!session.isStreaming);
  clearConversation();
  renderCloseError(id);
  if (wsClient.ws?.readyState !== WebSocket.OPEN) {
    // Tau-local view IDs do not survive a server restart. Selecting one while
    // disconnected records the stable target, not an HTTP read of its old ID.
    app.reattachMuxId ??= session.attached?.muxId || null;
    keepUnsentInput(session);
    messageRenderer.renderNotice('Disconnected; waiting to restore the selected conversation.');
    updateLiveSessionInputState();
    updateUI();
    return;
  }
  const requestedAtConnection = app.connectionRevision;
  const requestedAtRevision = sessionStateRevisions.get(id) || 0;
  // A shared view's snapshot request makes the server publish a fresh pimux
  // boundary over the WebSocket; only a WebSocket snapshot rendered in this
  // view can make the HTTP answer redundant.
  appliedGenerations.delete(id);
  try {
    const res = await fetch(`/api/live-sessions/${encodeURIComponent(id)}/snapshot`);
    const data = await res.json();
    if (selection !== app.viewSelection || requestedAtConnection !== app.connectionRevision) return;
    if (res.ok && session.attached && data.session?.id !== id && data.session?.attached?.muxId === session.attached.muxId) {
      rememberOpenedSession(data.session);
      return selectLiveSession(data.session.id, resumeQueue, selection);
    }
    if (id !== app.activeLiveSessionId || !app.viewingActiveSession) return;
    if (!res.ok || data.error) {
      // A shared view whose snapshot failed is still attached; only a missing view is gone.
      if (res.status === 404) handleLiveSessionClosed(id);
      throw new Error(data.error || 'Live session not found');
    }
    const rendered = appliedGenerations.get(id);
    if (typeof data.generation !== 'number' || rendered === undefined || rendered < data.generation) {
      applyLiveSessionSnapshot({ ...data, sessionId: id }, requestedAtRevision);
      if (typeof data.generation === 'number') appliedGenerations.set(id, data.generation);
    }
  } catch (e) {
    if (selection !== app.viewSelection || requestedAtConnection !== app.connectionRevision || id !== app.activeLiveSessionId || !app.viewingActiveSession) return;
    messageRenderer.renderError((e instanceof Error ? e.message : '') || 'Failed to load live session snapshot');
    return;
  }
  updateLiveSessionInputState();
  processQueuedExtensionUIRequest(id);
  flushQueue();
}

function applyActiveSessionMetadata(session: LiveSession) {
  if (!session) return;
  observeInputContext(session);
  bindComposerContext(inputContextOf(session));
  app.activeLiveSessionFile = session.sessionFile || null;
  // Server is canonical: session.model is always null or a full {provider,id}
  // object, so assign directly. No modelLabel/modelSpec string fallbacks.
  modelPickerController.setModelState(session.model || '', session.thinkingLevel || 'off');
}

const closeRequests = new Set<string>();
const closedAgents = new Set<string>();
const closeErrors = new Map<string, string>();
/** As in pi-deck, a closing agent leaves the sidebar at once; a failed Close lists it again. */
export function agentHidden(muxId: string): boolean {
  return closeRequests.has(muxId) || closedAgents.has(muxId);
}
export function closePending(sessionId = app.activeLiveSessionId): boolean {
  const session = app.liveSessions.find(session => session.id === sessionId);
  return !!session && closeRequests.has(session.attached?.muxId || session.id);
}
function renderCloseError(sessionId: string) {
  const session = app.liveSessions.find(session => session.id === sessionId);
  const error = session && closeErrors.get(session.attached?.muxId || session.id);
  if (error) messageRenderer.renderError(error);
}
/** Close from the sidebar: through this browser's view when it has one, else by the agent's identity. */
export async function closeAgent(agent: OverviewAgent) {
  const view = app.liveSessions.find(session => session.attached?.muxId === agent.muxId);
  if (view) return closeLiveSession(view.id);
  if (agentHidden(agent.muxId)) return;
  closeRequests.add(agent.muxId);
  renderAgentList();
  try {
    if (agent.placement === 'panel') {
      const panelId = agent.muxId.slice('panel:'.length);
      const response = await fetch(`/api/panels/${encodeURIComponent(panelId)}/close`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: agent.name }), signal: AbortSignal.timeout(90000),
      }).catch(() => { throw new Error('Panel Close was not acknowledged; it was not retried.'); });
      const data = await response.json().catch(() => null);
      if (!response.ok || data?.state !== 'closed' || data.panelId !== panelId) {
        throw new Error(data?.error || 'Panel Close was not acknowledged; it was not retried.');
      }
      closedAgents.add(agent.muxId);
      return;
    }
    const response = await fetch(`/api/agents/${encodeURIComponent(agent.muxId)}/stop`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId: crypto.randomUUID() }),
    });
    const data = await response.json();
    if (!response.ok || data.error || data.receipt?.state !== 'stopped' || data.receipt.muxId !== agent.muxId) {
      throw new Error(data.error || 'Agent closure was not confirmed');
    }
    closedAgents.add(agent.muxId);
  } catch (error) {
    flashStatusError(`${agent.name}: ${error instanceof Error ? error.message : 'Agent closure was not confirmed'}`, 8000);
  } finally {
    closeRequests.delete(agent.muxId);
    renderAgentList();
  }
}

export async function closeLiveSession(id: string) {
  const session = app.liveSessions.find(s => s.id === id);
  if (!session || closePending(id)) return;
  const muxId = session.attached?.muxId;
  const agentId = muxId || session.id;
  closeRequests.add(agentId);
  updateUI();
  renderAgentList();
  try {
    const response = await fetch(`/api/live-sessions/${encodeURIComponent(id)}/stop`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId: crypto.randomUUID() }),
    });
    const data = await response.json();
    if (!response.ok || data.error || data.receipt?.state !== 'stopped' || !muxId || data.receipt.muxId !== muxId) {
      throw new Error(data.error || 'Agent closure was not confirmed');
    }
    closeErrors.delete(agentId);
    closedAgents.add(agentId);
    for (const current of app.liveSessions.filter(current => (current.attached?.muxId || current.id) === agentId)) handleLiveSessionClosed(current.id, data.message, data.notice);
  } catch (error) {
    if (app.liveSessions.some(current => (current.attached?.muxId || current.id) === agentId)) {
      const message = `${viewTitle(session)}: ${error instanceof Error ? error.message : 'Agent closure was not confirmed'}`;
      closeErrors.set(agentId, message);
      const selected = app.liveSessions.find(current => current.id === app.activeLiveSessionId && (current.attached?.muxId || current.id) === agentId);
      if (app.viewingActiveSession && selected) {
        flashStatusError(message, 8000);
        renderCloseError(selected.id);
      }
    }
  } finally {
    closeRequests.delete(agentId);
    updateLiveSessionInputState();
    renderAgentList();
  }
}

const queueClearRequests = new Map<string, Promise<boolean>>();
export function clearSharedQueue(sessionId = app.activeLiveSessionId, confirmed = false): Promise<boolean> {
  const session = app.liveSessions.find(s => s.id === sessionId);
  if (!session || !sessionId) return Promise.resolve(false);
  const existing = queueClearRequests.get(sessionId);
  if (existing) return existing;
  if (!confirmed && !confirm('Remove ALL queued steering and follow-up input from EVERY frontend of this agent? Only this browser receives the returned text for review. It is not resent, and images are not returned.')) return Promise.resolve(false);
  const target = captureCommandTarget(sessionId);
  if (!target) return Promise.resolve(false);
  const context = target.inputContext;
  const selection = app.viewSelection;
  const request = (async () => {
    try {
      const response = await fetch('/api/rpc', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'clear_queue', id: crypto.randomUUID(), ...target, confirmGlobal: true }),
      });
      const data = await response.json();
      if (!response.ok || data.success !== true) throw new Error(data.error || 'Queue clearing was not confirmed');
      const origin = context;
      const returned = [...(Array.isArray(data.data?.steering) ? data.data.steering : []),
        ...(Array.isArray(data.data?.followUp) ? data.data.followUp : [])].filter((text): text is string => typeof text === 'string');
      if (returned.length) unsentInput.keep(origin, { text: returned.join('\n\n'), images: [] });
      restoreUnsentInput();
      return true;
    } catch (error) {
      if (selection === app.viewSelection) flashStatusError(`${error instanceof Error ? error.message : 'Queue clearing was not confirmed'}. Queued input may still run; nothing was resent.`, 8000);
      return false;
    } finally {
      queueClearRequests.delete(sessionId);
    }
  })();
  queueClearRequests.set(sessionId, request);
  return request;
}

async function loadNewLiveSessionModels() {
  try {
    const res = await fetch('/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'get_available_models', sessionId: null }) });
    const data = await res.json();
    if (data.success && data.data?.models) app.newLiveSessionModels = data.data.models;
  } catch {}
}

export function openNewLiveSessionModal(cwd?: string) {
  newLiveSessionOverlay?.classList.remove('hidden');
  newLiveSessionModal?.classList.remove('hidden');
  newLiveSessionSubmit.disabled = false;
  newLiveSessionSubmit.textContent = 'Start agent';
  if (cwd) newLiveSessionCwd.value = cwd;
  else if (!newLiveSessionCwd.value) newLiveSessionCwd.value = app.liveSessions.find(s => s.id === app.activeLiveSessionId)?.cwd || '';
  loadNewLiveSessionModels();
  requestAnimationFrame(() => newLiveSessionCwd?.focus());
}

export function closeNewLiveSessionModal() {
  cwdCompletion.close();
  modelCompletion.close();
  newLiveSessionOverlay?.classList.add('hidden');
  newLiveSessionModal?.classList.add('hidden');
}

// ═══════════════════════════════════════
// Live-session snapshot sync
// ═══════════════════════════════════════

function applyLiveSessionSnapshot(data: LiveSessionSnapshotData, requestedAtRevision?: number) {
  console.log('[LiveSession] Received state snapshot:', data.entries?.length, 'entries');
  const sessionId = data.sessionId || app.activeLiveSessionId;
  if (!sessionId || !app.liveSessions.some(session => session.id === sessionId)) return;
  if (Array.isArray(data.dialogs)) reconcileSharedDialogs(sessionId, data.dialogs, data.generation);
  const interactionRevision = interactionStates.get(sessionId)?.interactionRevision;
  const staleInteractions = interactionRevision !== undefined && data.interactionRevision !== undefined && data.interactionRevision < interactionRevision;
  const staleMetadata = staleInteractions || (requestedAtRevision !== undefined && requestedAtRevision !== (sessionStateRevisions.get(sessionId) || 0));
  if (data.pendingDialogs && typeof data.interactionRevision === 'number') {
    reconcileInteractionState({ sessionId, pendingDialogs: data.pendingDialogs, interactionRevision: data.interactionRevision });
  }
  if (sessionId !== app.activeLiveSessionId) return;
  app.hasReceivedInitialServerState = true;

  // A snapshot's count, stop status and streaming flag are a single view of
  // the past. Do not let an HTTP response overwrite newer WebSocket state.
  app.viewingActiveSession = true;
  if (!staleMetadata) {
    if (data.session) upsertLiveSession(data.session);
    app.activeLiveSessionFile = data.sessionFile || data.session?.sessionFile || null;
    if (app.liveSessions.find(session => session.id === sessionId)?.attached && data.isStreaming === false) {
      localAbortStates.delete(sessionId);
    }
    state.setStreaming(!!data.isStreaming);
    showTypingIndicator(!!data.isStreaming);
  }
  updateLiveSessionInputState();
  updateUI();

  // Update model display — server is canonical, assign directly.
  if (!staleMetadata && data.model !== undefined) {
    if (data.model?.contextWindow) {
      app.contextWindowSize = Number(data.model.contextWindow) || 0;
    }
    modelPickerController.setModelState(data.model || '', data.thinkingLevel || 'off');
  } else if (!staleMetadata && data.thinkingLevel) {
    modelPickerController.setThinkingLevel(data.thinkingLevel || 'off');
  }

  // A snapshot replaces live DOM, including any deltas received in flight.
  clearConversation();
  app.retryStatusElement = null;
  app.sessionTotalCost = 0;
  app.lastInputTokens = 0;
  app.contextTokensEstimated = false;
  app.lastUsage = null;

  if (data.entries && data.entries.length > 0) {
    renderSessionHistory(data.entries);
  } else {
    messageRenderer.renderWelcome();
  }
  // A compaction still running when the view is opened or reloaded. The view's
  // metadata already holds the newest of the snapshot and live events.
  const runningCompaction = app.liveSessions.find(session => session.id === sessionId)?.compaction;
  if (runningCompaction) showRunningCompaction(runningCompaction.reason, runningCompaction.startedAt);
  assistantBlocks.setWorking(state.isStreaming);
  if (state.isStreaming) messagesContainer.lastElementChild?.classList.remove('history');

  updateContextPill();
  // A snapshot means the session's entries/leaf may have moved (e.g. another
  // client ran navigate_tree) — refresh an open tree modal so it is not stale.
  treeViewController.notifyTreeChanged(data.sessionId || app.activeLiveSessionId);
  renderCloseError(sessionId);
  // A live session just loaded — fetch its authoritative stats from pi.
  void sessionStatsCard.refresh();
  processQueuedExtensionUIRequest();
}

// Refresh live-session list for sidebar indicators if WS missed an update
export async function pollInstances() {
  const requestedAtConnection = app.connectionRevision;
  const requestedAtRevision = app.liveSessionsRevision;
  try {
    const res = await fetch('/api/live-sessions');
    if (res.ok) {
      const data = await res.json();
      // Protect membership as well as row metadata: an old empty list must
      // neither delete a newly attached view nor resurrect a closed one.
      if (requestedAtConnection !== app.connectionRevision || requestedAtRevision !== app.liveSessionsRevision) return;
      const wasActive = app.activeLiveSessionId;
      const selectedMux = app.liveSessions.find(session => session.id === wasActive)?.attached?.muxId;
      setLiveSessions(data.sessions || []);
      const activeSession = wasActive ? app.liveSessions.find(s => s.id === wasActive) : null;
      if (wasActive && !activeSession) {
        const replacing = !!selectedMux && app.liveSessions.some(session => session.attached?.muxId === selectedMux);
        if (replacing) app.reattachMuxId ??= selectedMux;
        handleLiveSessionClosed(wasActive, undefined, false, replacing ? 'reconnected' : undefined);
        if (replacing) restoreReconnectedView();
      } else if (activeSession && app.viewingActiveSession) {
        state.setStreaming(!!activeSession.isStreaming);
        showTypingIndicator(!!activeSession.isStreaming);
        applyActiveSessionMetadata(activeSession);
        updateLiveSessionInputState();
        updateUI();
      }
    }
  } catch {}
}

// Enable/disable input based on whether this browser shows a ready agent view
export function updateLiveSessionInputState() {
  const inputArea = document.querySelector('.input-area');
  const hasLiveSession = app.viewingActiveSession && !!app.activeLiveSessionId;
  const inputReady = hasLiveSession && captureCommandTarget() !== null;
  const closing = closePending();
  if (inputReady && !closing) {
    messageInput.disabled = false;
    sendBtn.disabled = false;
    messageInput.placeholder = 'Message...';
    inputArea?.classList.remove('no-active-live-session');
  } else {
    messageInput.disabled = true;
    sendBtn.disabled = true;
    const readOnly = hasLiveSession && app.liveSessions.find(session => session.id === app.activeLiveSessionId)?.readOnly;
    messageInput.placeholder = closing ? 'Closing agent…' : readOnly ? 'Read-only: this agent has no input context' : hasLiveSession ? 'Waiting for the conversation to become ready…'
      : app.hasReceivedInitialServerState ? 'Select or start an agent to chat' : 'Connecting...';
    inputArea?.classList.toggle('no-active-live-session', !hasLiveSession);
  }
  document.getElementById('command-btn')!.disabled = !hasLiveSession;
  modelPickerController.setEnabled(inputReady && !closing);
  treeViewController.setVisible(inputReady && !closing && activeViewCanNavigate());
  reportView();
}
