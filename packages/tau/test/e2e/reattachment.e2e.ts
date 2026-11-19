import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Browser } from 'playwright';
import { agent as overviewAgent, launchBrowser, openUI, session, snapshot } from './ui-correctness-harness.ts';

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser?.close(); });
type View = Awaited<ReturnType<typeof openUI>>;
const original = session('a');
const restored = session('restored', { ...original, id: 'restored', sessionName: 'Restored agent' });
const agent = overviewAgent('mux-a', { name: 'Original agent', sessionFile: original.sessionFile });
const draft = 'draft belonging to the original agent and leaf';
const recovery = (view: View) => view.page.locator('#recovered-input .queued-msg', { hasText: draft });
async function finishAttach(view: View, attach: ReturnType<View['hold']>) {
  view.live.set(restored.id, restored);
  await attach.called;
  await attach.resolve({ session: restored });
  await view.page.locator('#messages', { hasText: 'Restored agent' }).waitFor();
  assert.equal(await view.shown(), 'Restored agent');
  assert.equal(await view.page.locator('#message-input').inputValue(), '', 'reattachment never silently restores or sends input');
}
async function reuse(view: View) {
  const row = recovery(view);
  assert.match(await row.getAttribute('title') || '', /\/synthetic\/a\.jsonl · leaf a-leaf · mux-a/);
  assert.equal(await row.getByRole('button', { name: 'Reuse', exact: true }).isEnabled(), true);
  await row.getByRole('button', { name: 'Reuse', exact: true }).click();
  assert.equal(await view.page.locator('#message-input').inputValue(), draft);
  assert.equal(view.requests.some(item => item.method === 'POST' && ['/api/live-sessions', '/api/live-sessions/resume'].includes(item.path)), false);
  assert.equal(await view.page.evaluate(() => (Reflect.get(window, 'fixtureSent') as Array<{ type: string }>).filter(item => item.type === 'prompt').length), 0);
}

test('restart restores a known runtime without waiting for the agent overview to list it', { timeout: 15000 }, async () => {
  const view = await openUI(browser, [original]);
  try {
    await view.page.locator('#message-input').fill(draft);
    const attach = view.hold('/api/live-sessions/attach');
    await view.disconnect();
    await view.reconnect([], []);
    await finishAttach(view, attach);
    assert.deepEqual(view.requests.find(item => item.path === '/api/live-sessions/attach')?.body, { muxId: 'mux-a' });
    await reuse(view);
    await view.emit({ type: 'pimux_agents', agents: [agent] });
    assert.equal(view.requests.filter(item => item.path === '/api/live-sessions/attach').length, 1, 'late overview discovery does not attach twice');
  } finally { await view.close(); }
});

test('a pre-restart empty list response cannot remove the successfully reattached view', { timeout: 15000 }, async () => {
  const view = await openUI(browser, [original]);
  try {
    await view.page.locator('#message-input').fill(draft);
    const list = view.hold('/api/live-sessions');
    await view.pollInstances(); await list.called;
    const attach = view.hold('/api/live-sessions/attach');
    await view.disconnect(); await view.reconnect([], [agent]);
    await finishAttach(view, attach);
    await list.resolve({ sessions: [] });
    assert.equal(await view.shown(), 'Restored agent', 'a stale empty inventory cannot remove the selected reattachment');
    await reuse(view);
  } finally { await view.close(); }
});

test('a late list response cannot resurrect a view removed by authoritative events', { timeout: 15000 }, async () => {
  const view = await openUI(browser, [session('b'), original]);
  try {
    const list = view.hold('/api/live-sessions');
    await view.pollInstances(); await list.called;
    await view.emit({ type: 'live_session_closed', sessionId: 'b' });
    assert.equal(await view.shown(), 'Tau');
    await list.resolve({ sessions: [original, session('b')] });
    assert.equal(await view.shown(), 'Tau', 'the stale list cannot bring back the closed view');
    assert.equal(await view.page.locator('#message-input').isDisabled(), true);
    // The guard must not disable later, current polling: a listed view of the selected agent is shown again.
    await view.select('a'); await view.page.locator('#messages', { hasText: 'Live a' }).waitFor();
    view.live.delete('a'); view.live.set('current-poll', session('current-poll', { attached: original.attached }));
    await view.pollInstances();
    await view.page.locator('#messages', { hasText: 'Live current-poll' }).waitFor();
  } finally { await view.close(); }
});

test('selecting an agent while disconnected records its runtime and does not query a stale Tau-local id', { timeout: 15000 }, async () => {
  const view = await openUI(browser, [original, session('b')]);
  try {
    await view.disconnect();
    await view.select('b');
    await view.page.locator('#messages', { hasText: 'waiting to restore the selected conversation' }).waitFor();
    assert.equal(view.requests.filter(item => item.path === '/api/live-sessions/b/snapshot').length, 0);
    await view.reconnect([], [agent]);
    await view.page.locator('#messages', { hasText: 'Live b' }).waitFor();
    assert.deepEqual(view.requests.filter(item => item.path === '/api/live-sessions/attach').map(item => item.body),
      [{ muxId: 'mux-b' }, { muxId: 'mux-b' }], 'reconnection returns to the chosen agent, not the former one');
    assert.equal(await view.hash(), '#agent=mux-b');
  } finally { await view.close(); }
});

test('an old snapshot 404 before the replacement state cannot erase the disconnected runtime identity', { timeout: 15000 }, async () => {
  const view = await openUI(browser, [session('b'), original]);
  try {
    const oldSnapshot = view.hold('/api/live-sessions/a/snapshot');
    await view.select('a'); await oldSnapshot.called;
    await view.page.locator('#message-input').fill(draft);
    await view.disconnect();
    await oldSnapshot.resolve({ error: 'The old Tau-local view no longer exists' }, 404);
    const attach = view.hold('/api/live-sessions/attach');
    await view.reconnect([], [agent]);
    await finishAttach(view, attach);
    await reuse(view);
  } finally { await view.close(); }
});

test('an authoritative snapshot before attach completion owns the selected file and leaf, not older HTTP metadata', { timeout: 15000 }, async () => {
  const view = await openUI(browser, [original]);
  try {
    await view.page.locator('#message-input').fill(draft);
    const attach = view.hold('/api/live-sessions/attach');
    await view.disconnect(); await view.reconnect([], [agent]); await attach.called;
    const advanced = { ...restored, cwd: '/synthetic/moved', sessionFile: '/synthetic/moved/conversation.jsonl', leafId: 'advanced-leaf',
      runtimeContext: { sessionFile: '/synthetic/moved/conversation.jsonl', leafId: 'advanced-leaf', contextId: 'advanced-context' } };
    view.live.set(restored.id, advanced);
    await view.emit({ type: 'live_session_snapshot', ...snapshot(advanced, 'Advanced authoritative context', 20) });
    const selectedSnapshot = view.hold(`/api/live-sessions/${restored.id}/snapshot`);
    await attach.resolve({ session: restored }); await selectedSnapshot.called;
    assert.match(await view.page.locator('#agent-title-name').getAttribute('title') || '', /\/synthetic\/moved$/);
    await reuse(view);
    assert.equal(await view.page.evaluate(() => (Reflect.get(window, 'fixtureConfirmations') as string[]).length), 1, 'reuse into the newer context requires explicit confirmation');
    await selectedSnapshot.resolve(snapshot(advanced, 'Selected advanced context', 21));
    assert.equal(await view.page.locator('#message-input').inputValue(), draft, 'older attach metadata must not cause a second quarantine');
    assert.equal(await recovery(view).count(), 0);
  } finally { await view.close(); }
});

test('a newer manual choice while reconnecting keeps its draft and does not get replaced by late attachment', { timeout: 15000 }, async () => {
  const view = await openUI(browser);
  try {
    await view.page.locator('#message-input').fill(draft);
    const attach = view.hold('/api/live-sessions/attach');
    await view.disconnect(); await view.reconnect([session('b')], [agent]); await attach.called;
    await view.select('b'); await view.page.locator('#messages', { hasText: 'Live b' }).waitFor();
    await view.page.locator('#message-input').fill('new choice B draft');
    await attach.resolve({ session: restored });
    assert.equal(await view.shown(), 'Live b');
    assert.equal(await view.page.locator('#message-input').inputValue(), 'new choice B draft');
    assert.match(await recovery(view).getAttribute('title') || '', /leaf a-leaf · mux-a/);
  } finally { await view.close(); }
});

test('a refused reconnect keeps the original input for review and never starts or retries work', { timeout: 15000 }, async () => {
  const view = await openUI(browser, [original]);
  try {
    await view.page.locator('#message-input').fill(draft);
    const attach = view.hold('/api/live-sessions/attach');
    await view.disconnect(); await view.reconnect([], [agent]); await attach.called;
    await attach.resolve({ error: 'Runtime identity could not be verified' }, 409);
    assert.match(await view.page.locator('#status-text').innerText(), /Runtime identity could not be verified/);
    assert.match(await recovery(view).getAttribute('title') || '', /leaf a-leaf · mux-a/);
    assert.equal(await recovery(view).getByRole('button', { name: 'Reuse', exact: true }).isEnabled(), false);
    assert.deepEqual(view.requests.filter(item => item.method === 'POST').map(item => item.path).filter(item => item.startsWith('/api/live-sessions')), ['/api/live-sessions/attach']);
  } finally { await view.close(); }
});

test('a replacement inventory received before socket state preserves local queued input', { timeout: 15000 }, async () => {
  const view = await openUI(browser, [original]);
  try {
    await view.emit({ type: 'event', sessionId: 'a', event: { type: 'agent_start' } });
    const abort = view.hold('/api/rpc', 'abort');
    await view.page.locator('#abort-btn').click(); await abort.called;
    await view.page.locator('#message-input').fill(draft);
    await view.page.locator('#message-input').press('Enter');
    await view.page.locator('#queued-messages .queued-msg', { hasText: draft }).waitFor();
    await view.disconnect();
    const list = view.hold('/api/live-sessions');
    await view.pollInstances(); await list.called; await list.resolve({ sessions: [] });
    assert.match(await view.page.locator('#recovered-input').innerText(), /draft belonging to the original agent and leaf/);
    assert.match(await recovery(view).getAttribute('title') || '', /leaf a-leaf · mux-a/);
    await abort.resolve({ success: true });
    const attach = view.hold('/api/live-sessions/attach');
    await view.reconnect([], [agent]); await finishAttach(view, attach); await reuse(view);
  } finally { await view.close(); }
});

test('shutdown shows no other agent in place of the reconnect target', { timeout: 15000 }, async () => {
  const view = await openUI(browser);
  try {
    await view.page.locator('#message-input').fill(draft);
    await view.emit({ type: 'live_session_closed', sessionId: 'a', reason: 'server_shutdown' });
    assert.equal(await view.shown(), 'Tau');
    assert.doesNotMatch(await view.page.locator('#messages').innerText(), /Live b/);
    assert.equal(await view.hash(), '#agent=mux-a', 'the URL still names the agent to return to');
    await view.disconnect();
    const attach = view.hold('/api/live-sessions/attach');
    await view.reconnect([], [agent, { ...agent, muxId: 'mux-b' }]); await attach.called;
    assert.deepEqual(view.requests.find(item => item.path === '/api/live-sessions/attach')?.body, { muxId: 'mux-a' });
    await finishAttach(view, attach); await reuse(view);
  } finally { await view.close(); }
});

for (const shutdownEvent of [false, true]) {
  test(`reconnect preserves a newer read-only selection${shutdownEvent ? ' even when the former view reports shutdown' : ''}`, { timeout: 15000 }, async () => {
    const view = await openUI(browser, [original]);
    try {
      await view.page.locator('#message-input').fill(draft);
      await view.stored('owned-a');
      await view.page.locator('#messages', { hasText: 'Read-only: owned-a' }).waitFor();
      if (shutdownEvent) await view.emit({ type: 'live_session_closed', sessionId: 'a', reason: 'server_shutdown' });
      await view.disconnect(); await view.reconnect([], [agent]); await view.flush();
      assert.equal(view.requests.filter(item => item.path === '/api/live-sessions/attach').length, 0);
      assert.match(await view.page.locator('#messages').innerText(), /Read-only: owned-a/);
      assert.match(await recovery(view).getAttribute('title') || '', /leaf a-leaf · mux-a/);
      assert.equal(await view.page.locator('.agent-row.active').count(), 0);
      assert.equal(await view.shown(), 'Tau');
    } finally { await view.close(); }
  });
}

test('a current snapshot 404 preserves local queued input before removing its view', { timeout: 15000 }, async () => {
  const view = await openUI(browser, [original]);
  try {
    await view.emit({ type: 'event', sessionId: 'a', event: { type: 'extension_ui_request', id: 'approval', method: 'input', title: 'Pending approval' } });
    await view.page.locator('#message-input').fill(draft);
    await view.page.locator('#message-input').press('Enter');
    await view.page.locator('#queued-messages .queued-msg', { hasText: draft }).waitFor();
    // Reconnecting to the same server rereads the shown view, which turns out to be gone.
    const missing = view.hold('/api/live-sessions/a/snapshot');
    await view.disconnect(); await view.reconnect([original]); await missing.called;
    await missing.resolve({ error: 'The view no longer exists' }, 404);
    assert.match(await recovery(view).getAttribute('title') || '', /leaf a-leaf · mux-a/);
    assert.equal(await view.shown(), 'Tau');
    assert.equal(await recovery(view).getByRole('button', { name: 'Reuse', exact: true }).isEnabled(), false);
    assert.equal(view.requests.filter(item => item.path === '/api/live-sessions/attach').length, 0, 'a current missing view does not imply a server restart');
    assert.deepEqual(await view.page.evaluate(() => Reflect.get(window, 'fixtureSent')), []);
  } finally { await view.close(); }
});
