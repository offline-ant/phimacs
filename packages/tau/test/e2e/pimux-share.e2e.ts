import { runtimeEnvironment, agent as agentDir, cwd as project } from '../runtime-environment.ts';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import { once } from 'node:events';
import { startRuntime, stopRuntime, listRuntimes, type RuntimeReceipt } from '@phimacs/pimux/runtime';
import { processIdentityStatus, readProcessIdentity } from '@phimacs/pimux/process-identity';
import { runtimeHost } from '../../bin/config.js';
import { DetachedPeer, until } from './fixtures/detached-peer.ts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium, devices, type Browser, type BrowserContext, type Page } from 'playwright';

/*
 * Real pimux, real Pi (faux providers only), the real compiled Tau server and
 * UI in a phone-sized Chromium. The test process plays a socket frontend:
 * creators and browsers have equal lifetime rights, including zero clients.
 * Set TAU_E2E_SCREENSHOTS=<dir> to keep screenshots.
 */

const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const FIXTURE = fileURLToPath(new URL('../../../../test/support/faux.ts', import.meta.url));
const PIMUX = fileURLToPath(new URL('../../../pimux/bin/pimux', import.meta.url));
const SHOTS = process.env.TAU_E2E_SCREENSHOTS || '';

type Record_ = Record<string, unknown>;
const work = runtimeEnvironment.root;
const muxDir = process.env.PIMUX_DIR!;
const holdDir = path.join(work, 'hold');
const password = crypto.randomBytes(12).toString('hex');
const children: ChildProcess[] = [];
const runtimes: RuntimeReceipt[] = [];
const peers = new Set<DetachedPeer>();
let tau: ChildProcess;
let service: ChildProcess | undefined;
let third: Awaited<ReturnType<typeof startMux>>;
let fourth: Awaited<ReturnType<typeof startMux>>;
let base = '';
let tauLog = '';
let browser: Browser;
let context: BrowserContext;

function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, PI_CODING_AGENT_DIR: agentDir, PIMUX_DIR: muxDir, FX_HOLD_DIR: holdDir, ...extra };
}

let tauPorts: [number, number] | undefined;

async function startTau() {
  tauPorts ??= [await freePort(), await freePort()];
  const [httpsPort, httpPort] = tauPorts;
  tau = spawn(process.execPath, [path.join(root, 'bin', 'tau.js')], {
    cwd: work, stdio: ['ignore', 'pipe', 'pipe'],
    env: cleanEnv({ TAU_HOST: '127.0.0.1', TAU_PORT: String(httpsPort), TAU_HTTP_PORT: String(httpPort), TAU_AUTH_ENABLED: 'true', TAU_USER: 'e2e', TAU_PASS: password, TAU_HOSTNAMES: '' }),
  });
  children.push(tau);
  let output = '';
  tau.stdout!.setEncoding('utf8').on('data', (data: string) => { output += data; tauLog += data; });
  tau.stderr!.setEncoding('utf8').on('data', (data: string) => { output += data; tauLog += data; });
  const port = await until(() => /Local orchestration \(loopback HTTP\): http:\/\/127\.0\.0\.1:(\d+)/.exec(output)?.[1], `Tau listening\n${output}`);
  base = `http://127.0.0.1:${port}`;
}

/** The isolated foreground service that owns this test's runtimes; frontends never start it. */
async function startService() {
  const child = spawn(process.execPath, [PIMUX, 'serve'], { cwd: work, env: cleanEnv({}), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout!.setEncoding('utf8').on('data', (data: string) => { output += data; });
  child.stderr!.setEncoding('utf8').on('data', (data: string) => { output += data; });
  service = child;
  await until(() => {
    if (child.exitCode !== null) throw new Error(`pimux serve exited: ${output}`);
    return output.includes('pimux service ready');
  }, 'isolated pimux service', 15000);
}

function discovery() { return listRuntimes(); }

async function peerFor(receipt: RuntimeReceipt) {
  const peer = await DetachedPeer.connect(receipt);
  peers.add(peer);
  return peer;
}

async function startMux(name: string, env: Record<string, string>) {
  const sessions = path.join(runtimeEnvironment.sessions, '--project--');
  fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });
  const sessionFile = path.join(sessions, `${name}.jsonl`);
  fs.writeFileSync(sessionFile, JSON.stringify({ type: 'session', version: 3, id: crypto.randomUUID(), timestamp: new Date().toISOString(), cwd: project }) + '\n', { mode: 0o600 });
  const host = runtimeHost();
  const receipt = await startRuntime({ command: host.executable, cwd: project, env: cleanEnv(env),
    args: ['--mode', 'rpc', '--session', sessionFile, '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--provider', 'fx', '--model', 'one', '-e', FIXTURE],
    ...(env.PI_ORCHESTRATION_PLACEMENT === 'worker' ? { parent: { process: readProcessIdentity(process.pid)!, taskId: name } } : {}),
  });
  runtimes.push(receipt);
  assert.equal(receipt.protocol, 2);
  assert.equal(receipt.state, 'committed');
  return { primary: await peerFor(receipt), sessionFile, muxId: receipt.muxId, receipt };
}

async function stopTau(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => { const { port } = server.address() as net.AddressInfo; server.close(() => resolve(port)); });
  });
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

let root1: Awaited<ReturnType<typeof startMux>>;

before(async () => {
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(holdDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({
    packages: [], defaultProvider: 'fx', defaultModel: 'one', compaction: { enabled: false }, retry: { enabled: false },
  }));
  await startService();
  const emacs = { host: 'emacs', endpoint: path.join(work, 'emacs-socket'), id: '*pi:project*' };
  root1 = await startMux('root', { PI_ORCHESTRATION_HOST: emacs.host, PI_ORCHESTRATION_ENDPOINT: emacs.endpoint, PI_ORCHESTRATION_TARGET: emacs.id });
  await startMux('worker', {
    PI_ORCHESTRATION_HOST: emacs.host, PI_ORCHESTRATION_ENDPOINT: emacs.endpoint, PI_ORCHESTRATION_TARGET: 'do-e2e-worker',
    PI_ORCHESTRATION_PLACEMENT: 'worker', PI_ORCHESTRATION_PARENT: JSON.stringify({ ...emacs, name: emacs.id }),
  });
  third = await startMux('third', { PI_ORCHESTRATION_HOST: emacs.host, PI_ORCHESTRATION_ENDPOINT: emacs.endpoint, PI_ORCHESTRATION_TARGET: '*pi:third*' });
  fourth = await startMux('fourth', { PI_ORCHESTRATION_HOST: emacs.host, PI_ORCHESTRATION_ENDPOINT: emacs.endpoint, PI_ORCHESTRATION_TARGET: '*pi:fourth*' });
  await root1.primary.run('first from emacs');
  await startTau();
  const executablePath = [process.env.CHROMIUM_BINARY, chromium.executablePath(), '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(candidate => candidate && fs.existsSync(candidate));
  assert.ok(executablePath, 'Install Chromium or set CHROMIUM_BINARY');
  browser = await chromium.launch({ executablePath });
  context = await browser.newContext({ ...devices['Pixel 7'], httpCredentials: { username: 'e2e', password } });
});

after(async () => {
  await context?.close();
  await browser?.close();
  for (const child of children.reverse()) await stopTau(child);
  for (const peer of peers) await peer.disconnect();
  for (const receipt of runtimes.reverse()) await stopRuntime(receipt.muxId);
  if (service) await stopTau(service);
  fs.rmSync(work, { recursive: true, force: true });
});

const row = (page: Page, muxId: string) => page.locator(`#agent-list .agent-row[data-mux-id="${muxId}"]`);
/** On a phone the sidebar is a drawer: open it, choose the agent, and it closes once the agent is shown. */
async function openAgent(page: Page, muxId: string) {
  if (await page.locator('#sidebar.collapsed').count()) await page.locator('#sidebar-toggle').click();
  await row(page, muxId).click();
  await page.locator(`#agent-list .agent-row.active[data-mux-id="${muxId}"]`).waitFor();
  if (page.viewportSize()!.width <= 768) await page.locator('#sidebar.collapsed').waitFor({ state: 'attached' });
}
async function headerMenu(page: Page, label: string) {
  await page.locator('#header-menu-btn').click();
  await page.locator('.header-menu-item', { hasText: label }).click();
}
const userMessages = (page: Page, text: string) => page.locator('.message.user', { hasText: text });
const assistantText = (page: Page, text: string) => page.locator('.assistant-step-content', { hasText: text });

test('a socket frontend and a phone share one detached Pi through pimux and Tau', { timeout: 180000 }, async t => {
  let page = await context.newPage();
  t.after(() => page.close());
  await page.goto(base);

  // With nothing shown, the phone opens on the agent list; the idle worker is folded under its parent.
  await page.locator('#sidebar:not(.collapsed)').waitFor();
  const rootRow = row(page, root1.muxId);
  await rootRow.waitFor();
  const workerRow = page.locator('#agent-list .agent-row.agent-worker');
  assert.equal(await workerRow.count(), 0);
  await page.locator('.agent-finished', { hasText: '1 finished' }).click();
  assert.equal(await workerRow.evaluate(element => (element as HTMLElement).style.getPropertyValue('--depth')), '1');
  assert.match(await workerRow.innerText(), /do-e2e-worker/);
  await shot(page, 'agents-overview');

  // Tapping attaches; the history Emacs already has is there.
  const attaching = page.waitForResponse(response => response.url().endsWith('/api/live-sessions/attach'));
  const selecting = page.waitForResponse(response => response.url().endsWith('/snapshot'));
  await rootRow.click();
  const attached = await attaching;
  assert.equal(attached.status(), 200, await attached.text());
  const selected = await selecting;
  assert.equal(selected.status(), 200, await selected.text());
  await page.locator('#sidebar.collapsed').waitFor({ state: 'attached' });
  assert.ok(page.url().endsWith(`#agent=${encodeURIComponent(root1.muxId)}`), page.url());
  await userMessages(page, 'first from emacs').waitFor();
  await assistantText(page, 'reply: first from emacs').waitFor();
  assert.ok(fs.existsSync(root1.sessionFile));

  // A prompt from Emacs renders once in the phone.
  await root1.primary.run('second from emacs');
  await assistantText(page, 'reply: second from emacs').waitFor();
  assert.equal(await userMessages(page, 'second from emacs').count(), 1);

  // A prompt from the phone reaches Emacs and renders once in both.
  const before = root1.primary.mark();
  await page.locator('#message-input').fill('hello from phone');
  await page.locator('#send-btn').click();
  await root1.primary.waitFor((record) => record.type === 'message_start' && JSON.stringify((record.message as Record_).content).includes('hello from phone'), 'phone prompt in Emacs', before);
  await root1.primary.waitFor((record) => record.type === 'agent_settled', 'phone prompt settles', before);
  await assistantText(page, 'reply: hello from phone').waitFor();
  assert.equal(await userMessages(page, 'hello from phone').count(), 1);

  // Close the tab while inference is held. A new tab must read the completed
  // turn from the same process; it cannot retry the original delivery.
  const held = 'hold tab-away';
  const url = page.url();
  const identity = readProcessIdentity(root1.receipt.piPid)!;
  const heldMark = root1.primary.mark();
  await page.locator('#message-input').fill(held);
  await page.locator('#send-btn').click();
  await root1.primary.waitFor(record => record.type === 'message_start' && JSON.stringify(record.message).includes(held), 'held turn reached the peer', heldMark);
  await page.close();
  assert.equal(processIdentityStatus(identity), 'alive');
  assert.equal(root1.primary.find(record => record.type === 'agent_settled', heldMark), undefined);
  fs.writeFileSync(path.join(holdDir, 'tab-away'), '');
  await root1.primary.waitFor(record => record.type === 'agent_settled', 'turn settled without the tab', heldMark);
  page = await context.newPage();
  await page.goto(url);
  await assistantText(page, `reply: ${held}`).waitFor();
  assert.equal(await userMessages(page, held).count(), 1);
  assert.equal(await assistantText(page, `reply: ${held}`).count(), 1);
  const inventory = await (await page.request.get(`${base}/api/live-sessions`)).json() as { sessions: Array<{ runtime: RuntimeReceipt }> };
  assert.equal(inventory.sessions.find(item => item.runtime.muxId === root1.muxId)?.runtime.piPid, identity.pid);
  const completed = root1.primary.records.slice(heldMark).filter(record => record.type === 'message_end' && JSON.stringify(record.message).includes(held));
  assert.deepEqual(completed.map(record => (record.message as Record_).role), ['user', 'assistant']);
  t.diagnostic(`Reopened tab on ${root1.muxId}, unchanged Pi PID ${identity.pid}: one user message and one assistant reply on both clients.`);

  // A dialog answered in Emacs closes in the phone.
  let start = root1.primary.mark();
  const firstPicker = root1.primary.request({ type: 'prompt', message: '/fx-select' });
  const asked = await root1.primary.waitFor((record) => record.type === 'extension_ui_request' && record.method === 'select', 'dialog', start);
  await page.locator('.dialog-title', { hasText: 'Pick a fruit' }).waitFor();
  root1.primary.send({ type: 'extension_ui_response', id: asked.id, value: 'pear' });
  await page.locator('#dialog-container.hidden').waitFor({ state: 'attached' });
  await root1.primary.waitFor((record) => record.type === 'extension_ui_request' && record.method === 'notify' && record.message === 'picked:pear', 'pear', start);
  assert.equal((await firstPicker).success, true);

  // A dialog answered in the phone closes in Emacs, which hears who answered.
  start = root1.primary.mark();
  const secondPicker = root1.primary.request({ type: 'prompt', message: '/fx-select' });
  const second = await root1.primary.waitFor((record) => record.type === 'extension_ui_request' && record.method === 'select', 'second dialog', start);
  await page.locator('.dialog-option', { hasText: 'apple' }).click();
  const closed = await root1.primary.waitFor((record) => record.type === 'pimux_dialog_closed' && record.id === second.id, 'closed in Emacs', start);
  assert.equal(closed.reason, 'answered');
  assert.notEqual(closed.clientId, root1.primary.find((record) => record.type === 'pimux_hello')!.clientId);
  await root1.primary.waitFor((record) => record.type === 'extension_ui_request' && record.method === 'notify' && record.message === 'picked:apple', 'apple', start);
  assert.equal((await secondPicker).success, true);

  // Two dialogs at once take turns in the phone; neither answers the other with a cancel.
  start = root1.primary.mark();
  const twoPickers = root1.primary.request({ type: 'prompt', message: '/fx-two' });
  await page.locator('.dialog-title', { hasText: 'Fruit one' }).waitFor();
  await root1.primary.waitFor((record) => record.type === 'extension_ui_request' && record.title === 'Fruit two', 'second dialog at once', start);
  await page.locator('.dialog-option', { hasText: 'pear' }).click();
  await page.locator('.dialog-title', { hasText: 'Fruit two' }).waitFor();
  await page.locator('.dialog-option', { hasText: 'plum' }).click();
  await root1.primary.waitFor((record) => record.type === 'extension_ui_request' && record.method === 'notify' && record.message === 'both:pear,plum', 'both answers', start);
  assert.equal((await twoPickers).success, true);

  // A model chosen in Emacs reaches the tab, and reloading mid-reply resumes the stream exactly.
  assert.equal((await root1.primary.request({ type: 'set_model', provider: 'fx-slow', modelId: 'one' })).success, true);
  await until(async () => {
    const live = await (await page.request.get(`${base}/api/live-sessions`)).json() as { sessions: Array<{ model?: { provider?: string } }> };
    return live.sessions[0]?.model?.provider === 'fx-slow';
  }, 'model change in Tau');
  const words = Array.from({ length: 150 }, (_, index) => `word${index}`).join(' ');
  start = root1.primary.mark();
  await root1.primary.request({ type: 'prompt', message: 'stream 150' });
  await root1.primary.waitFor((record) => record.type === 'message_update', 'streaming started', start);
  await assistantText(page, 'word1 ').first().waitFor();
  await page.reload();
  await assistantText(page, 'word1 ').first().waitFor();
  await root1.primary.waitFor((record) => record.type === 'agent_settled', 'stream settles', start);
  await until(async () => (await assistantText(page, 'word149').allInnerTexts()).some((text) => text.trim() === words), 'full streamed reply after reload');
  assert.equal(await assistantText(page, 'word149').count(), 1, 'the reply renders once');
  await shot(page, 'shared-conversation');

  // A session change in the peer quarantines unsent browser input with the
  // original file; neither Pi nor the new composer may see it as a prompt.
  const stale = 'draft for the former session';
  const draftMark = root1.primary.mark();
  const prior = (await (await page.request.get(`${base}/api/live-sessions`)).json()).sessions.find((session: { runtime: RuntimeReceipt }) => session.runtime.muxId === root1.muxId);
  assert.ok(prior.runtimeContext?.contextId);
  await page.locator('#message-input').fill(stale);
  assert.equal((await root1.primary.request({ type: 'new_session' })).success, true);
  await userMessages(page, 'hello from phone').waitFor({ state: 'detached' });
  const recovered = page.locator('#recovered-input .queued-msg', { hasText: stale });
  await recovered.waitFor();
  assert.ok((await recovered.getAttribute('title'))?.includes(root1.sessionFile));
  assert.equal(await page.locator('#message-input').inputValue(), '');
  const moved = await (await page.request.get(`${base}/api/live-sessions`)).json() as { sessions: Array<{ sessionFile?: string }> };
  assert.notEqual(moved.sessions[0].sessionFile, root1.sessionFile);
  const refused = await page.request.post(`${base}/api/rpc`, { data: { type: 'prompt', sessionId: prior.id, message: stale,
    inputContext: { agentId: root1.muxId, file: prior.sessionFile, leafId: prior.leafId, runtimeContext: prior.runtimeContext } } });
  const rejection = await refused.json();
  assert.equal(rejection.success, false);
  assert.equal(rejection.delivery, 'rejected');
  assert.match(rejection.error, /review it before reuse/);

  // Close stops the shared runtime without a prompt and removes both browser
  // views as well as notifying the equal socket frontend.
  await root1.primary.request({ type: 'set_model', provider: 'fx', modelId: 'one' });
  await root1.primary.run('before closing');
  assert.equal(root1.primary.find(record => record.type === 'message_start' && JSON.stringify(record.message).includes(stale), draftMark), undefined);
  const other = await context.newPage();
  t.after(() => other.close());
  await other.goto(`${base}/#agent=${encodeURIComponent(root1.muxId)}`);
  await assistantText(other, 'reply: before closing').waitFor();
  const piIdentity = readProcessIdentity(root1.receipt.piPid)!;
  assert.ok(piIdentity);
  page.on('dialog', dialog => { void dialog.dismiss(); assert.fail('Close must not ask for confirmation'); });
  await headerMenu(page, 'Close agent');
  await root1.primary.waitFor(record => record.type === 'pimux_exit', 'Close reaches the equal socket frontend');
  await until(() => processIdentityStatus(piIdentity) === 'dead', 'Close waits for actual Pi exit');
  await until(async () => ((await (await page.request.get(`${base}/api/live-sessions`)).json()) as { sessions: unknown[] }).sessions.length === 0, 'closed agent removed from Tau');
  await row(page, root1.muxId).waitFor({ state: 'detached' });
  await row(other, root1.muxId).waitFor({ state: 'detached' });
  for (const view of [page, other]) {
    assert.equal(new URL(view.url()).hash, '', 'a closed agent is no longer named in the URL');
    assert.equal(await view.locator('#agent-title-name').innerText(), 'Tau');
  }
  assert.ok(!discovery().some(record => record.muxId === root1.muxId));
  await shot(page, 'shared-exit');
});

test('hostile discovery text stays text, a slow attach does not steal the view, a Tau restart loses no draft', { timeout: 120000 }, async t => {
  const hostile = path.join(muxDir, 'hostile.json');
  const cwd = `${work}/x" onpointerenter="window.__owned=1`;
  fs.writeFileSync(hostile, JSON.stringify({
    ...discovery()[0], protocol: 2, muxId: 'hostile"x', socket: path.join(muxDir, 'hostile.sock'), pid: process.pid, piPid: process.pid, cwd,
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'idle', blocked: null,
    session: { file: null, id: 'h', name: '<img src=x onerror="window.__owned=1">' }, model: null, thinkingLevel: null,
    placement: 'root', orchestration: null, parent: null,
  }), { mode: 0o600 });
  const page = await context.newPage();
  t.after(() => page.close());
  await page.goto(base);
  const list = page.locator('#agent-list');
  const title = list.locator('.agent-group-fold', { hasText: 'x" onpointerenter' });
  await title.waitFor();
  assert.equal(await title.getAttribute('title'), `Hide ${cwd}`);
  assert.equal(await list.locator('[onpointerenter], img').count(), 0);
  assert.match(await list.locator('.agent-name', { hasText: '<img' }).innerText(), /^<img src=x/);
  await title.hover();
  assert.equal(await page.evaluate(() => (window as unknown as { __owned?: number }).__owned), undefined);
  fs.rmSync(hostile);

  // An attach that hangs while the user chooses another agent does not take the view back.
  await openAgent(page, fourth.muxId);
  let release = () => {};
  const released = new Promise<void>((resolve) => { release = resolve; });
  let held = () => {};
  const holding = new Promise<void>((resolve) => { held = resolve; });
  await page.route('**/api/live-sessions/attach', async (route) => {
    if ((route.request().postDataJSON() as { muxId: string }).muxId === third.muxId) { held(); await released; }
    await route.continue();
  });
  const slow = page.waitForResponse(response => response.url().endsWith('/api/live-sessions/attach')
    && (response.request().postDataJSON() as { muxId: string }).muxId === third.muxId);
  await page.locator('#sidebar-toggle').click();
  await row(page, third.muxId).click();
  await holding;
  await openAgent(page, fourth.muxId);
  release();
  await slow;
  await page.unroute('**/api/live-sessions/attach');
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  assert.equal(await page.locator('#agent-list .agent-row.active').getAttribute('data-mux-id'), fourth.muxId);
  assert.ok(page.url().endsWith(`#agent=${encodeURIComponent(fourth.muxId)}`), page.url());

  // Tau dies: the status tells the truth, and the draft waits for its agent.
  await openAgent(page, third.muxId);
  const activeMux = third.muxId;
  await page.locator('#message-input').fill('draft for this agent');
  const stopped = new Promise((resolve) => tau.once('exit', resolve));
  tau.kill('SIGKILL');
  await stopped;
  await until(async () => await page.locator('#status-text').innerText() === 'Disconnected', 'disconnected status');
  await startTau();
  // A working connection is not news: the status line empties.
  await until(async () => await page.locator('#status-text').textContent() === '', 'reconnected status', 30000);
  // Reconnection never submits or silently moves preserved input. Recovery is
  // bound to its old agent and context and requires an explicit Reuse action.
  await page.locator('#recovered-input .queued-msg', { hasText: 'draft for this agent' }).waitFor();
  assert.equal(await page.locator('#message-input').inputValue(), '');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Reuse', exact: true }).click();
  await until(async () => await page.locator('#message-input').inputValue() === 'draft for this agent', 'explicitly reused draft');
  assert.equal(await page.locator('#agent-list .agent-row.active').getAttribute('data-mux-id'), activeMux);
  await page.close();
});

test('a shared view offers advertised tree navigation and equal root actions, title, queue, status, keyboard and a History of saved sessions only', { timeout: 120000 }, async t => {
  const desk = await browser.newContext({ viewport: { width: 1280, height: 800 }, httpCredentials: { username: 'e2e', password } });
  const page = await desk.newPage();
  const phone = await context.newPage();
  t.after(async () => { await phone.close(); await desk.close(); });
  await page.goto(base);
  await phone.goto(base);
  await openAgent(page, fourth.muxId);
  await openAgent(page, third.muxId);
  await until(() => page.evaluate(() => document.activeElement?.id === 'message-input'), 'opening an agent focuses the composer');

  // Root actions do not depend on which frontend created this runtime; pimux
  // loads tree navigation into every Pi it runs.
  await page.locator('#command-btn').click();
  const labels = await page.locator('.command-label').allInnerTexts();
  assert.ok(labels.includes('New session'));
  assert.ok(labels.includes('Session tree'), labels.join());
  assert.equal(await page.locator('#tree-btn').isVisible(), true);
  await page.keyboard.press('Escape');
  await page.locator('#header-menu-btn').click();
  assert.deepEqual(await page.locator('.header-menu-item').allInnerTexts(), ['Usage and cost', 'Export HTML', 'Settings', 'Close agent']);
  await page.keyboard.press('Escape');

  // The header keeps the agent's name, whatever is said in it.
  const title = page.locator('#agent-title-name');
  const name = await title.innerText();
  await third.primary.run('a prompt that must not become the title');
  assert.equal(await title.innerText(), name);

  // Status text asks nothing of anyone; a dialog on that agent does.
  await openAgent(page, fourth.muxId);
  assert.equal((await third.primary.request({ type: 'prompt', message: '/fx-status' })).success, true);
  assert.equal(await row(page, third.muxId).evaluate(element => element.classList.contains('agent-blocked')), false);
  await openAgent(page, third.muxId);

  // A dialog owns the keyboard, then gives it back.
  const mark = third.primary.mark();
  third.primary.send({ type: 'prompt', message: '/fx-select' });
  await page.locator('.dialog-option').first().waitFor();
  await until(() => page.evaluate(() => document.activeElement?.textContent === 'apple'), 'the first option has focus');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await third.primary.waitFor((record) => record.method === 'notify' && record.message === 'picked:pear', 'keyboard answer', mark);
  await page.locator('#dialog-container.hidden').waitFor({ state: 'attached' });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const focusReturned = await page.evaluate(() => document.activeElement?.id === 'message-input');

  // Another browser sees the image too.
  await openAgent(phone, third.muxId);
  const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  await third.primary.run('with a picture');
  third.primary.send({ type: 'prompt', message: 'with a picture attached', images: [{ type: 'image', data: pixel, mimeType: 'image/png' }] });
  await userMessages(phone, 'with a picture attached').locator('img').waitFor();
  await assistantText(phone, 'reply: with a picture attached').waitFor();
  await third.primary.waitFor((record) => record.type === 'agent_settled', 'picture turn');

  // Busy on a phone: both buttons fit, and what Pi holds is visible everywhere.
  fs.rmSync(path.join(holdDir, 'q1'), { force: true });
  third.primary.send({ type: 'prompt', message: 'hold q1, then answer' });
  await phone.locator('#abort-btn').waitFor();
  await phone.locator('#message-input').fill('steer from the phone');
  await phone.locator('#send-btn').click();
  await phone.locator('.queued-msg', { hasText: 'steer from the phone' }).waitFor();
  await page.locator('.queued-msg', { hasText: 'steer from the phone' }).waitFor();
  const stop = (await phone.locator('#abort-btn').boundingBox())!;
  assert.ok(stop.x + stop.width <= phone.viewportSize()!.width, 'Stop stays on screen');
  const model = (await phone.locator('#model-input').boundingBox())!;
  assert.ok(model.width > 50, 'a long status leaves the model button its room');
  await shot(phone, 'busy-phone');
  fs.writeFileSync(path.join(holdDir, 'q1'), '');
  await assistantText(phone, 'reply: steer from the phone').waitFor();
  await until(async () => await page.locator('.queued-msg').count() === 0, 'the queue empties');

  // History lists the closed agent's saved session, never one a running agent shows above.
  if (!await page.locator('.history-body:not([hidden])').count()) await page.locator('.history-toggle').click();
  await page.locator('.history-project').first().click();
  await page.locator(`.history-session[data-file-path="${root1.sessionFile}"]`).waitFor();
  for (const running of [third, fourth]) {
    assert.equal(await page.locator(`.history-session[data-file-path="${running.sessionFile}"]`).count(), 0);
  }

  assert.equal(focusReturned, true, 'authoritative dialog closure must return keyboard focus to the composer');
  await phone.close();
  await desk.close();
});

test('either frontend can create, leave zero clients, reattach and stop only by an acknowledged operation', { timeout: 60000 }, async () => {
  const api = context.request;
  const fromPeer = await startMux('equal-lifetime', { PI_ORCHESTRATION_HOST: 'emacs', PI_ORCHESTRATION_ENDPOINT: path.join(work, 'emacs-socket'), PI_ORCHESTRATION_TARGET: '*pi:equal*' });
  const identity = readProcessIdentity(fromPeer.receipt.piPid)!;
  assert.ok(identity);
  await fromPeer.primary.disconnect();
  assert.equal(processIdentityStatus(identity), 'alive', 'creator socket EOF must not stop Pi');
  const attached = await api.post(`${base}/api/live-sessions/attach`, { data: { muxId: fromPeer.muxId } });
  assert.equal(attached.status(), 200);
  const view = (await attached.json() as { session: { id: string; runtime: RuntimeReceipt } }).session;
  assert.equal(view.runtime.piPid, fromPeer.receipt.piPid);
  assert.equal((await api.delete(`${base}/api/live-sessions/${view.id}`)).status(), 200);
  assert.equal(processIdentityStatus(identity), 'alive', 'zero clients must not stop a creator-started root');
  const backToCreator = await peerFor(fromPeer.receipt);
  assert.equal((await backToCreator.request({ type: 'get_state' })).success, true);
  await backToCreator.disconnect();
  assert.equal(processIdentityStatus(identity), 'alive');
  const stoppedPeerRoot = await api.post(`${base}/api/agents/${fromPeer.muxId}/stop`, { data: { operationId: 'peer-origin-close' } });
  assert.equal(stoppedPeerRoot.status(), 200);
  assert.equal((await stoppedPeerRoot.json() as { receipt: { state: string } }).receipt.state, 'stopped');
  assert.equal(processIdentityStatus(identity), 'dead');

  const created = await api.post(`${base}/api/live-sessions`, { data: { cwd: project, model: 'fx/one', args: [
    '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '-e', FIXTURE,
  ] } }).catch(error => {
    console.error(tauLog.slice(-8000));
    throw error;
  });
  assert.equal(created.status(), 200, await created.text());
  const tauView = (await created.json() as { session: { id: string; runtime: RuntimeReceipt } }).session;
  const receipt = tauView.runtime;
  runtimes.push(receipt);
  const tauIdentity = readProcessIdentity(receipt.piPid)!;
  assert.ok(tauIdentity);
  const peer = await peerFor(receipt);
  assert.equal((await api.delete(`${base}/api/live-sessions/${tauView.id}`)).status(), 200);
  await peer.run('survived the creating Tau view');
  await peer.disconnect();
  assert.equal(processIdentityStatus(tauIdentity), 'alive', 'zero clients must not stop a Tau-created root');
  const reattached = await api.post(`${base}/api/live-sessions/attach`, { data: { muxId: receipt.muxId } });
  assert.equal(reattached.status(), 200);
  const restored = (await reattached.json() as { session: { id: string; runtime: RuntimeReceipt } }).session;
  assert.equal(restored.runtime.piPid, receipt.piPid);
  const again = await peerFor(receipt);
  assert.equal((await again.request({ type: 'get_state' })).success, true);
  const stopped = await api.post(`${base}/api/live-sessions/${restored.id}/stop`, { data: { operationId: 'tau-origin-close' } });
  assert.equal(stopped.status(), 200, await stopped.text());
  const terminal = (await stopped.json() as { receipt: { state: string } }).receipt;
  assert.equal(terminal.state, 'stopped');
  await again.waitFor(record => record.type === 'pimux_exit', 'stop reaches the equal socket peer');
  assert.equal(processIdentityStatus(tauIdentity), 'dead');
  const repeated = await api.post(`${base}/api/agents/${receipt.muxId}/stop`, { data: { operationId: 'reconcile-close' } });
  assert.deepEqual((await repeated.json() as { receipt: unknown }).receipt, terminal);
});
