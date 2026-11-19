// Conversation view: history rendering, read-only follow, scrolling and status helpers.

import { messagesContainer, scrollBottomBadge, messageRenderer, beginViewSelection, dialogHandler, assistantBlockControllers, assistantBlocks, toolCardRenderer, typingIndicator, contextPillEl, modelPickerController, statusIndicator, statusText, agentTitleName, wsClient, abortBtn, restoreStatusIndicator, messageInput, sendBtn } from './app-main.js';
import { app, currentMessageSteps, state } from './app-state.js';
import { buildHistoryItems, type SessionHistoryEntry, type HistoryItem } from './history-render.js';
import { updateLiveSessionInputState, selectLiveSession, rememberOpenedSession, closePending, viewTitle } from './live-views.js';
import type { SidebarSession } from './session-history.js';
import { bindComposerContext, isCompacting, requestCompaction, abortState, captureCommandTarget, activeViewIsShared, flushQueue } from './composer.js';
import { resetCompactionRow, clearRetryStatus, pendingInteractionCount } from './rpc-events.js';
import { AssistantBlocks } from './assistant-blocks.js';
import { renderCompactionRow } from './compaction-row.js';

export function scrollToBottom() {
  messagesContainer.scrollTo({ top: messagesContainer.scrollHeight, behavior: 'smooth' });
}

export function showNewMessageBadge() {
  if (app.isScrolledUp) {
    app.hasNewWhileScrolled = true;
    scrollBottomBadge.classList.remove('hidden');
  }
}

// ═══════════════════════════════════════
// Read-only follow of a session another Pi process owns
// ═══════════════════════════════════════

/*
 * A session file that an orchestration worker (tmux, Herdr, Emacs) is
 * appending to must not be resumed here: two `pi` processes writing one JSONL
 * file interleave entries and fork the conversation tree. Such a session is
 * shown read-only instead, re-read from disk while it grows.
 */

const FOLLOW_POLL_MS = 3000;

type SessionOwner = { name: string; host: string };
type FollowedSession = {
  dirName: string;
  file: string;
  offset: number;
  entries: SessionHistoryEntry[];
  owner: SessionOwner;
  timer: ReturnType<typeof setInterval>;
  selection: number;
  polling: boolean;
};

let followed: FollowedSession | null = null;

function sessionOwnerOf(value: unknown): SessionOwner | null {
  if (typeof value !== 'object' || value === null) return null;
  const { name, host } = value as { name?: unknown; host?: unknown };
  return typeof name === 'string' && typeof host === 'string' ? { name, host } : null;
}

export function stopFollowing() {
  if (!followed) return;
  clearInterval(followed.timer);
  followed = null;
}

async function readFollowedSession(dirName: string, file: string, since: number) {
  const res = await fetch(`/api/sessions/${encodeURIComponent(dirName)}/${encodeURIComponent(file)}?since=${since}`);
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || 'Failed to read session file');
  return data as { entries: SessionHistoryEntry[]; offset: number; reset: boolean };
}

function renderFollowedSession(current: FollowedSession) {
  clearConversation();
  messageRenderer.renderSystemMessage(
    `Read-only: ${current.owner.name} is running this session on ${current.owner.host}. Open it again once that worker finishes to continue it here.`
  );
  renderSessionHistory(current.entries);
  updateLiveSessionInputState();
  updateUI();
}

async function pollFollowedSession() {
  const current = followed;
  if (!current || current.selection !== app.viewSelection || current.polling) return;
  current.polling = true;
  try {
    const chunk = await readFollowedSession(current.dirName, current.file, current.offset);
    if (followed !== current || current.selection !== app.viewSelection) return;
    current.offset = chunk.offset;
    if (chunk.reset) current.entries = chunk.entries;
    else if (chunk.entries.length) current.entries = current.entries.concat(chunk.entries);
    else return;
    renderFollowedSession(current);
  } catch (e) {
    if (followed !== current || current.selection !== app.viewSelection) return;
    stopFollowing();
    messageRenderer.renderError(e instanceof Error ? e.message : 'Stopped following this session');
  } finally {
    current.polling = false;
  }
}

async function followSession(session: SidebarSession, owner: SessionOwner, selection: number) {
  if (selection !== app.viewSelection) return;
  stopFollowing();
  const { dir: dirName, file } = session;
  try {
    const chunk = await readFollowedSession(dirName, file, 0);
    if (selection !== app.viewSelection) return;
    followed = { dirName, file, offset: chunk.offset, entries: chunk.entries, owner, selection, polling: false, timer: setInterval(pollFollowedSession, FOLLOW_POLL_MS) };
    renderFollowedSession(followed);
  } catch (e) {
    if (selection === app.viewSelection) messageRenderer.renderError(e instanceof Error ? e.message : 'Failed to read session file');
  }
}

export async function switchSession(sessionFile: string | null | undefined, session: SidebarSession | null = null) {
  const selection = beginViewSelection();
  bindComposerContext(null);
  app.voiceInput?.cancel();
  try {
    // Clear any streaming state from previous session to prevent bleed
    currentMessageSteps.clear();
    app.pendingAssistantError = null;
    app.retryStatusElement = null;
    dialogHandler.clearCurrentDialog();
    app.viewingActiveSession = false;
    stopFollowing();

    state.reset();
    showTypingIndicator(false);
    updateUI();
    clearConversation();

    // Opening a saved session resumes it as an agent.
    // selectLiveSession() will load the resumed view snapshot with the same
    // historical entries after the backend has attached to the session file.
    if (sessionFile) {
      const live = app.liveSessions.find(s => s.sessionFile === sessionFile);
      if (live) {
        await selectLiveSession(live.id, true, selection);
        return;
      }
      const owner = session ? sessionOwnerOf(session.owner) : null;
      if (owner) {
        updateLiveSessionInputState();
        await followSession(session!, owner, selection);
        return;
      }
      // No live view yet — ask the server to resume this session.
      messageRenderer.renderSystemMessage('Resuming session…');
      try {
        // The server reads the project directory from the session's own
        // header, so the resume request only has to name the file.
        const res = await fetch('/api/live-sessions/resume', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath: sessionFile }),
        });
        const data = await res.json();
        if (res.ok && !data.error && data.session) rememberOpenedSession(data.session);
        if (selection !== app.viewSelection) return;
        if (!res.ok || data.error) {
          clearConversation();
          app.viewingActiveSession = false;
          updateLiveSessionInputState();
          updateUI();
          // The listing was stale: another process took the session over
          // between the click and the request.
          const refused = sessionOwnerOf(data.owner);
          if (refused && session) {
            await followSession(session, refused, selection);
            return;
          }
          messageRenderer.renderError(data.error || 'Failed to resume session');
          return;
        }
        if (!data.session) throw new Error('The resume response did not identify a live view');
        await selectLiveSession(data.session.id, true, selection);
      } catch (e) {
        if (selection !== app.viewSelection) return;
        clearConversation();
        messageRenderer.renderError('Failed to resume session');
        app.viewingActiveSession = false;
        updateLiveSessionInputState();
        updateUI();
      }
      return;
    }

    messageRenderer.renderWelcome();
  } catch (error) {
    if (selection !== app.viewSelection) return;
    console.error('[App] Failed to switch session:', error);
    messageRenderer.renderError('Failed to switch session');
  }
}

// ═══════════════════════════════════════
// Session history rendering
// ═══════════════════════════════════════

// Chunk only at user/compaction boundaries: a deferred chunk must never split
// one assistant activity block or steal the current live block's controller.
const INITIAL_SYNC_GROUPS = 30;
const HISTORY_CHUNK_GROUPS = 50;
export const supportsScrollAnchoring = typeof CSS !== 'undefined' && !!CSS.supports && CSS.supports('overflow-anchor', 'auto');
let historyRenderToken = 0;

export function setAssistantBlocksExpanded(expanded: boolean) {
  app.expandedAssistantBlocks = expanded;
  for (const blocks of assistantBlockControllers) blocks.setExpanded(expanded);
}

export function clearConversation() {
  historyRenderToken++;
  resetCompactionRow();
  messagesContainer.style.scrollBehavior = '';
  currentMessageSteps.clear();
  app.pendingAssistantError = null;
  clearRetryStatus();
  for (const blocks of assistantBlockControllers) blocks.clear();
  assistantBlockControllers.clear();
  assistantBlockControllers.add(assistantBlocks);
  app.expandedAssistantBlocks = false;
  messageRenderer.clear();
  toolCardRenderer.clear();
  state.toolExecutions.clear();
}

function renderHistoryItem(item: HistoryItem, blocks: AssistantBlocks, target: HTMLElement) {
  if (item.kind === 'user') {
    blocks.boundary();
    messageRenderer.renderUserMessage({ content: item.content, images: item.images }, true, target);
  } else if (item.kind === 'compaction') {
    blocks.boundary();
    target.appendChild(renderCompactionRow({
      status: 'done', summary: item.summary, tokensBefore: item.tokensBefore, estimatedTokensAfter: item.estimatedTokensAfter,
    }));
  } else {
    let element: HTMLElement;
    let label: string;
    if (item.kind === 'assistant') {
      element = messageRenderer.renderAssistantStep(item.step);
      label = item.step.type;
    } else if (item.kind === 'assistantError') {
      element = messageRenderer.renderAssistantError(item.error);
      label = 'error';
    } else {
      element = toolCardRenderer.createHistoryCard({
        toolCallId: item.toolCallId, toolName: item.toolName, args: item.args,
        status: item.result !== undefined ? (item.isError ? 'error' : 'complete') : 'pending',
      }, document.createDocumentFragment());
      if (item.result !== undefined || item.isError) {
        toolCardRenderer.addHistoryResult(item.toolCallId, item.result ?? { content: [] }, !!item.isError);
      }
      label = item.toolName;
    }
    blocks.append(element, label);
    element.closest('.assistant-block')?.classList.add('history');
  }
}

export function renderSessionHistory(entries: SessionHistoryEntry[]) {
  const token = ++historyRenderToken;
  const { items, totalCost, lastInputTokens: inputTokens, contextTokensEstimated: estimated, lastUsage: usage } = buildHistoryItems(entries);
  const groups: HistoryItem[][] = [];
  for (const item of items) {
    if (!groups.length || item.kind === 'user' || item.kind === 'compaction') groups.push([]);
    groups[groups.length - 1].push(item);
    if (item.kind === 'toolCall') {
      toolCardRenderer.rememberRoot({ toolCallId: item.toolCallId, toolName: item.toolName, args: item.args,
        status: item.result !== undefined ? (item.isError ? 'error' : 'complete') : 'pending' });
    }
  }
  // Stats are authoritative immediately, not accumulated by progressive DOM.
  app.sessionTotalCost = totalCost;
  app.lastInputTokens = inputTokens;
  app.contextTokensEstimated = estimated;
  app.lastUsage = usage;
  updateContextPill();
  fetchContextWindow();

  let cursor = Math.max(0, groups.length - INITIAL_SYNC_GROUPS);
  const beforeTail = messagesContainer.lastChild;
  for (const group of groups.slice(cursor)) {
    for (const item of group) renderHistoryItem(item, assistantBlocks, messagesContainer);
  }
  let topAnchor = beforeTail ? beforeTail.nextSibling : messagesContainer.firstChild;
  messagesContainer.style.scrollBehavior = 'auto';
  requestAnimationFrame(() => {
    if (token !== historyRenderToken) return;
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    requestAnimationFrame(() => {
      if (token === historyRenderToken) messagesContainer.style.scrollBehavior = '';
    });
  });

  const scheduleChunk = (fn: () => void) => typeof requestIdleCallback === 'function'
    ? requestIdleCallback(fn, { timeout: 500 }) : setTimeout(fn, 16);
  const renderOlderChunk = () => {
    if (token !== historyRenderToken || !topAnchor?.isConnected) return;
    const start = Math.max(0, cursor - HISTORY_CHUNK_GROUPS);
    const target = document.createElement('div');
    const blocks = new AssistantBlocks(target);
    assistantBlockControllers.add(blocks);
    for (const group of groups.slice(start, cursor)) {
      for (const item of group) renderHistoryItem(item, blocks, target);
    }
    blocks.setExpanded(app.expandedAssistantBlocks);
    const chunk = document.createDocumentFragment();
    chunk.append(...Array.from(target.childNodes));
    const newTop = chunk.firstChild;
    if (supportsScrollAnchoring) {
      messagesContainer.insertBefore(chunk, topAnchor);
    } else {
      const behavior = messagesContainer.style.scrollBehavior;
      messagesContainer.style.scrollBehavior = 'auto';
      const height = messagesContainer.scrollHeight;
      const top = messagesContainer.scrollTop;
      messagesContainer.insertBefore(chunk, topAnchor);
      messagesContainer.scrollTop = top + messagesContainer.scrollHeight - height;
      messagesContainer.style.scrollBehavior = behavior;
    }
    if (newTop) topAnchor = newTop;
    cursor = start;
    if (cursor > 0) scheduleChunk(renderOlderChunk);
  };
  if (cursor > 0) scheduleChunk(renderOlderChunk);
}

// ═══════════════════════════════════════
// UI helpers
// ═══════════════════════════════════════

export function showTypingIndicator(show: boolean) {
  typingIndicator.classList.toggle('hidden', !show);
}

// The single header pill: shows context usage %, falling back to raw tokens
// (no context window info yet) or session cost (no context data yet).
// Clicking it opens the session stats card.
export function updateContextPill() {
  // After a compaction the count is Pi's estimate until the next reply.
  const approx = app.contextTokensEstimated ? '~' : '';
  const estimateNote = app.contextTokensEstimated ? ' (estimated after compaction)' : '';
  if (app.lastInputTokens > 0 && app.contextWindowSize > 0) {
    const pct = Math.round((app.lastInputTokens / app.contextWindowSize) * 100);
    contextPillEl.textContent = pct === 0 ? `${approx}<1%` : `${approx}${pct}%`;
    contextPillEl.classList.add('visible');
    contextPillEl.classList.remove('warning', 'critical');
    if (pct >= 80) {
      contextPillEl.classList.add('critical');
    } else if (pct >= 60) {
      contextPillEl.classList.add('warning');
    }
    contextPillEl.title = `Context: ${approx}${(app.lastInputTokens / 1000).toFixed(1)}k / ${(app.contextWindowSize / 1000).toFixed(0)}k tokens${estimateNote} — click for session stats`;
    const activeCompacting = !!app.activeLiveSessionId && isCompacting(app.activeLiveSessionId);
    if (pct >= 80 && app.viewingActiveSession && !activeCompacting) {
      showCompactButton();
    } else {
      hideCompactButton();
    }
  } else if (app.lastInputTokens > 0) {
    // No context window info yet, just show raw tokens
    contextPillEl.textContent = `${approx}${(app.lastInputTokens / 1000).toFixed(1)}k`;
    contextPillEl.classList.add('visible');
    contextPillEl.classList.remove('warning', 'critical');
    contextPillEl.title = `Context tokens${estimateNote} — click for session stats`;
  } else if (app.sessionTotalCost > 0) {
    // No context data yet — show the session cost as a fallback.
    contextPillEl.textContent = `$${app.sessionTotalCost.toFixed(3)} (sub)`;
    contextPillEl.classList.add('visible');
    contextPillEl.classList.remove('warning', 'critical');
    contextPillEl.title = 'Session cost — click for session stats';
  } else {
    contextPillEl.classList.remove('visible', 'warning', 'critical');
  }
}

function showCompactButton() {
  if (document.getElementById('compact-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'compact-btn';
  btn.className = 'compact-btn';
  btn.textContent = 'Compact';
  btn.title = 'Context is over 80% — compact to save tokens';
  btn.addEventListener('click', () => { requestCompaction(); });
  // Insert next to the context pill in the header
  const pillParent = contextPillEl.parentElement;
  if (pillParent) pillParent.insertBefore(btn, contextPillEl.nextSibling);
}

export function hideCompactButton() {
  const btn = document.getElementById('compact-btn');
  if (btn) btn.remove();
}

export async function fetchContextWindow() {
  // Delegate to fetchModelInfo which also updates the model button
  await modelPickerController.fetchModelInfo();
}

export function updateConnectionStatus(status: string) {
  statusIndicator.className = `status-indicator ${status}`;
  statusText.textContent = currentStatusText();
}

export function currentStatusText() {
  if (wsClient.ws?.readyState !== WebSocket.OPEN) return 'Disconnected';
  if (app.viewingActiveSession && app.activeLiveSessionId) {
    const stopping = abortState(app.activeLiveSessionId);
    if (stopping === 'stopping') return 'Stopping…';
    if (stopping === 'timed_out') return 'Stop timed out — completion not confirmed';
    if (stopping === 'failed') return 'Stop failed — completion not confirmed';
    if (pendingInteractionCount(app.activeLiveSessionId)) return 'Waiting for approval';
    if (isCompacting(app.activeLiveSessionId)) return 'Compacting…';
    if (state.isStreaming) return 'Working…';
  }
  // A working connection is not news: the header shows only what differs from it.
  return '';
}

/** The header names the agent this browser shows. */
export function updateAgentTitle() {
  const session = app.viewingActiveSession ? app.liveSessions.find(item => item.id === app.activeLiveSessionId) : undefined;
  const name = session ? viewTitle(session) : 'Tau';
  agentTitleName.textContent = name;
  agentTitleName.title = session?.cwd ? `${name} — ${session.cwd}` : name;
}

export function updateUI() {
  updateLiveSessionInputState();
  const hasLiveSession = !!app.activeLiveSessionId && app.viewingActiveSession;
  const isStreaming = state.isStreaming && hasLiveSession;
  const hasPendingInteraction = hasLiveSession && pendingInteractionCount(app.activeLiveSessionId!) > 0;
  const stopping = hasLiveSession && abortState(app.activeLiveSessionId!) === 'stopping';
  const compacting = hasLiveSession && isCompacting(app.activeLiveSessionId!);
  const closing = closePending();
  const inputReady = hasLiveSession && captureCommandTarget() !== null;
  abortBtn.disabled = !!stopping || !inputReady;
  abortBtn.title = stopping ? 'Stopping…' : 'Abort';
  abortBtn.setAttribute('aria-label', stopping ? 'Stopping…' : 'Abort');

  // Don't clobber an active red-dot error flash: it owns both the indicator
  // class and statusText for its full 3 s. The flash's restore callback
  // re-derives the current connection/streaming state, so skipping here is
  // safe. Other UI updates below (input enabling, abort button, etc.) still
  // run normally.
  if (app.statusFlashTimer === null) {
    restoreStatusIndicator();
    statusText.textContent = currentStatusText();
  }
  updateAgentTitle();

  messageInput.disabled = !inputReady || closing;
  sendBtn.disabled = !inputReady || closing;

  if (isStreaming || hasPendingInteraction || stopping || compacting) {
    abortBtn.classList.remove('hidden');
    // A shared view can steer, and on a phone this button is how.
    sendBtn.classList.toggle('hidden', !activeViewIsShared() || !!hasPendingInteraction || !!stopping);
  } else {
    abortBtn.classList.add('hidden');
    sendBtn.classList.remove('hidden');
  }
  if (hasLiveSession && !isStreaming && !closing) flushQueue();
}
