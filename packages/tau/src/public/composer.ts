// Composer: attachments, sending, queues, input contexts and the command controllers.

import type { PendingImage, LiveSession, QueuedCommand, RpcCommand } from './app-types.js';
import { app, queuedPrompts, state, compactRequests, compactionStarts, piQueues, localAbortStates, settledWhileStopping, abortRequests, operationRevisions, type QueuedDispatch } from './app-state.js';
import { copyInputContext, sameContext, UnsentInputStore, runtimeInputContext, type InputContext, type CommandTarget, type UnsentInput } from './unsent-input.js';
import { messageInput, beginViewSelection, treeViewController, modelPickerController, flashStatusError, wsClient, messageRenderer, setStatusMessage, assistantBlocks, messagesContainer, toolCardRenderer, isMobile, dialogHandler } from './app-main.js';
import { closePending, updateLiveSessionInputState, renderAgentList, clearSharedQueue, rememberOpenedSession, selectLiveSession } from './live-views.js';
import { parseCompactCommand } from './compact-command.js';
import { hideCompactButton, updateUI, updateContextPill, showTypingIndicator } from './session-view.js';
import { pendingInteractionCount } from './rpc-events.js';

const imagePreviews = document.getElementById('image-previews')!;

let pendingImages: PendingImage[] = [];     // { data: base64, mimeType }

const MAX_IMAGE_DIM = 2048;
const VALID_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

function processImageFile(file: File): Promise<PendingImage> {
  return new Promise((resolve, reject) => {
    const mimeType = VALID_MIME_TYPES.includes(file.type) ? file.type : 'image/png';

    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > MAX_IMAGE_DIM || height > MAX_IMAGE_DIM) {
          const scale = MAX_IMAGE_DIM / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d')?.drawImage(img, 0, 0, width, height);

        const outputMime = (mimeType === 'image/jpeg') ? 'image/jpeg' : 'image/png';
        const quality = (outputMime === 'image/jpeg') ? 0.85 : undefined;
        const dataUrl = canvas.toDataURL(outputMime, quality);
        const base64 = dataUrl.split(',')[1];
        if (!base64) { reject(new Error('Failed to encode image')); return; }
        resolve({ data: base64, mimeType: outputMime });
      };
      img.onerror = () => reject(new Error('Failed to decode image'));
      img.src = String(reader.result || '');
    };
    reader.readAsDataURL(file);
  });
}

export async function addAttachments(files: FileList | File[]) {
  const context = app.composerContext ? copyInputContext(app.composerContext) : null;
  const selection = app.viewSelection;
  const list = Array.from(files);            // snapshot before any await
  for (const file of list) {
    if (!file.type.startsWith('image/')) continue;
    try {
      const image = await processImageFile(file);
      if (context && (selection !== app.viewSelection || !sameContext(context, app.composerContext))) {
        unsentInput.keep(context, { text: '', images: [image] });
        restoreUnsentInput();
      } else if (context) pendingImages.push(image);
    } catch (e) {
      console.error('[Tau] Image processing failed:', e);
    }
  }
  renderAttachmentPreviews();
}

function makeRemoveBtn(onClick: () => void) {
  const btn = document.createElement('button');
  btn.className = 'image-preview-remove';
  btn.setAttribute('aria-label', 'Remove');
  btn.textContent = '✕';
  btn.addEventListener('click', onClick);
  return btn;
}

export function renderAttachmentPreviews() {
  imagePreviews.innerHTML = '';
  const hasAny = pendingImages.length > 0;
  if (!hasAny) { imagePreviews.classList.add('hidden'); return; }
  imagePreviews.classList.remove('hidden');

  // Binary image chips
  pendingImages.forEach((img, i) => {
    const el = document.createElement('div');
    el.className = 'image-preview';
    const thumb = document.createElement('img');
    thumb.src = `data:${img.mimeType};base64,${img.data}`;
    el.appendChild(thumb);
    el.appendChild(makeRemoveBtn(() => { pendingImages.splice(i, 1); renderAttachmentPreviews(); }));
    imagePreviews.appendChild(el);
  });

}
export const unsentInput = new UnsentInputStore();
export const inputContexts = new Map<string, InputContext>();
export const recoveredInputEl = document.createElement('section');

export function inputContextOf(session: LiveSession): InputContext {
  return { agentId: session.attached?.muxId || session.id, file: session.sessionFile ?? null,
    leafId: session.leafId, runtimeContext: runtimeInputContext(session.runtimeContext) };
}

export function commandContextIsCurrent(sessionId: string, context: InputContext): boolean {
  const session = app.liveSessions.find(session => session.id === sessionId);
  return !!session && session.inputReady === true && !!runtimeInputContext(context.runtimeContext)
    && sameContext(context, inputContextOf(session));
}

/** Capture once, before any await; delayed actions must keep this exact target. */
export function captureCommandTarget(sessionId = app.activeLiveSessionId): CommandTarget | null {
  const session = app.liveSessions.find(session => session.id === sessionId);
  if (!session || session.inputReady !== true) return null;
  const inputContext = inputContextOf(session);
  if (!inputContext.runtimeContext || inputContext.runtimeContext.sessionFile !== inputContext.file) return null;
  return { sessionId: session.id, inputContext: copyInputContext(inputContext) };
}

export function bindComposerContext(context: InputContext | null) {
  if (sameContext(app.composerContext, context)) return;
  // Browser-restored form text can precede the first authoritative identity.
  const origin = app.composerContext || { agentId: null, file: null, leafId: undefined, runtimeContext: null };
  unsentInput.keep(origin, { text: messageInput.value, images: pendingImages });
  app.voiceInput?.cancel();
  messageInput.value = '';
  messageInput.style.height = 'auto';
  pendingImages = [];
  app.composerContext = context;
  renderAttachmentPreviews();
  restoreUnsentInput();
}

/** Metadata and exact snapshots, not a mux's lifetime, own the conversation identity. */
export function observeInputContext(session: LiveSession) {
  const previous = inputContexts.get(session.id), next = inputContextOf(session);
  // Snapshot reconstruction temporarily withdraws input readiness, not the
  // selected conversation. Its later live boundary must finish the same open.
  if (previous?.runtimeContext && !next.runtimeContext && previous.agentId === next.agentId && previous.file === next.file) return;
  if (previous && !sameContext(previous, next)) {
    keepUnsentInput(session, previous);
    if (session.id === app.activeLiveSessionId && app.viewingActiveSession) {
      beginViewSelection(false);
      treeViewController.closeIfOpen();
      modelPickerController.closeIfOpen();
      bindComposerContext(next);
    }
  }
  inputContexts.set(session.id, next);
}

function putInComposer(input: UnsentInput | null) {
  if (!input) return;
  messageInput.value = [input.text, messageInput.value].filter(Boolean).join('\n\n');
  pendingImages.push(...input.images);
  messageInput.dispatchEvent(new Event('input'));
  renderAttachmentPreviews();
}

/** Recovery is an explicit choice, even after reconnecting to the same agent. */
export function restoreUnsentInput() {
  recoveredInputEl.innerHTML = '';
  for (const { context, input } of unsentInput.entries()) {
    const row = document.createElement('div');
    row.className = 'queued-msg';
    const origin = `${context.file || 'Unknown/new conversation'} · leaf ${context.leafId === undefined ? 'unknown' : context.leafId || 'root'} · ${context.agentId || 'unknown agent'}`;
    row.title = `${origin}. Review before sending; delivery may have been uncertain.`;
    const label = document.createElement('span');
    label.className = 'queued-msg-label';
    label.textContent = 'Kept for review; not resent';
    const text = document.createElement('span');
    text.className = 'queued-msg-text';
    text.textContent = `${origin}: ${input.text || '(attachments)'}`;
    const reuse = document.createElement('button');
    reuse.type = 'button';
    reuse.textContent = 'Reuse';
    reuse.disabled = !app.viewingActiveSession || !app.composerContext;
    reuse.addEventListener('click', () => {
      if (!app.viewingActiveSession || !app.composerContext) return;
      if (!sameContext(context, app.composerContext) && !confirm(`Reuse input from ${origin} in the currently selected conversation? Review it before sending.`)) return;
      putInComposer(unsentInput.take(context));
      restoreUnsentInput();
      focusComposer();
    });
    const discard = document.createElement('button');
    discard.type = 'button';
    discard.textContent = 'Discard';
    discard.addEventListener('click', () => { unsentInput.take(context); restoreUnsentInput(); });
    row.append(label, text, reuse, discard);
    recoveredInputEl.appendChild(row);
  }
  recoveredInputEl.classList.toggle('hidden', !recoveredInputEl.children.length);
}

/** Disconnects and context replacements preserve local input without replay or retargeting. */
export function keepUnsentInput(session: LiveSession, context = inputContexts.get(session.id) || inputContextOf(session)) {
  unsentInput.keepInFlight(context);
  for (const command of app.messageQueue.filter(command => command.sessionId === session.id)) {
    unsentInput.keep(command.inputContext || context, { text: command.message || '', images: command.images || [] });
  }
  app.messageQueue = app.messageQueue.filter(command => command.sessionId !== session.id);
  const dispatch = queuedPrompts.get(session.id);
  if (dispatch) {
    clearTimeout(dispatch.retryTimer);
    if (!dispatch.accepted && !dispatch.started) {
      unsentInput.keep(dispatch.command.inputContext || context, { text: dispatch.command.message || '', images: dispatch.command.images || [] });
    }
    queuedPrompts.delete(session.id);
  }
  if (session.id === app.activeLiveSessionId && sameContext(app.composerContext, context)) bindComposerContext(null);
  restoreUnsentInput();
}

export function settlePrompt(id: string, delivered: boolean, error?: unknown) {
  if (!unsentInput.settle(id, delivered)) return;
  flashStatusError(String(error || 'Pi did not get your message.'), 5000);
  restoreUnsentInput();
}

export function activeViewIsShared() {
  const session = app.liveSessions.find(s => s.id === app.activeLiveSessionId);
  return !!(session?.shared || session?.attached);
}

export function activeViewCanNavigate() {
  return app.viewingActiveSession && captureCommandTarget() !== null
    && !!app.liveSessions.find(s => s.id === app.activeLiveSessionId)?.capabilities?.navigateTree;
}

export function sendMessage() {
  if (closePending()) {
    flashStatusError('This agent is being closed. Your input is still here.');
    return;
  }
  if (!app.viewingActiveSession || !app.activeLiveSessionId || !app.composerContext || !commandContextIsCurrent(app.activeLiveSessionId, app.composerContext)) {
    flashStatusError('Select a live conversation before sending. Your input is still here.');
    return;
  }
  const message = messageInput.value.trim();
  if (!message && pendingImages.length === 0) return;
  // Pi runs /compact only in its terminal UI, so Tau runs it here instead
  // of sending the text to the model.
  const compactCommand = parseCompactCommand(message);
  if (compactCommand) {
    if (pendingImages.length > 0) {
      showCompactionNote('Compaction cannot use attached images. Remove them to compact.');
      return;
    }
    // A refused /compact stays in the input so the user can send it again.
    if (requestCompaction(compactCommand.customInstructions)) {
      messageInput.value = '';
      messageInput.style.height = 'auto';
    }
    return;
  }
  if (wsClient.ws?.readyState !== WebSocket.OPEN) {
    // Keep the draft: a send now would be dropped, for instance while a phone
    // reconnects after the server restarted.
    flashStatusError('Reconnecting; your message is still here, send it again in a moment.');
    if (wsClient.ws?.readyState !== WebSocket.CONNECTING) wsClient.forceReconnect();
    return;
  }

  messageInput.value = '';
  messageInput.style.height = 'auto';

  // Another frontend sharing this Pi can start a run at any moment; Pi then
  // needs to know how to queue the prompt. It ignores this when idle.
  const cmd: QueuedCommand = { type: 'prompt', inputContext: copyInputContext(app.composerContext), message: message || '(see attached image)', streamingBehavior: 'followUp' };
  const images = pendingImages;

  if (pendingImages.length > 0) {
    cmd.images = pendingImages.map(img => {
      console.log(`[Tau] Sending image: mimeType=${img.mimeType}, dataLen=${img.data?.length}`);
      return { type: 'image', data: img.data, mimeType: img.mimeType || 'image/png' };
    });
    pendingImages = [];
  }

  renderAttachmentPreviews();

  if (!app.activeLiveSessionId) {
    messageRenderer.renderError('Select or start an agent first.');
    updateLiveSessionInputState();
    return;
  }

  cmd.sessionId = app.activeLiveSessionId;
  app.resumeQueuedInput = true;

  if (state.isStreaming && activeViewIsShared() && !sessionHasPendingWork(app.activeLiveSessionId)) {
    // The run may belong to another frontend: Pi takes this now and every
    // frontend, this one included, draws it when Pi delivers it.
    cmd.streamingBehavior = 'steer';
    setStatusMessage('Sent; Pi reads it at its next step', 3000);
    sendPrompt(cmd, { text: message, images });
    return;
  }

  if (state.isStreaming || sessionHasPendingWork(app.activeLiveSessionId)) {
    // Queue it for the shown agent only; do not let view switches retarget it.
    app.messageQueue.push(cmd);
    app.lastSentMessage = message;
    renderQueuedMessages();
    return;
  }

  app.lastSentMessage = message;
  assistantBlocks.boundary();
  messageRenderer.renderUserMessage({ content: message, images: cmd.images });
  sendPrompt(cmd, { text: message, images });
}

/** Track only input actually handed to Tau, not a still-local queued draft. */
function sendPrompt(command: QueuedCommand, input: UnsentInput) {
  if (command.inputContext) {
    command.id = crypto.randomUUID();
    unsentInput.track(command.id, command.inputContext, input);
  }
  wsClient.send(command);
}

/** A short note in the transcript. A newer note replaces the previous one. */
function showCompactionNote(text: string) {
  messagesContainer.querySelector('.compaction-refused')?.remove();
  const note = document.createElement('div');
  note.className = 'system-message compaction-refused';
  note.textContent = text;
  messagesContainer.appendChild(note);
  messageRenderer.scrollToBottom();
}

export function isCompacting(sessionId: string) {
  return compactRequests.has(sessionId) || !!app.liveSessions.find(session => session.id === sessionId)?.compaction;
}

/**
 * Ask Pi to compact the viewed view. Used by the palette, the header button
 * and `/compact`. Returns false, after showing why, when the view is busy:
 * Pi's compact would abort a running reply, and a click must never throw a
 * reply away. The transcript row is driven by Pi's compaction events.
 */
export function requestCompaction(customInstructions?: string) {
  const target = app.viewingActiveSession ? captureCommandTarget() : null;
  if (!target) {
    flashStatusError('Select a live conversation before compacting.');
    return false;
  }
  const sessionId = target.sessionId;
  if (isCompacting(sessionId)) {
    showCompactionNote('Compaction is already running.');
    return false;
  }
  if (state.isStreaming || sessionHasPendingWork(sessionId)) {
    showCompactionNote('Wait for the reply to finish, or stop it first.');
    return false;
  }
  messagesContainer.querySelector('.compaction-refused')?.remove();
  compactRequests.add(sessionId);
  hideCompactButton();
  renderAgentList();
  updateUI();
  void sendCompactRequest(target, customInstructions);
  return true;
}

// Pi answers only after compaction ends. Once Pi has started, its events
// already report the outcome, so the reply only reports a failure to start.
async function sendCompactRequest(target: CommandTarget, customInstructions?: string) {
  const { sessionId } = target;
  const startsBefore = compactionStarts.get(sessionId) || 0;
  let failure: string | null = null;
  try {
    const data = await rpcCommand({ type: 'compact', ...target, ...(customInstructions ? { customInstructions } : {}) });
    if (!data?.success && !data?.compactionStarted) failure = data?.error || 'Pi did not start compacting';
  } finally {
    compactRequests.delete(sessionId);
  }
  if (failure && (compactionStarts.get(sessionId) || 0) !== startsBefore) failure = null;
  renderAgentList();
  if (app.viewingActiveSession && app.activeLiveSessionId === sessionId) {
    if (failure) messageRenderer.renderError(`Could not compact: ${failure}`);
    updateContextPill();
    updateUI();
  }
}

const queuedMessagesEl = document.getElementById('queued-messages')!;

export function renderQueuedMessages() {
  queuedMessagesEl.innerHTML = '';
  if (!app.viewingActiveSession) {
    queuedMessagesEl.classList.add('hidden');
    return;
  }
  const uncertain = app.activeLiveSessionId ? queuedPrompts.get(app.activeLiveSessionId) : undefined;
  if (uncertain?.uncertain) {
    const el = document.createElement('div');
    el.className = 'queued-msg';
    el.innerHTML = `<span class="queued-msg-label">Delivery uncertain</span><span class="queued-msg-text">${escapeHtml(uncertain.command.message || '')}</span>`;
    el.title = 'The acknowledgement was lost. This instruction may have run. Waiting for confirmed execution or completion before sending more.';
    queuedMessagesEl.appendChild(el);
  }
  // What Pi itself is holding, from whichever frontend it came.
  const piQueue = (app.activeLiveSessionId && piQueues.get(app.activeLiveSessionId)) || { steering: [], followUp: [] };
  for (const [label, messages] of [['Steering', piQueue.steering], ['Follow-up', piQueue.followUp]] as const) {
    for (const message of messages) {
      const el = document.createElement('div');
      el.className = 'queued-msg';
      el.innerHTML = `
      <span class="queued-msg-label">${label}</span>
      <span class="queued-msg-text">${escapeHtml(message)}</span>
    `;
      queuedMessagesEl.appendChild(el);
    }
  }
  app.messageQueue.forEach((cmd, i) => {
    if (cmd.sessionId !== app.activeLiveSessionId) return;
    const el = document.createElement('div');
    el.className = 'queued-msg';
    el.innerHTML = `
      <span class="queued-msg-label">${cmd.error ? 'Not sent' : 'Queued'}</span>
      <span class="queued-msg-text">${escapeHtml(cmd.message || '')}</span>
      ${cmd.error ? '<button class="queued-msg-retry" type="button">Retry</button>' : ''}
      <button class="queued-msg-cancel" title="Cancel">×</button>
    `;
    el.title = cmd.error || '';
    el.querySelector('.queued-msg-retry')?.addEventListener('click', () => {
      delete cmd.error;
      renderQueuedMessages();
      flushQueue();
    });
    el.querySelector('.queued-msg-cancel')?.addEventListener('click', () => {
      app.messageQueue.splice(i, 1);
      renderQueuedMessages();
    });
    queuedMessagesEl.appendChild(el);
  });
  queuedMessagesEl.classList.toggle('hidden', queuedMessagesEl.children.length === 0);
  // The panel takes room from the conversation: its latest line stays in view.
  if (!app.isScrolledUp) messageRenderer.scrollToBottom();
}

export function escapeHtml(text: string) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

export function flushQueue() {
  if (!app.viewingActiveSession || !app.composerContext || !app.activeLiveSessionId || !commandContextIsCurrent(app.activeLiveSessionId, app.composerContext) || wsClient.ws?.readyState !== WebSocket.OPEN || state.isStreaming || !app.resumeQueuedInput || sessionHasPendingWork(app.activeLiveSessionId)) return;
  const idx = app.messageQueue.findIndex(cmd => cmd.sessionId === app.activeLiveSessionId);
  if (idx >= 0) {
    if (!sameContext(app.messageQueue[idx].inputContext || null, app.composerContext)) {
      const [command] = app.messageQueue.splice(idx, 1);
      if (command.inputContext) unsentInput.keep(command.inputContext, { text: command.message || '', images: command.images || [] });
      restoreUnsentInput();
      renderQueuedMessages();
      return;
    }
    if (app.messageQueue[idx].error) return; // A failed instruction needs an explicit retry or cancellation.
    const [cmd] = app.messageQueue.splice(idx, 1);
    app.lastSentMessage = cmd.message ?? null;
    assistantBlocks.boundary();
    messageRenderer.renderUserMessage({ content: cmd.message, images: cmd.images });
    renderQueuedMessages();
    // Paired settled/metadata updates may arrive before Pi starts this
    // prompt. Keep only one queued dispatch in flight for each session.
    const id = `queued_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const queued: QueuedDispatch = { id, command: cmd, started: false, accepted: false };
    queuedPrompts.set(app.activeLiveSessionId, queued);
    void dispatchQueuedPrompt(app.activeLiveSessionId, queued);
  }
}

// Dispatch over HTTP rather than the WebSocket: a closed socket drops a send
// silently, which would leave this session's queue locked with no error and
// no Retry. Only explicit rejection permits replay; a lost HTTP response can
// hide successful delivery and must preserve the dispatch lock.
async function dispatchQueuedPrompt(sessionId: string, queued: QueuedDispatch) {
  let rejected = false;
  try {
    const response = await fetch('/api/rpc', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...queued.command, id: queued.id }),
    });
    const data = await response.json();
    rejected = response.ok && data.success === false && data.delivery === 'rejected';
    if (!response.ok || !data.success) throw new Error(data.error || 'Queued instruction failed');
    if (queuedPrompts.get(sessionId) !== queued) return; // Already settled or the view closed.
    queued.accepted = true;
    // Pi acknowledges prompt acceptance before agent_start, not completion.
    // Keep the dispatch locked until settled. Slash commands may never start
    // an agent operation, so ask Pi for fresh state after acceptance instead.
    void reconcileAcceptedPrompt(sessionId, queued);
  } catch (error) {
    if (queuedPrompts.get(sessionId) !== queued) return;
    if (!rejected || queued.started) {
      queued.uncertain = true;
      renderQueuedMessages();
      // Observed execution is enough to reconcile, even without the HTTP ack.
      // Without it, idle alone cannot prove that a delayed POST will not run.
      if (queued.started) void reconcileAcceptedPrompt(sessionId, queued);
      return;
    }
    queuedPrompts.delete(sessionId);
    queued.command.error = error instanceof Error && error.message ? error.message : 'Queued instruction failed';
    app.messageQueue.unshift(queued.command);
    renderQueuedMessages();
    if (app.viewingActiveSession && app.activeLiveSessionId === sessionId) {
      messageRenderer.renderError(queued.command.error);
      updateUI();
    }
  }
}

// `afterReconnect` releases the lock even when agent_start was observed: the
// matching agent_settled may have been lost with the socket, and Pi's fresh
// idle answer is then the only completion signal this browser will get.
export async function reconcileAcceptedPrompt(sessionId: string, queued: QueuedDispatch, afterReconnect = false) {
  if (queuedPrompts.get(sessionId) !== queued) return;
  // Remember reconnects during delivery, but never treat idle as completion
  // until Pi has acknowledged the prompt or execution has been observed.
  if (afterReconnect) queued.reconcileAfterReconnect = true;
  if ((!queued.accepted && !queued.started) || queued.reconciling) return;
  clearTimeout(queued.retryTimer);
  queued.retryTimer = undefined;
  queued.reconciling = true;
  try {
    const response = await fetch('/api/rpc', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'get_state', sessionId, refresh: true }),
    });
    const data = await response.json();
    const idle = response.ok && data.success && data.data?.isStreaming === false && data.data?.isCompacting === false;
    if (idle && (queued.reconcileAfterReconnect || queued.uncertain || !queued.started) && queuedPrompts.get(sessionId) === queued) {
      queuedPrompts.delete(sessionId);
      renderQueuedMessages();
      if (app.viewingActiveSession && app.activeLiveSessionId === sessionId) {
        toolCardRenderer.settleNestedCalls();
        updateUI();
      }
    }
  } catch {
    // Without an idle acknowledgement, leave the next instruction queued.
  } finally {
    queued.reconciling = false;
    // Slash commands need not emit agent_settled, and interrupted delivery or
    // reconnects may have missed it. Retry only the read, never the prompt. The identity
    // check also makes a pending retry harmless after settlement or view close.
    if (queuedPrompts.get(sessionId) === queued && (queued.reconcileAfterReconnect || queued.uncertain || !queued.started)) {
      queued.retryTimer = setTimeout(() => void reconcileAcceptedPrompt(sessionId, queued), 1000);
    }
  }
}

export function abortState(sessionId: string) {
  return localAbortStates.get(sessionId) || app.liveSessions.find(session => session.id === sessionId)?.abortState || 'idle';
}

export function sessionHasPendingWork(sessionId: string) {
  return closePending(sessionId) || queuedPrompts.has(sessionId) || isCompacting(sessionId) || pendingInteractionCount(sessionId) > 0 || (abortState(sessionId) === 'stopping' && !settledWhileStopping.has(sessionId));
}

export function abortActiveSession() {
  if (!app.viewingActiveSession || !app.activeLiveSessionId) return;
  const sessionId = app.activeLiveSessionId;
  if (abortRequests.has(sessionId)) return;
  const session = app.liveSessions.find(session => session.id === sessionId)!;
  const shared = !!(session.shared || session.attached);
  if (shared && !confirm('Abort current work for EVERY frontend and remove ALL queued input from this agent? Returned queue text is kept for review only in this browser, never resent. The agent itself keeps running.')) return;
  const target = captureCommandTarget(sessionId);
  if (!target) return;
  const context = target.inputContext;
  if (shared) {
    keepUnsentInput(session, context);
    bindComposerContext(context);
  }
  const revision = operationRevisions.get(sessionId) || 0;
  localAbortStates.set(sessionId, 'stopping');
  settledWhileStopping.delete(sessionId);
  updateUI();
  const request = (async () => {
    try {
      // Stopping work must not wait for a queue-clear acknowledgement that may be lost.
      if (shared) void clearSharedQueue(sessionId, true);
      const response = await fetch('/api/rpc', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'abort', ...target }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || 'Pi did not acknowledge the stop');
      const session = app.liveSessions.find(session => session.id === sessionId);
      // An attached Pi acknowledges the command through mux, not through the
      // native stop-state registry. Acceptance cannot establish operation idle
      // or discard its dialogs; wait for settled/authoritative idle metadata.
      if (session?.attached) {
        if ((operationRevisions.get(sessionId) || 0) !== revision || session.isStreaming === false) {
          localAbortStates.delete(sessionId);
        }
        return;
      }
      localAbortStates.delete(sessionId);
      // A queued instruction may already have started after agent_settled.
      // This HTTP response belongs to the operation we originally stopped.
      if (session && (operationRevisions.get(sessionId) || 0) === revision) {
        session.abortState = 'idle';
        session.isStreaming = false;
        if (app.viewingActiveSession && app.activeLiveSessionId === sessionId) {
          state.setStreaming(false);
          assistantBlocks.setWorking(false);
          toolCardRenderer.settleNestedCalls();
          showTypingIndicator(false);
        }
      }
    } catch (error) {
      if (app.liveSessions.some(session => session.id === sessionId) && (operationRevisions.get(sessionId) || 0) === revision) {
        const message = error instanceof Error ? error.message : 'Could not request a stop';
        localAbortStates.set(sessionId, /timed?\s*out|timeout/i.test(message) ? 'timed_out' : 'failed');
        if (app.viewingActiveSession && app.activeLiveSessionId === sessionId) messageRenderer.renderError(`Stop was not confirmed: ${message}`);
      }
    } finally {
      abortRequests.delete(sessionId);
      if (app.viewingActiveSession && app.activeLiveSessionId === sessionId) updateUI();
    }
  })();
  abortRequests.set(sessionId, request);
}

export async function rpcCommand(cmd: RpcCommand, statusMsg = '') {
  try {
    const backendLocalCommands = new Set(['get_auth', 'set_auth', 'get_available_models']);
    const needsLiveSession = !cmd.sessionId && !cmd.filePath && !backendLocalCommands.has(cmd.type);
    if (needsLiveSession && (!app.viewingActiveSession || !app.activeLiveSessionId)) {
      const error = 'Select a live agent first.';
      setStatusMessage(error, 3000);
      return { type: 'response', command: cmd.type, success: false, error };
    }
    if (!cmd.sessionId && app.viewingActiveSession && app.activeLiveSessionId && !backendLocalCommands.has(cmd.type)) cmd = { ...cmd, sessionId: app.activeLiveSessionId };
    const readOnly = new Set(['get_state', 'get_messages', 'get_commands', 'get_session_stats', 'get_tree', 'get_entries', 'live_session_snapshot_request']);
    if (!backendLocalCommands.has(cmd.type) && !readOnly.has(cmd.type) && cmd.sessionId) {
      const target = 'inputContext' in cmd ? { sessionId: cmd.sessionId, inputContext: cmd.inputContext as InputContext }
        : captureCommandTarget(cmd.sessionId);
      if (!target?.inputContext || !commandContextIsCurrent(target.sessionId, target.inputContext)) {
        return { type: 'response', command: cmd.type, success: false, error: 'The conversation changed or is not ready. Nothing was sent.' };
      }
      cmd = { ...cmd, ...target };
    }
    if (statusMsg) setStatusMessage(statusMsg);
    const resp = await fetch('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd),
    });
    const data = await resp.json();
    if (data.success) {
      setStatusMessage('Done', 2000);
    } else {
      setStatusMessage(data.error || 'Failed', 3000);
    }
    return data;
  } catch (e) {
    setStatusMessage('Error', 3000);
  }
}

/** Root agents can start over in place; workers stay on their file. */
export function activeViewCanStartOver() {
  const session = app.liveSessions.find(s => s.id === app.activeLiveSessionId);
  return app.viewingActiveSession && !!session && captureCommandTarget(session.id) !== null && session.attached?.placement !== 'worker';
}

export async function newSharedSession() {
  const session = app.liveSessions.find(s => s.id === app.activeLiveSessionId);
  if (session?.isStreaming && !confirm('This agent is working. A new session stops that work, in every frontend. Start over?')) return;
  const data = await rpcCommand({ type: 'new_session' }, 'Starting a new session...');
  if (data?.success && data.data?.cancelled) flashStatusError('This agent refused a new session; workers stay on their session file.', 8000);
}

export async function rpcExportHtml() {
  const data = await rpcCommand({ type: 'export_html' }, 'Exporting...');
  if (data?.success && data.data?.path) {
    setStatusMessage(`Exported: ${data.data.path}`, 4000);
  }
}

/** After opening something on purpose. A phone keeps its keyboard down, and an open dialog keeps the focus. */
export function focusComposer() {
  if (!isMobile() && !dialogHandler.currentRequest) messageInput.focus();
}

/** Opening a known runtime does not depend on the overview's discovery cadence. */
export async function attachSharedAgent(muxId: string, selection = beginViewSelection()): Promise<boolean> {
  try {
    // Always ask: the server reuses a view another browser holds and restarts its release delay.
    const res = await fetch('/api/live-sessions/attach', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ muxId }),
    });
    const data = await res.json();
    if (!res.ok || data.error || !data.session || data.session.attached?.muxId !== muxId) throw new Error(data.error || 'Could not open the agent');
    rememberOpenedSession(data.session);
    const target = app.liveSessions.find(session => session.id === data.session.id);
    if (!target) throw new Error('The agent closed before its view was ready');
    // Attaching can take seconds; whatever the user opened meanwhile stays.
    if (selection !== app.viewSelection) return false;
    await selectLiveSession(target.id, true, selection);
    return selection === app.viewSelection && app.viewingActiveSession && app.activeLiveSessionId === target.id;
  } catch (error) {
    if (selection === app.viewSelection) flashStatusError(error instanceof Error ? error.message : 'Could not open the agent', 8000);
    return false;
  }
}
