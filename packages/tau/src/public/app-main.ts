/**
 * Main App - wires the shell: services, DOM listeners and socket events.
 */

import { WebSocketClient } from './websocket-client.js';
import { MessageRenderer } from './message-renderer.js';
import { ToolCardRenderer } from './tool-card.js';
import { commandContextIsCurrent, captureCommandTarget, focusComposer, reconcileAcceptedPrompt, unsentInput, settlePrompt, sendMessage, addAttachments, recoveredInputEl, abortActiveSession, activeViewCanStartOver, newSharedSession, activeViewCanNavigate, activeViewIsShared, requestCompaction, rpcExportHtml, attachSharedAgent, rpcCommand, escapeHtml, restoreUnsentInput, sessionHasPendingWork } from './composer.js';
import { app, state, queuedPrompts } from './app-state.js';
import { DialogHandler } from './dialogs.js';
import type { RpcCommand, LiveSession, InteractionState } from './app-types.js';
import { copyInputContext, type InputContext } from './unsent-input.js';
import { AssistantBlocks } from './assistant-blocks.js';
import { openNewLiveSessionModal, updateLiveSessionInputState, onStateUpdate, upsertLiveSession, restoreReconnectedView, scheduleSidebarRefresh, onLiveSessionUpdated, handleLiveSessionClosed, onLiveSessionSnapshot, showAgentFromUrl, newLiveSessionCwd, newLiveSessionModel, closeNewLiveSessionModal, newLiveSessionOverlay, submitNewLiveSession, clearSharedQueue, closeLiveSession, newLiveSessionModal, pollInstances, startAgent, closeAgent, agentHidden, currentMuxId } from './live-views.js';
import { SessionHistory, type SidebarSession } from './session-history.js';
import { currentStatusText, updateUI, stopFollowing, updateConnectionStatus, fetchContextWindow, setAssistantBlocksExpanded, updateContextPill, switchSession, supportsScrollAnchoring } from './session-view.js';
import { processQueuedExtensionUIRequest, onRpcEvent, reconcileInteractionState } from './rpc-events.js';
import { setupAgentSidebar, type OverviewAgent } from './agent-sidebar.js';
import { setupHeaderMenu } from './header-menu.js';
import { attachCompletionList } from './completion-list.js';
import { searchModels, normalizeModelList, modelMeta, modelRef } from './model-match.js';
import { isImeComposition } from './keyboard.js';
import { setupCommandPalette } from './command-palette.js';
import { setupModelPicker } from './model-picker.js';
import { setupTreeView } from './tree-view.js';
import { settingsPanel, closeSettings, openSettings, settingsOverlay, toggleAutoCompact, toggleAuth } from './settings-panel.js';
import { applyTheme, getCurrentTheme } from './themes.js';
import { setupSessionStatsCard, type SessionStats } from './session-stats-card.js';
import { setupVoiceInput } from './voice-input.js';

// Initialize components
const wsUrl = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws';
export const wsClient = new WebSocketClient(wsUrl);
// All element lookups below query the app's static index.html shell, which is
// present before this module runs (the script is a deferred module at the end
// of <body>). A missing element means the page is structurally broken, so we
// assert non-null at the query site rather than guarding every usage.
export const messageRenderer = new MessageRenderer(document.getElementById('messages')!);
export const toolCardRenderer = new ToolCardRenderer(document.getElementById('messages')!, true);
export const dialogHandler = new DialogHandler(document.getElementById('dialog-container')!, {
  async send(command) {
    const captured = command as RpcCommand;
    if (!captured.sessionId || !captured.inputContext || !commandContextIsCurrent(captured.sessionId, captured.inputContext as InputContext)) {
      throw new Error('The dialog conversation is no longer ready. Refresh it before answering.');
    }
    const response = await fetch('/api/rpc', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command),
    });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.error || 'Could not send response. Please retry.');
  },
}, () => app.activeLiveSessionId);
let focusedDialog: HTMLElement | null = null;
document.addEventListener('focusin', event => {
  const target = event.target;
  // Disabling the chosen answer can release focus to the body before the mux
  // confirms closure. A later focused control, unlike that neutral blur, owns it.
  if (!(target instanceof Element) || target === document.body || target === document.documentElement) return;
  const dialog = dialogHandler.currentDialog;
  focusedDialog = dialog?.contains(target) ? dialog : null;
});

export function clearResolvedDialog() {
  const dialog = dialogHandler.currentDialog;
  const ownedFocus = !!dialog && (dialog.contains(document.activeElement) || focusedDialog === dialog);
  dialogHandler.clearCurrentDialog();
  focusedDialog = null;
  return ownedFocus;
}

export const assistantBlocks = new AssistantBlocks(document.getElementById('messages')!);
export const assistantBlockControllers = new Set([assistantBlocks]);

// Sidebar: live agents, then saved-session History
export const sessionHistory = new SessionHistory(document.getElementById('history')!, session => { void handleSessionSelect(session); });
export const agentSidebar = setupAgentSidebar({
  summary: document.getElementById('agents-summary')!,
  list: document.getElementById('agent-list')!,
  open: openAgent,
  newAgent(cwd) {
    const selection = beginViewSelection();
    startAgent(cwd, '', selection).catch(error => {
      if (selection === app.viewSelection) flashStatusError(error instanceof Error ? error.message : 'Failed to start the agent', 8000);
    });
  },
  newAgentElsewhere: () => openNewLiveSessionModal(),
  close: agent => { void closeAgent(agent); },
  currentMuxId,
  hidden: agentHidden,
  reportError: message => flashStatusError(message, 8000),
});

/** Shows a pimux agent here; selecting the ready one already shown only closes the drawer, an unavailable one reattaches. */
async function openAgent(agent: OverviewAgent) {
  if (agent.muxId === currentMuxId() && captureCommandTarget() !== null) {
    // Choosing the shown agent again still supersedes a slower open of another one.
    beginViewSelection();
    closeSidebarOnMobile();
    return;
  }
  if (await attachSharedAgent(agent.muxId)) {
    closeSidebarOnMobile();
    focusComposer();
  }
}

// UI elements
export const messageInput = document.getElementById('message-input')!;
const chatForm = document.getElementById('chat-form')!;
export const sendBtn = document.getElementById('send-btn')!;
export const abortBtn = document.getElementById('abort-btn')!;
export const statusIndicator = document.getElementById('status-indicator')!;
export const statusText = document.getElementById('status-text')!;
export const agentTitleName = document.getElementById('agent-title-name')!;
// Tracks the pending timer that restores statusText after a transient
// status message (rpcCommand success/error). Any new status message must
// clear this so a stale restore cannot overwrite a later, longer-lived
// message (e.g. the red-dot error flash).
let statusRestoreTimer: ReturnType<typeof setTimeout> | null = null;
// Restore the status indicator dot to its real connection/streaming state.
// Only touches the indicator class (not statusText), so callers can set the
// accompanying text themselves.
export function restoreStatusIndicator() {
  const open = wsClient.ws?.readyState === WebSocket.OPEN;
  statusIndicator.className = `status-indicator ${
    open && state.isStreaming ? 'streaming' : (open ? 'connected' : 'disconnected')
  }`;
}
// Set a transient statusText message and, with `restoreMs`, schedule the
// return to the real connection state. Cancels any
// previously scheduled restore so overlapping messages cannot race. A new
// status message also supersedes any active error flash: it cancels the
// flash's restore and returns the dot to its real state so the `error`
// class cannot linger with no timer to clear it.
export function setStatusMessage(text: string, restoreMs: number | null = null) {
  if (app.statusFlashTimer !== null) {
    clearTimeout(app.statusFlashTimer);
    app.statusFlashTimer = null;
    restoreStatusIndicator();
  }
  clearTimeout(statusRestoreTimer ?? undefined);
  statusText.textContent = text;
  if (restoreMs !== null) {
    statusRestoreTimer = setTimeout(() => {
      statusRestoreTimer = null;
      statusText.textContent = currentStatusText();
    }, restoreMs);
  }
}
// Turn the status indicator red and show an error message; after `ms`,
// restore the indicator to the real connection state and reset the text.
export function flashStatusError(msg: string, ms = 3000) {
  // Reset the class atomically so no stale connected/disconnected/streaming
  // class lingers alongside `error` (matches updateConnectionStatus' style).
  statusIndicator.className = 'status-indicator error';
  // Cancel any pending status-text restore (e.g. rpcCommand's 'Done' ->
  // 'Connected' timer from an earlier successful step in the same flow) so it
  // cannot overwrite this error message while the red dot persists.
  clearTimeout(statusRestoreTimer ?? undefined);
  // Cancel any prior flash restore so overlapping flashes (a second
  // model-save failure within 3s) cannot leak a stray restore that
  // would reset the dot before this flash's own restore fires.
  clearTimeout(app.statusFlashTimer ?? undefined);
  statusText.textContent = msg;
  // Schedule the dot+text restore on the dedicated statusFlashTimer so a
  // later setStatusMessage (e.g. the user clicking the thinking-level cycle
  // button right after a thinking-level failure) cannot cancel the only
  // callback that clears the `error` class. If a new status message does
  // arrive, setStatusMessage itself retires the flash via restoreStatusIndicator.
  app.statusFlashTimer = setTimeout(() => {
    app.statusFlashTimer = null;
    restoreStatusIndicator();
    statusText.textContent = currentStatusText();
  }, ms);
}

const sidebarEl = document.getElementById('sidebar')!;
const sidebarToggle = document.getElementById('sidebar-toggle')!;
const sidebarOverlay = document.getElementById('sidebar-overlay')!;

export const typingIndicator = document.getElementById('typing-indicator')!;

export const contextPillEl = document.getElementById('context-pill')!;
const scrollBottomBtn = document.getElementById('scroll-bottom-btn')!;
export const scrollBottomBadge = document.getElementById('scroll-bottom-badge')!;
export const messagesContainer = document.getElementById('messages')!;
export function beginViewSelection(explicit = true) {
  ++app.viewSelection;
  if (explicit) app.reattachMuxId = null;
  stopFollowing();
  return app.viewSelection;
}
let agentSessionFiles = '';
dialogHandler.onIdle = () => {
  processQueuedExtensionUIRequest();
  focusComposer();
};

// ═══════════════════════════════════════
// Focus tracking for tab title notifications
// ═══════════════════════════════════════

window.addEventListener('focus', () => {
  app.hasFocus = true;
  app.unreadCount = 0;
  document.title = app.originalTitle;
});

window.addEventListener('blur', () => {
  app.hasFocus = false;
});

// Reconnect WebSocket when returning to the app (iOS suspends WS connections)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wsClient.ws?.readyState !== WebSocket.OPEN) {
    console.log('[App] Returning to app, reconnecting...');
    wsClient.forceReconnect();
  }
});

// ═══════════════════════════════════════
// Scroll-to-bottom button + new message indicator
// ═══════════════════════════════════════

messagesContainer.addEventListener('scroll', () => {
  const threshold = 150;
  const atBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < threshold;
  app.isScrolledUp = !atBottom;

  if (atBottom) {
    scrollBottomBtn.classList.add('hidden');
    scrollBottomBadge.classList.add('hidden');
    app.hasNewWhileScrolled = false;
  } else {
    scrollBottomBtn.classList.remove('hidden');
  }
});

scrollBottomBtn.addEventListener('click', () => {
  messagesContainer.scrollTo({ top: messagesContainer.scrollHeight, behavior: 'smooth' });
  scrollBottomBtn.classList.add('hidden');
  scrollBottomBadge.classList.add('hidden');
  app.hasNewWhileScrolled = false;
});

// An on-screen keyboard shrinks only the visual viewport where the browser
// does not resize the layout (Chrome in fullscreen, iOS Safari). Fit the app to
// the visible area so the composer stays above the keyboard, keeping the latest
// message in view. Pinch zoom also shrinks the visual viewport; ignore it.
const visibleViewport = window.visualViewport;
if (visibleViewport) {
  const rootStyle = document.documentElement.style;
  const fitVisibleViewport = () => {
    const keepBottom = !app.isScrolledUp;
    if (Math.abs(visibleViewport.scale - 1) < 0.01) {
      rootStyle.setProperty('--visible-height', `${visibleViewport.height}px`);
      rootStyle.setProperty('--visible-top', `${visibleViewport.offsetTop}px`);
    } else {
      rootStyle.removeProperty('--visible-height');
      rootStyle.removeProperty('--visible-top');
    }
    if (keepBottom) messagesContainer.scrollTo({ top: messagesContainer.scrollHeight, behavior: 'instant' });
  };
  visibleViewport.addEventListener('resize', fitVisibleViewport);
  visibleViewport.addEventListener('scroll', fitVisibleViewport);
  fitVisibleViewport();
}

wsClient.addEventListener('connected', () => {
  ++app.connectionRevision;
  updateConnectionStatus('connected');
  // Fetch model context window size for token % display
  setTimeout(fetchContextWindow, 1000);
  // A dispatch that settled while the socket was down never saw its
  // agent_settled. Ask Pi for fresh state so the lock cannot outlive the
  // operation it guarded; a still-running operation keeps it locked.
  for (const [sessionId, queued] of queuedPrompts) void reconcileAcceptedPrompt(sessionId, queued, true);
});

wsClient.addEventListener('disconnected', () => {
  ++app.connectionRevision;
  // HTTP polling or an old view's 404 can arrive before the replacement
  // server's first state. Remember the runtime while its view still exists.
  const selected = app.viewingActiveSession ? app.liveSessions.find(session => session.id === app.activeLiveSessionId) : null;
  if (selected?.attached) app.reattachMuxId ??= selected.attached.muxId;
  updateConnectionStatus('disconnected');
  // Their acknowledgements went to this socket and can never arrive.
  unsentInput.keepInFlight();
});

wsClient.addEventListener('reconnectFailed', () => {
  updateConnectionStatus('disconnected');
  messageRenderer.renderError('Connection lost. Please refresh the page.');
});

wsClient.addEventListener('rpcEvent', onRpcEvent);

// Tau answers the sender on its socket even when no Pi ever saw the command.
wsClient.addEventListener('rpcResponse', (e: Event) => {
  const { id, success, error } = (e as CustomEvent<{ id?: unknown; success?: boolean; error?: string }>).detail;
  if (typeof id === 'string') settlePrompt(id, success !== false, error);
});

wsClient.addEventListener('serverError', (e: Event) => {
  messageRenderer.renderError((e as CustomEvent<{ message: string }>).detail.message);
});

wsClient.addEventListener('stateUpdate', onStateUpdate);

wsClient.addEventListener('liveSessionCreated', (e: Event) => {
  upsertLiveSession((e as CustomEvent<LiveSession>).detail);
  restoreReconnectedView();
  scheduleSidebarRefresh();
});

wsClient.addEventListener('liveSessionUpdated', onLiveSessionUpdated);

wsClient.addEventListener('liveSessionClosed', (e: Event) => {
  const detail = (e as CustomEvent<{ sessionId: string; reason?: string; message?: string; notice?: boolean }>).detail;
  const session = app.liveSessions.find(s => s.id === detail.sessionId);
  if (session) {
    if ((detail.reason === 'server_shutdown' || detail.reason === 'reconnected') && app.viewingActiveSession && session.id === app.activeLiveSessionId) app.reattachMuxId ??= session.attached?.muxId || null;
  }
  handleLiveSessionClosed(detail.sessionId, detail.message, detail.notice, detail.reason);
  restoreReconnectedView();
  scheduleSidebarRefresh();
});

wsClient.addEventListener('agentsUpdate', (e: Event) => {
  const agents = (e as CustomEvent<OverviewAgent[]>).detail || [];
  agentSidebar.update(agents);
  updateUI();
  // Agents start and change sessions elsewhere too.
  const files = agents.map(agent => agent.sessionFile).sort().join('\n');
  if (files !== agentSessionFiles) scheduleSidebarRefresh();
  agentSessionFiles = files;
});

wsClient.addEventListener('interactionState', (e: Event) => {
  reconcileInteractionState((e as CustomEvent<InteractionState>).detail);
});

// Receive a full live-session state snapshot.
// Passive fanout updates only the live conversation currently being viewed.
// Explicit selection loads its own snapshot after setting viewingActiveSession.
// A shared view's snapshots also carry its open dialogs, which apply to any view.
wsClient.addEventListener('liveSessionSnapshot', onLiveSessionSnapshot);

window.addEventListener('hashchange', () => {
  if (app.hasReceivedInitialServerState && wsClient.ws?.readyState === WebSocket.OPEN) showAgentFromUrl();
});
const newLiveSessionForm = document.getElementById('new-live-session-form');

export const cwdCompletion = attachCompletionList({
  input: newLiveSessionCwd,
  debounceMs: 100,
  continueAfterAccept: true,
  async getItems(text, signal) {
    const res = await fetch(`/api/complete/directories?prefix=${encodeURIComponent(text)}`, { signal });
    const data = await res.json();
    return (data.items || []).map((item: { name: string; path: string }) => ({ primary: item.name, value: `${item.path}/` }));
  },
});

export const modelCompletion = attachCompletionList({
  input: newLiveSessionModel,
  highlightFirst: true,
  getItems(text) {
    if (text.includes(':')) return [];
    return searchModels(normalizeModelList(app.newLiveSessionModels), text).map((model) => ({
      primary: model.id,
      badge: model.provider,
      meta: modelMeta(model),
      value: modelRef(model),
    }));
  },
});

document.getElementById('new-live-session-close')?.addEventListener('click', closeNewLiveSessionModal);
document.getElementById('new-live-session-cancel')?.addEventListener('click', closeNewLiveSessionModal);
newLiveSessionOverlay?.addEventListener('click', closeNewLiveSessionModal);
newLiveSessionForm?.addEventListener('submit', submitNewLiveSession);

// ═══════════════════════════════════════
// Input handling — textarea with auto-resize
// ═══════════════════════════════════════

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  sendMessage();
});

messageInput.addEventListener('keydown', (e) => {
  if (isImeComposition(e)) return;
  // Enter sends, Shift+Enter inserts newline
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// Auto-resize textarea
messageInput.addEventListener('input', () => {
  messageInput.style.height = 'auto';
  messageInput.style.height = Math.min(messageInput.scrollHeight, 200) + 'px';
});

// ═══════════════════════════════════════
// Attachments (images + file browser paths)
// ═══════════════════════════════════════

const attachBtn = document.getElementById('attach-btn')!;
const imageInput = document.getElementById('image-input')!;

attachBtn.addEventListener('click', () => imageInput.click());

imageInput.addEventListener('change', () => {
  addAttachments(imageInput.files ?? []);
  imageInput.value = '';
});

// Drag & drop on input
messageInput.addEventListener('dragover', (e) => { e.preventDefault(); });
messageInput.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer && e.dataTransfer.files.length > 0) addAttachments(e.dataTransfer.files);
});

// Paste images
messageInput.addEventListener('paste', (e) => {
  if (!e.clipboardData) return;
  const files: File[] = [];
  for (const item of e.clipboardData.items) {
    if (!item.type.startsWith('image/')) continue;
    files.push(item.getAsFile() as File);
  }
  if (files.length) addAttachments(files);
});
recoveredInputEl.id = 'recovered-input';
recoveredInputEl.className = 'hidden';
recoveredInputEl.setAttribute('aria-label', 'Input kept for review');
document.querySelector('.input-area')!.prepend(recoveredInputEl);

abortBtn.addEventListener('click', abortActiveSession);

// Command Palette
const commandPaletteController = setupCommandPalette([
  { icon: '✨', label: 'New session', desc: 'Start over in this shared agent; every frontend moves with it', available: activeViewCanStartOver, action: () => { void newSharedSession(); } },
  { icon: '🌳', label: 'Session tree', desc: 'Jump to any earlier point in the session tree', available: activeViewCanNavigate, action: () => { void treeViewController.open(); } },
  { icon: '×', label: 'Clear agent queue everywhere…', desc: 'Remove all frontends’ queued input; keep returned text here for review', available: () => activeViewIsShared() && captureCommandTarget() !== null, action: () => { void clearSharedQueue(); } },
  { icon: '🗜️', label: 'Compact', desc: 'Compact context to save tokens', available: () => app.viewingActiveSession && captureCommandTarget() !== null, action: () => { requestCompaction(); } },
  { icon: '⬇️', label: 'Expand All Steps', desc: 'Show all assistant activity', action: () => setAssistantBlocksExpanded(true) },
  { icon: '⬆️', label: 'Collapse All Steps', desc: 'Show only results', action: () => setAssistantBlocksExpanded(false) },
  { icon: '⬇️', label: 'Expand All Tools', desc: 'Show tool details and calls', action: () => toolCardRenderer.expandAll() },
  { icon: '⬆️', label: 'Collapse All Tools', desc: 'Hide tool details and calls', action: () => toolCardRenderer.collapseAll() },
]);

// Model Picker
export const modelPickerController = setupModelPicker({
  getActiveLiveSessionId: () => app.activeLiveSessionId,
  isViewingActiveSession: () => app.viewingActiveSession,
  rpcCommand,
  captureCommandTarget,
  commandContextIsCurrent,
  flashStatusError,
  escapeHtml,
  setContextWindowSize(value) { app.contextWindowSize = value; },
  updateContextPill,
  focusComposer,
});

// Session tree view (modal opened from the header git-branch button, or the
// command palette). Selecting an entry moves the session leaf server-side;
// the conversation re-renders when the server broadcasts a fresh snapshot.
export const treeViewController = setupTreeView({
  getActiveLiveSessionId: () => (activeViewCanNavigate() ? app.activeLiveSessionId : null),
  isStreaming: () => state.isStreaming,
  getViewSelection: () => app.viewSelection,
  captureCommandTarget,
  rpcCommand,
  captureComposerText() {
    const origin = app.composerContext ? copyInputContext(app.composerContext) : null;
    return (text) => {
      if (origin && text) unsentInput.keep(origin, { text, images: [] });
      restoreUnsentInput();
    };
  },
  flashStatusError,
});

// ═══════════════════════════════════════
// Keyboard shortcuts
// ═══════════════════════════════════════

document.addEventListener('keydown', (e) => {
  if (isImeComposition(e)) return;
  // Escape — Abort streaming, or close sidebar on mobile
  if (e.key === 'Escape') {
    // Close palettes/panels first
    let closed = modelPickerController.closeIfOpen() || treeViewController.closeIfOpen() || commandPaletteController.closeIfOpen();
    if (headerMenu.closeIfOpen()) closed = true;
    if (!newLiveSessionModal?.classList.contains('hidden')) {
      closeNewLiveSessionModal();
      closed = true;
    }
    if (!settingsPanel.classList.contains('hidden')) {
      closeSettings();
      closed = true;
    }
    if (closed) {
      focusComposer();
      return;
    }

    if (app.viewingActiveSession && app.activeLiveSessionId && (state.isStreaming || sessionHasPendingWork(app.activeLiveSessionId))) {
      abortActiveSession();
    } else if (!sidebarEl.classList.contains('collapsed') && window.innerWidth <= 768) {
      toggleSidebar();
    }
  }

  // / — Focus message input (when not already in an input)
  if (e.key === '/' && !isInInput()) {
    e.preventDefault();
    messageInput.focus();
  }
});

function isInInput() {
  const tag = document.activeElement?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable;
}

// ═══════════════════════════════════════
// Sidebar
// ═══════════════════════════════════════

export function isMobile() {
  return window.innerWidth <= 768;
}

function toggleSidebar() {
  sidebarEl.classList.toggle('collapsed');
  sidebarOverlay.classList.toggle('visible', !sidebarEl.classList.contains('collapsed') && isMobile());
}

/** On a phone the sidebar is a drawer over the conversation; it closes once an agent is chosen. */
export function closeSidebarOnMobile() {
  if (!isMobile()) return;
  sidebarEl.classList.add('collapsed');
  sidebarOverlay.classList.remove('visible');
}

export function showSidebarOnMobile() {
  if (!isMobile()) return;
  sidebarEl.classList.remove('collapsed');
  sidebarOverlay.classList.add('visible');
}

sidebarToggle.addEventListener('click', toggleSidebar);
sidebarOverlay.addEventListener('click', closeSidebarOnMobile);

// Swipe from left edge to open sidebar on mobile
(function initSwipeGesture() {
  let touchStartX = 0;
  let touchStartY = 0;
  let tracking = false;

  document.addEventListener('touchstart', (e) => {
    const touch = e.touches[0];
    // Only track swipes starting within 20px of left edge
    if (touch.clientX < 20 && isMobile() && sidebarEl.classList.contains('collapsed')) {
      touchStartX = touch.clientX;
      touchStartY = touch.clientY;
      tracking = true;
    }
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!tracking) return;
    const touch = e.touches[0];
    const dx = touch.clientX - touchStartX;
    const dy = Math.abs(touch.clientY - touchStartY);
    // If vertical movement dominates, cancel
    if (dy > dx) {
      tracking = false;
    }
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    const touch = e.changedTouches[0];
    const dx = touch.clientX - touchStartX;
    if (dx > 60) {
      sidebarEl.classList.remove('collapsed');
      sidebarOverlay.classList.add('visible');
    }
  }, { passive: true });
})();

/** Opening a saved session resumes it as an agent, or follows it read-only while another Pi runs it. */
async function handleSessionSelect(session: SidebarSession) {
  app.sessionTotalCost = 0;
  app.lastInputTokens = 0;
  app.lastUsage = null;
  updateContextPill();
  closeSidebarOnMobile();
  await switchSession(session.filePath, session);
}

// Poll every 10 seconds
setInterval(pollInstances, 10000);
messagesContainer.classList.toggle('native-scroll-anchoring', supportsScrollAnchoring);

// ═══════════════════════════════════════
// WebSocket session switch handler
// ═══════════════════════════════════════

wsClient.addEventListener('sessionSwitch', () => {
  console.log('[App] Session switched');
});

// ═══════════════════════════════════════
// Theme / Settings
// ═══════════════════════════════════════

const settingsClose = document.getElementById('settings-close')!;
const toggleShowThinking = document.getElementById('toggle-show-thinking')!;

settingsClose.addEventListener('click', closeSettings);
settingsOverlay.addEventListener('click', closeSettings);

// Auto-compaction toggle
// Pi saves this setting to the user's Pi settings file, so it applies to every
// Pi session, including the terminal UI.
toggleAutoCompact.addEventListener('click', async () => {
  const isOn = toggleAutoCompact.classList.contains('on');
  toggleAutoCompact.className = `settings-toggle${isOn ? '' : ' on'}`;
  const data = await rpcCommand({ type: 'set_auto_compaction', enabled: !isOn });
  if (!data?.success) toggleAutoCompact.className = `settings-toggle${isOn ? ' on' : ''}`;
});

// Show thinking toggle (local pref)
const showThinking = localStorage.getItem('tau-show-thinking') !== 'false';
toggleShowThinking.className = `settings-toggle${showThinking ? ' on' : ''}`;
if (!showThinking) document.body.classList.add('hide-thinking');

toggleShowThinking.addEventListener('click', () => {
  const isOn = toggleShowThinking.classList.contains('on');
  toggleShowThinking.className = `settings-toggle${isOn ? '' : ' on'}`;
  document.body.classList.toggle('hide-thinking', isOn);
  for (const blocks of assistantBlockControllers) blocks.refreshThinking();
  localStorage.setItem('tau-show-thinking', String(!isOn));
});

// Fullscreen preference: on by default for touch devices, off for desktop;
// an explicit choice is remembered. Browsers only enter fullscreen from a user
// gesture, so while the preference is on, any tap outside fullscreen enters it
// (also after the browser left fullscreen, e.g. on an app switch).
const toggleFullscreen = document.getElementById('toggle-fullscreen')!;
const installedFullscreen = matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches;
if (document.fullscreenEnabled && !installedFullscreen) {
  const savedFullscreen = localStorage.getItem('tau-fullscreen');
  let preferFullscreen = savedFullscreen ? savedFullscreen === 'on' : matchMedia('(pointer: coarse)').matches;
  const changeFullscreen = (enter: boolean) => {
    if (enter === Boolean(document.fullscreenElement)) return;
    const change = enter ? document.documentElement.requestFullscreen() : document.exitFullscreen();
    change.catch((error: unknown) => console.warn('Fullscreen change failed', error));
  };
  const syncFullscreenToggle = () => {
    toggleFullscreen.className = `settings-toggle${preferFullscreen ? ' on' : ''}`;
  };
  syncFullscreenToggle();
  document.addEventListener('click', (event) => {
    if (preferFullscreen && !(event.target instanceof Element && event.target.closest('#toggle-fullscreen'))) changeFullscreen(true);
  }, true);
  toggleFullscreen.addEventListener('click', () => {
    preferFullscreen = !preferFullscreen;
    localStorage.setItem('tau-fullscreen', preferFullscreen ? 'on' : 'off');
    syncFullscreenToggle();
    changeFullscreen(preferFullscreen);
  });
} else if (!installedFullscreen) {
  // iPhone Safari has no element fullscreen; a Home Screen web app is.
  document.getElementById('fullscreen-label')!.textContent = 'Fullscreen: add Tau to your Home Screen';
  toggleFullscreen.style.display = 'none';
} else {
  document.getElementById('setting-fullscreen')!.style.display = 'none';
}

toggleAuth.addEventListener('click', async () => {
  const isOn = toggleAuth.classList.contains('on');
  const data = await rpcCommand({ type: 'set_auth', enabled: !isOn });
  if (data?.success) {
    toggleAuth.className = `settings-toggle${!isOn ? ' on' : ''}`;
  }
});

applyTheme(getCurrentTheme());

// ═══════════════════════════════════════
// Session stats card (opened from the context pill)
// ═══════════════════════════════════════

// Fetch authoritative session stats from pi's get_session_stats RPC. Uses a
// plain fetch (not rpcCommand) so it never flashes status-bar messages.
// Resolves null when there is no live session or the fetch fails; a stale
// response for a session we already switched away from is discarded, and any
// authoritative numbers are synced into the pill's local state.
async function fetchSessionStats(): Promise<SessionStats | null> {
  if (!app.viewingActiveSession || !app.activeLiveSessionId) return null;
  const requestSessionId = app.activeLiveSessionId;
  const selection = app.viewSelection;
  try {
    const resp = await fetch('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'get_session_stats', sessionId: requestSessionId }),
    });
    const data = await resp.json();
    if (!data?.success || !data.data) return null;
    if (selection !== app.viewSelection || app.activeLiveSessionId !== requestSessionId || !app.viewingActiveSession) return null;
    const stats = data.data as SessionStats;

    // Sync authoritative numbers into the locally-tracked pill state so the
    // pill never drifts from what pi reports. contextUsage (and its fields)
    // may be null right after compaction — keep the last known values then.
    if (typeof stats.cost === 'number') app.sessionTotalCost = stats.cost;
    const cu = stats.contextUsage;
    if (cu && typeof cu.contextWindow === 'number' && cu.contextWindow > 0) {
      app.contextWindowSize = cu.contextWindow;
    }
    if (cu && typeof cu.tokens === 'number') {
      app.lastInputTokens = cu.tokens;
      app.contextTokensEstimated = false;
    }
    updateContextPill();
    return stats;
  } catch {
    return null;
  }
}

export const sessionStatsCard = setupSessionStatsCard({
  pillEl: contextPillEl,
  cardEl: document.getElementById('session-stats-card')!,
  fetchStats: fetchSessionStats,
  getFallback: () => ({
    usage: app.lastUsage,
    cost: app.sessionTotalCost,
    contextTokens: app.lastInputTokens,
    contextWindow: app.contextWindowSize,
  }),
});

const showsAgent = () => app.viewingActiveSession && !!app.activeLiveSessionId;
const headerMenu = setupHeaderMenu(document.getElementById('header-menu-btn')!, document.getElementById('header-menu')!, [
  { label: 'Usage and cost', available: showsAgent, action: () => { void sessionStatsCard.open(); } },
  { label: 'Export HTML', available: showsAgent, action: () => { void rpcExportHtml(); } },
  { label: 'Settings', action: () => { void openSettings(); } },
  { label: 'Close agent', danger: true, available: showsAgent, action: () => { if (app.activeLiveSessionId) void closeLiveSession(app.activeLiveSessionId); } },
]);

// Voice input (assigned once the DOM hooks below exist; session changes cancel it)
app.voiceInput = setupVoiceInput(document.getElementById('mic-btn')!, messageInput as HTMLTextAreaElement, document.getElementById('voice-status')!, sendMessage);

// ═══════════════════════════════════════
// Initialize
// ═══════════════════════════════════════

// On mobile, start with the sidebar collapsed. The context pill stays in the
// header on all screen sizes.
if (isMobile()) {
  sidebarEl.classList.add('collapsed');
}

wsClient.connect();
messageRenderer.renderWelcome();
updateLiveSessionInputState();

// Register service worker for PWA
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// Dismiss mobile splash screen
const splash = document.getElementById('mobile-splash');
if (splash) {
  requestAnimationFrame(() => {
    splash.classList.add('hidden');
    setTimeout(() => splash.remove(), 300);
  });
}

console.log('🚀 Tau initialized');
