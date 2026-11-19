import { runtimeEnvironment, installFakeRuntime, closeFakeRuntime, launchBrowser, listenFakeServer, liveManager } from './fake-browser-runtime.ts';
import { installBrowserRuntimePeers } from './browser-runtime-peer.ts';
import { test, before, after } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser, Page } from 'playwright';

// The real browser and Tau server communicate through protocol-2 fake sockets.
// Every view is a pimux agent's, as in production. Delayed or stale snapshot
// deliveries below are injected at the network or socket, without reaching
// into the browser's state or dialog implementation.
//
// Despite the filename, nothing here depends on the permission extension. These
// are Tau's own dialog-recovery tests: that a request arriving before a browser
// connects is restored from the snapshot, that it reaches a second browser, and
// that Abort cancels it. Every request below is emitted by hand from a fake Pi
// runtime, and titles like 'Permission required' are only a representative label
// for any extension dialog. The behaviour is generic across confirm, select,
// input and editor, so these tests keep passing with no permission extension
// installed at all. The real extension is exercised only in
// test/permission-rpc.test.ts, which explains that split in its own header.
const tmp = runtimeEnvironment.root;
const peers = installBrowserRuntimePeers();

type Command = { type: string; id?: string; [key: string]: unknown };
type PendingDialog = Command & { method: string; createdAt: number; expiresAt?: number };
let base = '';
let browser: Browser | null = null;
let browserUnavailable = '';

before(async () => {
  installFakeRuntime();
  base = await listenFakeServer();
  try {
    browser = await launchBrowser();
  } catch (e) {
    browserUnavailable = `Playwright browser unavailable (${(e as Error).message.split('\n')[0]}). Run via: npm run test:e2e`;
  }
});

after(async () => {
  if (browser) await browser.close();
  await closeFakeRuntime();
});

function skipUnlessBrowser(t: TestContext) {
  if (browser) return false;
  t.skip(browserUnavailable);
  return true;
}

async function createSession(t: TestContext) {
  const response = await fetch(`${base}/api/live-sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd: tmp }),
  });
  assert.equal(response.status, 200);
  const { session } = await response.json() as { session: { id: string } };
  const fake = peers.at(-1)!;
  t.after(async () => { await fetch(`${base}/api/live-sessions/${session.id}`, { method: 'DELETE' }); });
  return { sessionId: session.id, commands: fake.commands, emit: fake.emit, closeDialog: fake.closeDialog, nextCommand: fake.nextCommand };
}

async function openPage(t: TestContext, sessionId: string, snapshot?: object) {
  const context = await browser!.newContext({ serviceWorkers: 'block' });
  t.after(() => context.close());
  const page = await context.newPage();
  await page.clock.install();
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on('pageerror', (error: Error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'browser must not throw'));
  // Abort of a shared agent asks before stopping every frontend's work.
  page.on('dialog', dialog => { void dialog.accept(); });
  if (snapshot) {
    await page.route(`**/api/live-sessions/${sessionId}/snapshot`, async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), ...snapshot } });
    });
  }
  const snapshotResponse = page.waitForResponse((response) => response.url().endsWith(`/api/live-sessions/${sessionId}/snapshot`));
  // Each browser shows the agent its URL names.
  await page.goto(`${base}/#agent=${encodeURIComponent(muxOf(sessionId))}`);
  await (await snapshotResponse).finished();
  await page.waitForSelector(`${agentRow(sessionId)}.active`);
  await page.waitForSelector('#message-input:not([disabled])');
  return page;
}

function muxOf(sessionId: string) {
  const muxId = liveManager.get(sessionId)?.attachment?.muxId;
  assert.ok(muxId, `${sessionId} is not attached to a pimux agent`);
  return muxId;
}

/** The sidebar row of the agent a view shows. */
function agentRow(sessionId: string) {
  return `.agent-row[data-mux-id="${muxOf(sessionId)}"]`;
}

/** Dialog replies Pi received, without the conversation context pimux binds them to. */
function replies(commands: Array<Record<string, unknown>>) {
  return commands.filter(command => command.type === 'extension_ui_response').map(({ pimuxContext: _context, ...reply }) => reply);
}

function confirmRequest(id: string, extra: Partial<PendingDialog> = {}): PendingDialog {
  return { type: 'extension_ui_request', id, method: 'confirm', title: 'Permission required', message: 'Allow the disposable tool?', createdAt: Date.now(), ...extra };
}

async function expectDialog(page: Page, title = 'Permission required') {
  await page.waitForFunction((text) => document.querySelector('#dialog-container:not(.hidden) .dialog-title')?.textContent === text, title, { timeout: 5000 });
}

test('shared socket views restore the mux dialog and observe its first authoritative closure', async t => {
  if (skipUnlessBrowser(t)) return;
  const { sessionId, emit, commands } = await createSession(t);
  assert.ok(liveManager.get(sessionId)!.metadata().attached);
  emit(confirmRequest('shared-mux-dialog'));
  const first = await openPage(t, sessionId);
  const second = await openPage(t, sessionId);
  await Promise.all([expectDialog(first), expectDialog(second)]);
  await first.reload();
  await expectDialog(first);
  await second.click('#dialog-yes');
  await Promise.all([
    first.waitForSelector('#dialog-container.hidden', { state: 'attached' }),
    second.waitForSelector('#dialog-container.hidden', { state: 'attached' }),
  ]);
  assert.deepEqual(replies(commands), [
    { type: 'extension_ui_response', id: 'shared-mux-dialog', confirmed: true },
  ]);
});

test('a snapshot restores a permission request that arrived before the browser connected', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const { sessionId, emit } = await createSession(t);
  emit(confirmRequest('before-connect'));
  const page = await openPage(t, sessionId);
  await expectDialog(page);
  await page.reload();
  await expectDialog(page);
});

test('a resolved dialog stays dismissed when an older snapshot arrives and sends no cancellation', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const { sessionId, commands, emit, closeDialog } = await createSession(t);
  const request = confirmRequest('resolved');
  emit(request);
  const page = await openPage(t, sessionId);
  await expectDialog(page);
  const openedAt = liveManager.get(sessionId)!.attachment!.appliedGeneration;

  closeDialog('resolved');
  await page.waitForSelector('#dialog-container.hidden', { state: 'attached' });
  // A delayed delivery of the boundary the browser opened with still lists the request.
  liveManager.broadcast({ type: 'live_session_snapshot', sessionId, dialogs: [request], generation: openedAt });
  liveManager.broadcast({ type: 'event', sessionId, event: { type: 'extension_ui_request', method: 'notify', message: 'after the stale snapshot' } });
  // Observe the stale snapshot after it has traversed the WebSocket, rather
  // than relying on an arbitrary sleep to prove that no modal returned.
  await page.waitForFunction(() => document.getElementById('messages')?.textContent?.includes('after the stale snapshot'));
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  assert.equal(await page.locator('#dialog-container').isVisible(), false);
  assert.deepEqual(replies(commands), []);
});

test('approval status comes from metadata even when no tool is streaming', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const { sessionId, emit } = await createSession(t);
  const page = await openPage(t, sessionId);
  // Keep the real registry consistent with metadata so startup state/stats
  // probes cannot legitimately overwrite a synthetic count with zero.
  emit(confirmRequest('idle-first'));
  emit(confirmRequest('idle-second'));
  await page.waitForFunction(() => document.getElementById('status-text')?.textContent === 'Waiting for approval');
  assert.equal(await page.locator('#typing-indicator').isVisible(), false);
  assert.equal(await page.locator('#abort-btn').isVisible(), true, 'an idle extension dialog must still be abortable');
});

test('the first browser reply dismisses the same request in every browser without extra replies', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const { sessionId, commands, emit } = await createSession(t);
  const first = await openPage(t, sessionId);
  const second = await openPage(t, sessionId);
  emit(confirmRequest('two-browsers'));
  await Promise.all([expectDialog(first), expectDialog(second)]);
  await first.click('#dialog-yes');
  await Promise.all([
    first.waitForSelector('#dialog-container.hidden', { state: 'attached' }),
    second.waitForSelector('#dialog-container.hidden', { state: 'attached' }),
  ]);
  assert.deepEqual(replies(commands), [
    { type: 'extension_ui_response', id: 'two-browsers', confirmed: true },
  ]);
});

test('a delivery acknowledgement cannot resolve a dialog or let the browser submit it twice', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const { sessionId, emit, closeDialog } = await createSession(t);
  emit(confirmRequest('delivery-only'));
  const page = await openPage(t, sessionId);
  await page.route('**/api/rpc', async (route) => {
    const command = route.request().postDataJSON();
    if (command.type !== 'extension_ui_response') return route.continue();
    await route.fulfill({ json: { type: 'response', command: command.type, id: command.id, success: true, data: { delivered: true } } });
  });
  await expectDialog(page);
  await page.click('#dialog-yes');
  await page.waitForSelector('#dialog-yes:disabled');
  assert.equal(await page.locator('#dialog-container').isVisible(), true, 'only authoritative closure may dismiss the pending interaction');
  await page.waitForFunction(() => document.querySelector('.dialog-response-notice[role="status"]')?.textContent?.startsWith('Response sent.'));
  assert.equal(await page.locator('.dialog-response-error').count(), 0, 'a delivered reply is not an error');

  closeDialog('delivery-only');
  await page.waitForSelector('#dialog-container.hidden', { state: 'attached' });
});

for (const control of ['button', 'keyboard']) {
  test(`${control} Abort shows Stopping until Pi acknowledges and coalesces repeated requests`, async (t) => {
    if (skipUnlessBrowser(t)) return;
    const { sessionId, commands, emit, nextCommand } = await createSession(t);
    const page = await openPage(t, sessionId);
    emit({ type: 'agent_start' });
    await page.waitForSelector('#abort-btn:not(.hidden)');
    const abort = nextCommand('abort');
    if (control === 'button') await page.click('#abort-btn');
    else await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('status-text')?.textContent === 'Stopping…');
    const command = await abort;
    assert.equal(await page.locator('#typing-indicator').isVisible(), true);
    assert.doesNotMatch(await page.locator('#messages').innerText(), /Aborted by user/);
    await page.keyboard.press('Escape');
    assert.equal(commands.filter(command => command.type === 'abort').length, 1);
    emit({ type: 'response', command: 'abort', id: command.id, success: true });
    await page.waitForSelector('#typing-indicator.hidden', { state: 'attached' });
    await page.waitForSelector('#abort-btn.hidden', { state: 'attached' });
    assert.notEqual(await page.locator('#status-text').textContent(), 'Stopping…');
  });
}

test('a delayed HTTP snapshot cannot roll back a newer running state or approval', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const { sessionId, emit } = await createSession(t);
  const page = await openPage(t, sessionId);
  let snapshotCaptured!: () => void;
  const captured = new Promise<void>(resolve => { snapshotCaptured = resolve; });
  let releaseSnapshot!: () => void;
  const released = new Promise<void>(resolve => { releaseSnapshot = resolve; });
  await page.route(`**/api/live-sessions/${sessionId}/snapshot`, async route => {
    const response = await route.fetch();
    const snapshot = await response.json();
    snapshotCaptured();
    await released;
    await route.fulfill({ response, json: snapshot });
  });
  // Reopening the agent requests its snapshot again.
  void page.reload();
  await captured;
  emit({ type: 'agent_start' });
  emit(confirmRequest('after-snapshot'));
  await page.waitForSelector('#typing-indicator:not(.hidden)');
  await page.waitForFunction(() => document.getElementById('status-text')?.textContent === 'Waiting for approval');
  const response = page.waitForResponse(response => response.url().endsWith(`/api/live-sessions/${sessionId}/snapshot`));
  releaseSnapshot();
  await (await response).finished();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  assert.equal(await page.locator('#typing-indicator').isVisible(), true);
  assert.equal(await page.locator('#status-text').textContent(), 'Waiting for approval');
});

test('failed dialog delivery can be retried, but a late failure cannot resurrect a resolved request', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const { sessionId, emit, closeDialog } = await createSession(t);
  emit(confirmRequest('retry'));
  const page = await openPage(t, sessionId);
  let attempts = 0;
  let releaseFailure!: () => void;
  const delayedFailure = new Promise<void>(resolve => { releaseFailure = resolve; });
  await page.route('**/api/rpc', async route => {
    if (route.request().postDataJSON().type !== 'extension_ui_response') return route.continue();
    if (++attempts === 2) await delayedFailure;
    await route.fulfill({ json: { success: false, error: 'Pi stdin write failed' } });
  });
  await expectDialog(page);
  await page.click('#dialog-yes');
  await page.waitForSelector('.dialog-response-error');
  assert.equal(await page.locator('#dialog-yes').isEnabled(), true);
  assert.equal(await page.locator('#dialog-container').isVisible(), true);
  await page.click('#dialog-no');
  await page.waitForSelector('#dialog-no:disabled');
  closeDialog('retry');
  await page.waitForSelector('#dialog-container.hidden', { state: 'attached' });
  const response = page.waitForResponse(response => response.url().endsWith('/api/rpc') && response.request().postDataJSON().type === 'extension_ui_response');
  releaseFailure();
  await (await response).finished();
  assert.equal(await page.locator('#dialog-container').isVisible(), false);
  assert.equal(attempts, 2);
});

test('Abort cancels an unanswered approval only after the stop reached Pi and resends nothing', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const { sessionId, emit, nextCommand, commands } = await createSession(t);
  emit({ type: 'agent_start' });
  emit(confirmRequest('unanswered-abort'));
  const page = await openPage(t, sessionId);
  await expectDialog(page);
  const abort = nextCommand('abort');
  const cancellation = nextCommand('extension_ui_response');
  await page.click('#abort-btn');
  const stop = await abort;
  const reply = await cancellation;
  assert.equal(reply.cancelled, true);
  assert.equal(reply.confirmed, undefined);
  assert.ok(commands.indexOf(stop) < commands.indexOf(reply), 'Abort must reach Pi before the cancelled hook resumes');
  await page.waitForSelector('#dialog-container.hidden', { state: 'attached' });
  assert.equal(await page.locator('#status-text').textContent(), 'Stopping…');
  emit({ type: 'response', command: 'abort', id: stop.id, success: true });
  emit({ type: 'agent_settled' });
  await page.waitForSelector('#abort-btn.hidden', { state: 'attached' });
  assert.deepEqual(commands.filter(command => command.type === 'prompt'), []);
});

test('confirm, select, input and editor requests are shown in order without cancelling one another', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const { sessionId, emit, commands } = await createSession(t);
  emit(confirmRequest('confirm'));
  emit({ type: 'extension_ui_request', method: 'select', id: 'select', title: 'Choose an option', options: ['one', 'two'] });
  emit({ type: 'extension_ui_request', method: 'input', id: 'input', title: 'Enter a value' });
  emit({ type: 'extension_ui_request', method: 'editor', id: 'editor', title: 'Edit a value', prefill: 'original' });
  const page = await openPage(t, sessionId);
  await expectDialog(page);
  await page.click('#dialog-no');
  await expectDialog(page, 'Choose an option');
  await page.getByText('two', { exact: true }).click();
  await expectDialog(page, 'Enter a value');
  await page.fill('#dialog-input', 'typed value');
  await page.press('#dialog-input', 'Enter');
  await expectDialog(page, 'Edit a value');
  assert.equal(await page.locator('#dialog-textarea').inputValue(), 'original');
  await page.fill('#dialog-textarea', 'edited value');
  await page.click('#dialog-save');
  await page.waitForSelector('#dialog-container.hidden', { state: 'attached' });
  assert.deepEqual(replies(commands), [
    { type: 'extension_ui_response', id: 'confirm', confirmed: false },
    { type: 'extension_ui_response', id: 'select', value: 'two' },
    { type: 'extension_ui_response', id: 'input', value: 'typed value' },
    { type: 'extension_ui_response', id: 'editor', value: 'edited value' },
  ]);
});

test('reconnecting recovers an approval created while the browser was disconnected', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const { sessionId, emit } = await createSession(t);
  const page = await openPage(t, sessionId);
  for (const client of liveManager.clients) client.close();
  await page.waitForFunction(() => document.getElementById('status-text')?.textContent === 'Disconnected');
  emit(confirmRequest('during-disconnect'));
  await page.clock.runFor(1100);
  await expectDialog(page);
  assert.equal(await page.locator('#status-text').textContent(), 'Waiting for approval');
});
