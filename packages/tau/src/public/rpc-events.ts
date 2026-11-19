// Pi RPC events of the active session: streaming, tools, compaction, retries and dialogs.

import { app, editorNoticeIds, piQueues, sessionStateRevisions, operationRevisions, queuedPrompts, settledWhileStopping, localAbortStates, compactRequests, compactionStarts, DISPLAY_UI_METHODS, DIALOG_METHODS, currentMessageSteps, state, sharedDialogs, interactionStates, type RpcEventDetail, type RunningCompaction, type CompactionResult } from './app-state.js';
import { inputContexts, inputContextOf, unsentInput, restoreUnsentInput, renderQueuedMessages, settlePrompt, reconcileAcceptedPrompt, abortState, focusComposer, captureCommandTarget } from './composer.js';
import { closeSharedDialog, renderAgentList } from './live-views.js';
import { setStatusMessage, treeViewController, messagesContainer, messageRenderer, toolCardRenderer, assistantBlocks, sessionStatsCard, dialogHandler, clearResolvedDialog } from './app-main.js';
import type { AppEvent, AppMessage, AssistantStep, InteractionState, MessageContentBlock } from './app-types.js';
import { scrollToBottom, showTypingIndicator, hideCompactButton, updateUI, updateContextPill, showNewMessageBadge } from './session-view.js';
import { renderCompactionRow, formatElapsed, type SummaryRetry, type CompactionRowState } from './compaction-row.js';
import { messageImages } from './history-render.js';
import type { ToolResult } from './tool-card.js';
import type { DialogRequest } from './dialogs.js';

// ═══════════════════════════════════════
// RPC event handlers
// ═══════════════════════════════════════

/** Route one Pi RPC event from the socket to its view, or to the viewed conversation. */
export function onRpcEvent(e: Event) {
  const detail = (e as CustomEvent<RpcEventDetail>).detail || {};
  const event = (detail.event || detail) as AppEvent;
  const sessionId = detail.sessionId;
  if (sessionId && event.type === 'pimux_editor_text' && typeof event.text === 'string') {
    const session = app.liveSessions.find(session => session.id === sessionId);
    if (!session) return;
    const context = inputContexts.get(sessionId) || inputContextOf(session);
    const agentId = session.attached?.muxId || session.id;
    const noticeId = typeof event.noticeId === 'number' ? event.noticeId : undefined;
    if (noticeId !== undefined && noticeId <= (editorNoticeIds.get(agentId) || 0)) return;
    if (noticeId !== undefined) editorNoticeIds.set(agentId, noticeId);
    unsentInput.keep({ agentId: context.agentId, file: typeof event.sessionFile === 'string' ? event.sessionFile : null, leafId: undefined, runtimeContext: null }, { text: event.text, images: [] });
    restoreUnsentInput();
    return;
  }
  // pimux closes a shared dialog however it ended, in every browser.
  if (sessionId && event.type === 'pimux_dialog_closed') {
    closeSharedDialog(sessionId, String(event.id));
    return;
  }
  if (sessionId && event.type === 'shared_queue_cleared') {
    piQueues.set(sessionId, { steering: [], followUp: [] });
    if (sessionId === app.activeLiveSessionId) renderQueuedMessages();
    return; // The broadcast never returns the requester's recovered text to other clients.
  }
  if (sessionId && event.type === 'pimux_session_changed' && sessionId === app.activeLiveSessionId && app.viewingActiveSession) {
    setStatusMessage('The shared session moved to another conversation', 4000);
  }
  if (event.type === 'response' && typeof event.id === 'string') settlePrompt(event.id, event.success !== false, event.error);
  if (sessionId) {
    sessionStateRevisions.set(sessionId, (sessionStateRevisions.get(sessionId) || 0) + 1);
    const session = app.liveSessions.find(s => s.id === sessionId);
    if (event.type === 'agent_start') {
      operationRevisions.set(sessionId, (operationRevisions.get(sessionId) || 0) + 1);
      const queued = queuedPrompts.get(sessionId);
      if (queued) {
        queued.started = true;
        if (queued.uncertain) void reconcileAcceptedPrompt(sessionId, queued);
      }
    }
    if (event.type === 'agent_settled') {
      queuedPrompts.delete(sessionId);
      renderQueuedMessages();
      if (abortState(sessionId) === 'stopping') settledWhileStopping.add(sessionId);
      localAbortStates.delete(sessionId);
    }
    if (event.type === 'compaction_start') {
      compactRequests.delete(sessionId);
      compactionStarts.set(sessionId, (compactionStarts.get(sessionId) || 0) + 1);
    }
    if (session) {
      session.lastActiveAt = new Date().toISOString();
      if (event.type === 'agent_start' || event.type === 'turn_start') session.isStreaming = true;
      if (event.type === 'agent_settled') session.isStreaming = false;
      if (event.type === 'compaction_start') {
        session.compaction = { reason: String(event.reason || 'manual'), startedAt: Date.now() };
        // A reply can compact before agent_start; only agent_settled ends it.
        if (event.reason === 'threshold' || event.reason === 'overflow') session.isStreaming = true;
      }
      if (event.type === 'compaction_end') session.compaction = null;
      if (event.type === 'agent_start' || event.type === 'turn_start' || event.type === 'agent_settled') {
        // Keep an open tree modal honest: disable its rows while the turn
        // runs, and refetch the tree (re-enabling the rows) when it ends.
        treeViewController.notifyStreamingChanged(sessionId, !!session.isStreaming);
      }
      if (event.type === 'session_name' && event.name) session.sessionName = event.name;
      if (event.type === 'queue_update') {
        piQueues.set(sessionId, { steering: (event.steering as string[]) ?? [], followUp: (event.followUp as string[]) ?? [] });
        if (sessionId === app.activeLiveSessionId) renderQueuedMessages();
      }
      if ((event.message as AppMessage)?.role === 'assistant' && (event.message as AppMessage)?.usage) session.contextUsage = { ...(session.contextUsage || {}), usage: (event.message as AppMessage).usage };
      renderAgentList();
    }
    if (sessionId !== app.activeLiveSessionId || !app.viewingActiveSession) {
      if (event.type === 'extension_ui_request' && !DISPLAY_UI_METHODS.has(String(event.method))) queueExtensionUIRequest(event, sessionId);
      return;
    }
  }
  handleRPCEvent(event, sessionId);
}

export function clearRetryStatus() {
  app.retryStatusElement?.remove();
  app.retryStatusElement = null;
}

function showRetryStatus(event: AppEvent) {
  clearRetryStatus();
  const attempt = event.attempt ?? 1;
  const maxAttempts = event.maxAttempts ?? attempt;
  const delaySeconds = Math.max(1, Math.ceil((event.delayMs ?? 0) / 1000));
  const detail = event.errorMessage ? `\n${event.errorMessage}` : '';
  const element = document.createElement('div');
  element.className = 'system-message retry-message';
  element.textContent = `⚠️ Request failed. Retrying in ${delaySeconds}s (attempt ${attempt}/${maxAttempts})…${detail}`;
  messagesContainer.appendChild(element);
  app.retryStatusElement = element;
  messageRenderer.scrollToBottom();
}

function flushPendingAssistantError() {
  const pending = app.pendingAssistantError;
  app.pendingAssistantError = null;
  if (!pending) return;
  // A snapshot might already have rendered this error from session history.
  const lastBlock = messagesContainer.lastElementChild;
  const alreadyShown = lastBlock?.classList.contains('assistant-block') &&
    Array.from(lastBlock.querySelectorAll('.message-error-detail'))
      .some(element => element.textContent === pending.errorMessage);
  if (!alreadyShown) {
    appendLiveActivity(messageRenderer.renderAssistantError(pending.errorMessage), 'error');
    messageRenderer.scrollToBottom();
  }
}

function handleAutoRetryStart(event: AppEvent) {
  // Keep partial steps, but never materialize a provisional provider error
  // (or an empty assistant bubble) while Pi is still retrying.
  app.pendingAssistantError = null;
  showRetryStatus(event);
}

function handleAutoRetryEnd(event: AppEvent) {
  clearRetryStatus();
  // "Retry cancelled" is the user stopping the retry, not a provider failure.
  const finalError = event.success === false && event.finalError !== 'Retry cancelled'
    ? event.finalError
    : undefined;
  if (finalError && !app.pendingAssistantError) {
    app.pendingAssistantError = { errorMessage: finalError };
  }
}

function handleRPCEvent(event: AppEvent, sessionId: string | null = null) {
  if (event.parentToolCallId !== undefined && (
    event.type === 'tool_execution_start' ||
    event.type === 'tool_execution_update' ||
    event.type === 'tool_execution_end'
  )) {
    toolCardRenderer.observeNestedCall(event);
    return;
  }

  switch (event.type) {
    case 'agent_start':
      app.pendingAssistantError = null;
      clearRetryStatus();
      handleAgentStart();
      break;
    case 'turn_start':
      handleAgentStart();
      break;
    case 'agent_end':
      // Reply rendering can finish before Pi's end hooks release input.
      assistantBlocks.setWorking(false);
      messageRenderer.scrollToBottom();
      break;
    case 'agent_settled':
      handleAgentSettled();
      break;
    case 'message_start':
      handleMessageStart(event.message as AppMessage);
      break;
    case 'message_update':
      handleMessageUpdate(event);
      break;
    case 'message_end':
      handleMessageEnd(event.message as AppMessage);
      break;
    case 'auto_retry_start':
      handleAutoRetryStart(event);
      break;
    case 'auto_retry_end':
      handleAutoRetryEnd(event);
      break;
    case 'tool_execution_start':
      handleToolExecutionStart(event);
      break;
    case 'tool_execution_update':
      handleToolExecutionUpdate(event);
      break;
    case 'tool_execution_end':
      handleToolExecutionEnd(event);
      break;
    case 'compaction_start':
      handleCompactionStart(event);
      break;
    case 'compaction_end':
      handleCompactionEnd(event);
      break;
    case 'summarization_retry_scheduled':
      handleSummaryRetryScheduled(event);
      break;
    case 'summarization_retry_attempt_start':
      handleSummaryRetryAttemptStart();
      break;
    case 'extension_ui_request':
      if (sessionId && DIALOG_METHODS.has(String(event.method))) {
        queueExtensionUIRequest(event, sessionId);
        processQueuedExtensionUIRequest(sessionId);
      } else handleExtensionUIRequest(event, sessionId);
      break;
    case 'extension_error':
      messageRenderer.renderError(`Extension error: ${event.error}`);
      break;
    case 'session_name':
      // Auto-title: the header names the shown agent.
      updateUI();
      break;
  }
}

function stopCompactionElapsedTimer() {
  if (app.compactionElapsedTimer !== null) clearInterval(app.compactionElapsedTimer);
  app.compactionElapsedTimer = null;
}

/** Forget the running row. Callers that clear the transcript also drop it. */
export function resetCompactionRow() {
  stopCompactionElapsedTimer();
  app.compactionRow = null;
}

/** Draw the running row at the end of the transcript, replacing an earlier one. */
export function showRunningCompaction(reason: string, startedAt: number) {
  assistantBlocks.boundary();
  currentMessageSteps.clear();
  const state: RunningCompaction = { status: 'running', reason, startedAt };
  const element = app.compactionRow?.element.isConnected ? app.compactionRow.element : document.createElement('div');
  messageRenderer.removeWelcome();
  renderCompactionRow(state, element);
  messagesContainer.appendChild(element);
  app.compactionRow = { element, state };
  stopCompactionElapsedTimer();
  // Show how long it has been running, so a slow compaction does not look stuck.
  app.compactionElapsedTimer = setInterval(() => {
    const elapsed = app.compactionRow?.element.querySelector('.compaction-elapsed');
    if (!app.compactionRow?.element.isConnected || !elapsed) return stopCompactionElapsedTimer();
    elapsed.textContent = formatElapsed(Date.now() - startedAt);
  }, 1000);
  scrollToBottom();
}

function updateRunningCompaction(retry: SummaryRetry) {
  if (!app.compactionRow?.element.isConnected) return;
  app.compactionRow.state = { ...app.compactionRow.state, retry };
  renderCompactionRow(app.compactionRow.state, app.compactionRow.element);
}

function handleCompactionStart(event: AppEvent) {
  // A reply can compact before agent_start. Keep its queue waiting until
  // agent_settled, not just until the compaction finishes.
  if (event.reason === 'threshold' || event.reason === 'overflow') {
    state.setStreaming(true);
    showTypingIndicator(true);
  }
  hideCompactButton();
  showRunningCompaction(String(event.reason || 'manual'), Date.now());
  updateUI();
}

function handleSummaryRetryScheduled(event: AppEvent) {
  updateRunningCompaction({
    attempt: Number(event.attempt) || 1,
    maxAttempts: Number(event.maxAttempts) || Number(event.attempt) || 1,
    delayMs: Number(event.delayMs) || 0,
  });
}

function handleSummaryRetryAttemptStart() {
  const retry = app.compactionRow?.state.retry;
  if (retry) updateRunningCompaction({ ...retry, started: true });
}

function handleCompactionEnd(event: AppEvent) {
  const result = event.result as CompactionResult | undefined;
  let finished: CompactionRowState;
  if (result && event.aborted !== true) {
    finished = {
      status: 'done',
      summary: typeof result.summary === 'string' ? result.summary : '',
      tokensBefore: result.tokensBefore,
      estimatedTokensAfter: result.estimatedTokensAfter,
      willRetry: event.willRetry === true,
    };
  } else if (event.aborted === true) {
    finished = { status: 'cancelled' };
  } else {
    finished = { status: 'failed', errorMessage: typeof event.errorMessage === 'string' ? event.errorMessage : undefined };
  }
  // A browser attaching during compaction has no running row or boundary.
  const element = app.compactionRow?.element.isConnected ? app.compactionRow.element : null;
  resetCompactionRow();
  if (!element) {
    assistantBlocks.boundary();
    currentMessageSteps.clear();
  }
  const row = renderCompactionRow(finished, element ?? undefined);
  if (!element) messagesContainer.appendChild(row);
  messageRenderer.scrollToBottom();
  if (finished.status === 'done') {
    // Usage from before the compaction no longer describes the context.
    // Show Pi's estimate until the next reply reports real usage.
    const estimate = typeof result?.estimatedTokensAfter === 'number' ? result.estimatedTokensAfter : 0;
    app.lastInputTokens = estimate;
    app.contextTokensEstimated = estimate > 0;
  }
  updateContextPill();
  updateUI();
  void sessionStatsCard.refresh();
}

function handleAgentStart() {
  assistantBlocks.setWorking(true);
  state.setStreaming(true);
  showTypingIndicator(true);
  updateUI();
}

function handleAgentSettled() {
  toolCardRenderer.settleNestedCalls();
  const wasStreaming = state.isStreaming;
  clearRetryStatus();
  flushPendingAssistantError();
  state.setStreaming(false);
  showTypingIndicator(false);
  currentMessageSteps.clear();
  assistantBlocks.setWorking(false);
  messageRenderer.scrollToBottom();
  updateUI();

  // Pi has finished its end hooks, compaction and queued continuations.
  // Neither turn_end nor agent_end establishes idle. Fetch post-operation
  // stats only after agent_settled.
  if (wasStreaming) void sessionStatsCard.refresh();

  // Notify via tab title if unfocused, once per completed operation.
  if (wasStreaming && !app.hasFocus) {
    app.unreadCount++;
    document.title = `(${app.unreadCount}) ● ${app.originalTitle}`;

  }
}

function rememberToolDefinitions(message: AppMessage) {
  if (message?.role !== 'assistant' || !Array.isArray(message.content)) return;
  for (const block of message.content) {
    if (block.type === 'toolCall' && block.id) {
      toolCardRenderer.rememberRoot({ toolCallId: block.id, toolName: block.name, args: block.arguments });
    }
  }
}

function handleMessageStart(message: AppMessage) {
  rememberToolDefinitions(message);
  if (message.role === 'assistant') {
    app.pendingAssistantError = null;
    clearRetryStatus();
    currentMessageSteps.clear();
  } else if (message.role === 'user') {
    assistantBlocks.boundary();
    // The prompt is already drawn locally when sent.
    if (!app.lastSentMessage || getMessageText(message) !== app.lastSentMessage) {
      const content = getMessageText(message);
      const images = messageImages(message);
      if (content || images.length) messageRenderer.renderUserMessage({ content, images });
    }
    app.lastSentMessage = null;
  }
}

function getMessageText(message: AppMessage) {
  if (typeof message.content === 'string') return message.content;
  return (message.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
}

function nextMessageStep(index: number) {
  let next: HTMLElement | null = null;
  let position = Infinity;
  for (const [candidate, element] of currentMessageSteps) {
    if (candidate > index && candidate < position) {
      next = element;
      position = candidate;
    }
  }
  return next;
}

function updateMessageStep(index: number, step: AssistantStep, streaming: boolean) {
  let element = currentMessageSteps.get(index);
  if (!element) {
    element = messageRenderer.renderAssistantStep(step, streaming);
    // message_end supplies blocks missed when this browser joined mid-message.
    appendLiveActivity(element, step.type, nextMessageStep(index));
    currentMessageSteps.set(index, element);
    if (streaming) messageRenderer.scrollToBottom();
  } else if (streaming) {
    messageRenderer.queueAssistantStep(element, step.text);
  } else {
    messageRenderer.updateAssistantStep(element, step.text);
  }
}

function handleMessageUpdate(event: AppEvent) {
  if (typeof event.message === 'object') rememberToolDefinitions(event.message);
  const update = event.assistantMessageEvent;
  if (!update) return;
  const index = update.contentIndex;
  if (index === undefined) return;
  const type = update.type;
  if (type !== 'thinking_start' && type !== 'thinking_delta' && type !== 'text_start' && type !== 'text_delta') return;
  const kind = type.startsWith('thinking') ? 'thinking' : 'text';
  const block = update.partial?.content?.[index];
  const element = currentMessageSteps.get(index);
  const previous = element ? messageRenderer.assistantStepText(element) : '';
  const text = block && typeof block !== 'string'
    ? (kind === 'thinking' ? block.thinking : block.text) || ''
    : previous + (update.delta || '');
  updateMessageStep(index, { type: kind, text }, true);
}

function appendLiveActivity(element: HTMLElement, label: string, before: HTMLElement | null = null) {
  assistantBlocks.append(element, label, before);
  // Once a history block receives live content its height must not be deferred.
  element.closest('.assistant-block')?.classList.remove('history');
}

function ensureToolCard(toolCallId: string, toolName: string, args: Record<string, unknown> = {}, before: HTMLElement | null = null) {
  let card = toolCardRenderer.toolCards.get(toolCallId);
  if (!card) {
    card = toolCardRenderer.createToolCard({ toolCallId, toolName, args, status: 'pending' }, document.createDocumentFragment());
    appendLiveActivity(card, toolName, before);
  }
  card.classList.remove('history');
  card.closest('.assistant-block')?.classList.remove('history');
  return card;
}

function handleMessageEnd(message: AppMessage) {
  if (message?.role === 'toolResult') {
    if (message.toolCallId) {
      const card = toolCardRenderer.reconcileToolResult(message.toolCallId, {
        content: typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content || [],
        nestedCalls: message.nestedCalls,
      }, message.isError ?? false);
      if (card?.parentElement === messagesContainer) {
        appendLiveActivity(card, card.querySelector('.tool-name')?.textContent || 'tool');
      }
    }
    return;
  }
  if (message?.role !== 'assistant') return;
  rememberToolDefinitions(message);
  const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content || [];
  blocks.forEach((block, index) => {
    if (block.type === 'text' || block.type === 'thinking') {
      updateMessageStep(index, {
        type: block.type, text: block.type === 'thinking' ? block.thinking || '' : block.text || '',
      }, false);
    } else if (block.type === 'toolCall') {
      const card = ensureToolCard(block.id || '', block.name || '', block.arguments, nextMessageStep(index));
      currentMessageSteps.set(index, card);
    }
  });
  currentMessageSteps.clear();

  const usage = message.usage;
  if (usage?.cost?.total) app.sessionTotalCost += usage.cost.total;
  if (usage?.input) {
    app.lastInputTokens = usage.input + (usage.cacheRead || 0);
    app.contextTokensEstimated = false;
    app.lastUsage = usage;
  }
  updateContextPill();
  showNewMessageBadge();
  // Keep failures provisional until Pi's authoritative operation settles.
  app.pendingAssistantError = message.stopReason === 'error'
    ? { errorMessage: message.errorMessage || 'Request failed' } : null;
}

function handleToolExecutionStart(event: AppEvent) {
  const { toolCallId, toolName, args } = event;
  if (!toolCallId) return;
  ensureToolCard(toolCallId, toolName || '', args);
  toolCardRenderer.updateToolCard({ toolCallId, status: 'pending' });
  messageRenderer.scrollToBottom();
}

function handleToolExecutionUpdate(event: AppEvent) {
  if (!event.toolCallId) return;
  ensureToolCard(event.toolCallId, event.toolName || '', event.args);
  toolCardRenderer.updateToolCard({
    toolCallId: event.toolCallId, status: 'streaming', output: formatToolOutput(event.partialResult),
  });
  messageRenderer.scrollToBottom();
}

function handleToolExecutionEnd(event: AppEvent) {
  if (!event.toolCallId) return;
  ensureToolCard(event.toolCallId, event.toolName || '', event.args);
  toolCardRenderer.finalizeToolCard(event.toolCallId, event.result as ToolResult, event.isError ?? false);
}

export function pendingInteractionCount(sessionId: string) {
  const session = app.liveSessions.find(session => session.id === sessionId);
  return session?.attached ? sharedDialogs.get(sessionId)?.size || 0 : session?.pendingInteractionCount || 0;
}

export function reconcileInteractionState(next: InteractionState) {
  const session = app.liveSessions.find(session => session.id === next.sessionId);
  if (!session || session.attached) return;
  const current = interactionStates.get(next.sessionId);
  // HTTP snapshots and WebSocket updates can cross in flight. In particular,
  // an older snapshot must never recreate a request another client answered.
  if (current && next.interactionRevision <= current.interactionRevision) return;
  interactionStates.set(next.sessionId, next);
  const visible = dialogHandler.currentRequest;
  const restoreFocus = visible?.sessionId === next.sessionId && !next.pendingDialogs.some(request => request.id === visible.id)
    ? clearResolvedDialog() : false;
  processQueuedExtensionUIRequest(next.sessionId);
  renderAgentList();
  if (restoreFocus && app.viewingActiveSession && next.sessionId === app.activeLiveSessionId) focusComposer();
}

function queueExtensionUIRequest(event: AppEvent, sessionId: string) {
  if (app.liveSessions.find(session => session.id === sessionId)?.attached && DIALOG_METHODS.has(String(event.method))) {
    if (typeof event.id !== 'string') return;
    let dialogs = sharedDialogs.get(sessionId);
    if (!dialogs) sharedDialogs.set(sessionId, dialogs = new Map());
    dialogs.set(event.id, event);
    renderAgentList();
    if (app.viewingActiveSession && app.activeLiveSessionId === sessionId) updateUI();
    return;
  }
  // Native response-bearing requests arrive only through Tau's full registry.
  // Preserve background-view transient notifications for both transports.
  if (event.method !== 'notify') return;
  if (!app.pendingExtensionUIRequests.some(req => req.sessionId === sessionId && req.event.id === event.id)) {
    app.pendingExtensionUIRequests.push({ sessionId, event });
  }
}

export function processQueuedExtensionUIRequest(sessionId = app.activeLiveSessionId) {
  if (!sessionId || !app.viewingActiveSession || sessionId !== app.activeLiveSessionId) return;
  const notifications = app.pendingExtensionUIRequests.filter(request => request.sessionId === sessionId);
  app.pendingExtensionUIRequests = app.pendingExtensionUIRequests.filter(request => request.sessionId !== sessionId);
  for (const { event } of notifications) handleExtensionUIRequest(event, sessionId);
  if (dialogHandler.currentRequest) return;
  const shared = app.liveSessions.find(session => session.id === sessionId)?.attached;
  const request = shared ? sharedDialogs.get(sessionId)?.values().next().value
    : interactionStates.get(sessionId)?.pendingDialogs.find(request => request.expiresAt === undefined || request.expiresAt > Date.now());
  if (request) handleExtensionUIRequest(request, sessionId);
}

export function suspendCurrentDialogForViewSwitch(nextSessionId: string) {
  const current = dialogHandler.currentRequest;
  if (!current?.sessionId || current.sessionId === nextSessionId) return;
  // The request remains in its session's registry, including its deadline.
  dialogHandler.clearCurrentDialog();
}

function handleExtensionUIRequest(event: AppEvent, sessionId: string | null = null) {
  // One dialog shows at a time. Its membership stays with its authoritative
  // registry even while visible, or while the transport accepts an answer.
  const current = dialogHandler.currentRequest;
  if (sessionId && current && DIALOG_METHODS.has(String(event.method))) {
    if (current.sessionId !== sessionId || current.id !== event.id) queueExtensionUIRequest(event, sessionId);
    return;
  }
  const target = sessionId ? captureCommandTarget(sessionId) : null;
  const request = (sessionId ? { ...event, sessionId, inputContext: target?.inputContext ?? null } : event) as DialogRequest;
  // A shared request stays a member until mux closes it or replaces its
  // snapshot. Native requests still use Tau's original absolute expiry.
  if (sessionId && app.liveSessions.find(session => session.id === sessionId)?.attached) delete request.expiresAt;
  switch (event.method) {
    case 'select':
      dialogHandler.showSelect(request);
      break;
    case 'confirm':
      dialogHandler.showConfirm(request);
      break;
    case 'input':
      dialogHandler.showInput(request);
      break;
    case 'editor':
      dialogHandler.showEditor(request);
      break;
    case 'notify':
      dialogHandler.showNotification(request);
      break;
    default:
      if (!DISPLAY_UI_METHODS.has(String(event.method))) console.warn('[App] Unknown extension UI method:', event.method);
  }
}

function formatToolOutput(result: unknown) {
  if (!result) return '';

  const r = result as { content?: MessageContentBlock[] };
  if (r.content && Array.isArray(r.content)) {
    return r.content
      .map((block) => {
        if (block.type === 'text') return block.text;
        return JSON.stringify(block);
      })
      .join('\n');
  }

  return JSON.stringify(result, null, 2);
}
