import { runtimeEnvironment, projects, launcher, installFakeRuntime, closeFakeRuntime, launchBrowser, listenFakeServer, liveManager } from './fake-browser-runtime.ts';
import { test, before, after, afterEach, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Browser, Page } from 'playwright';
import { FakePimux, until } from '../fake-pimux.ts';
import { agentOverview } from '../../bin/tau.js';
import type { JsonRecord } from '../../src/server/types.ts';

// The pi-deck-like agent sidebar in real Chromium against in-process Tau, with
// fake pimux runtimes (real sockets and discovery files, no Pi or inference).

const alpha = path.join(projects, 'alpha');
const beta = path.join(projects, 'beta');
const emacs = { host: 'emacs', endpoint: '/tmp/emacs-test' };
let base = '';
let browser: Browser;
let muxes: FakePimux[] = [];
let clock = 0;

async function agent(name: string, cwd: string, extra: JsonRecord = {}) {
  const mux = new FakePimux(process.env.PIMUX_DIR!, `mux-${name}`, {
    sessionFile: path.join(runtimeEnvironment.sessions, `${name}.jsonl`), cwd,
    startedAt: new Date(Date.UTC(2026, 10, 6, 10, 0, clock++)).toISOString(),
    orchestration: { ...emacs, id: name }, ...extra,
  });
  (mux.entry.session as JsonRecord).name = name;
  mux.publish();
  await mux.listen();
  muxes.push(mux);
  return mux;
}
const worker = (name: string, cwd: string, parent: string, status: string) =>
  agent(name, cwd, { placement: 'worker', status, parent: { ...emacs, id: parent, name: parent } });

before(async () => {
  for (const dir of [alpha, beta]) fs.mkdirSync(dir, { recursive: true });
  installFakeRuntime();
  base = await listenFakeServer();
  browser = await launchBrowser();
});
after(async () => {
  await browser?.close();
  await closeFakeRuntime();
});
afterEach(async () => {
  for (const view of [...liveManager.sessions.values()]) await liveManager.delete(view.id);
  for (const mux of muxes) await mux.close();
  muxes = [];
  agentOverview.refresh();
});

async function open(t: TestContext, hash = '', mobile = false) {
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1200, height: 800 },
    isMobile: mobile, hasTouch: mobile, serviceWorkers: 'block',
  });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.goto(`${base}/${hash}`);
  return page;
}
const row = (page: Page, muxId: string) => page.locator(`#agent-list .agent-row[data-mux-id="${muxId}"]`);
const shown = (page: Page, muxId: string) => page.locator(`#agent-list .agent-row.active[data-mux-id="${muxId}"]`).waitFor();
const groups = (page: Page) => page.locator('#agent-list .agent-group').evaluateAll(nodes => nodes.map(node => [
  node.querySelector('.agent-group-name')!.textContent,
  [...node.querySelectorAll<HTMLElement>('.agent-row')].map(item => `${item.style.getPropertyValue('--depth')}:${item.querySelector('.agent-name')!.textContent}`),
]));
const views = (muxId: string) => [...liveManager.sessions.values()].filter(view => view.attachment?.muxId === muxId);

test('agents group by directory in creation order with workers nested and finished workers folded', { timeout: 15000 }, async t => {
  const first = await agent('alpha-one', alpha);
  await agent('beta-one', beta, { status: 'working' });
  await agent('alpha-two', alpha);
  await worker('worker-busy', alpha, 'alpha-one', 'working');
  await worker('worker-done', alpha, 'alpha-one', 'idle');
  agentOverview.refresh();
  const page = await open(t);
  await row(page, first.muxId).waitFor();
  assert.deepEqual(await groups(page), [
    ['alpha', ['0:alpha-one', '1:worker-busy', '0:alpha-two']],
    ['beta', ['0:beta-one']],
  ]);
  assert.equal(await page.locator('#agents-summary .agent-working').innerText(), '◐ 2 working');
  await page.locator('.agent-finished', { hasText: '1 finished' }).click();
  assert.deepEqual((await groups(page))[0], ['alpha', ['0:alpha-one', '1:worker-busy', '1:worker-done', '0:alpha-two']]);
  await page.locator('.agent-group-fold', { hasText: 'beta' }).click();
  assert.deepEqual((await groups(page))[1], ['beta', []]);
});

test('a row shows its agent with the active highlight; a group + starts an agent in that directory', { timeout: 15000 }, async t => {
  const one = await agent('alpha-one', alpha);
  await agent('beta-one', beta);
  agentOverview.refresh();
  const page = await open(t);
  await row(page, one.muxId).click();
  await shown(page, one.muxId);
  assert.equal(await page.locator('#agent-title-name').innerText(), 'alpha-one');
  assert.equal(await page.locator('#agent-list .agent-row.active').count(), 1);

  const calls = launcher.calls.length;
  await page.locator('.agent-group', { hasText: 'beta' }).locator('.agent-group-add').click();
  await until(() => launcher.muxes.length && launcher.calls.length === calls + 1, 'the + starts an agent');
  assert.equal(launcher.calls.at(-1)!.cwd, beta);
  const started = launcher.muxes.at(-1)!;
  muxes.push(started);
  agentOverview.refresh();
  await shown(page, started.muxId);
  assert.ok(page.url().endsWith(`#agent=${encodeURIComponent(started.muxId)}`), page.url());
  assert.equal(await page.locator('.agent-group', { hasText: 'beta' }).locator(`.agent-row[data-mux-id="${started.muxId}"]`).count(), 1);
});

test('✕ closes the shown agent and an unshown one by identity, without confirmation', { timeout: 15000 }, async t => {
  const shownAgent = await agent('alpha-one', alpha);
  const other = await agent('alpha-two', alpha);
  agentOverview.refresh();
  const stops: string[] = [];
  const stop = liveManager.runtime.stop;
  liveManager.runtime.stop = async (muxId: string, options: { operationId?: string } = {}) => {
    stops.push(muxId);
    await muxes.find(mux => mux.muxId === muxId)!.close();
    return { protocol: 2, muxId, operationId: options.operationId ?? 'stop', state: 'stopped', code: 0, signal: null, stoppedAt: 'synthetic-time' };
  };
  t.after(() => { liveManager.runtime.stop = stop; });
  const page = await open(t, `#agent=${encodeURIComponent(shownAgent.muxId)}`);
  page.on('dialog', dialog => { void dialog.dismiss(); assert.fail('Close must not ask for confirmation'); });
  await shown(page, shownAgent.muxId);
  await row(page, other.muxId).hover();
  await row(page, other.muxId).locator('.agent-close').click();
  await row(page, other.muxId).waitFor({ state: 'detached', timeout: 4000 });
  await row(page, shownAgent.muxId).hover();
  await row(page, shownAgent.muxId).locator('.agent-close').click();
  await row(page, shownAgent.muxId).waitFor({ state: 'detached', timeout: 4000 });
  assert.deepEqual(stops, [other.muxId, shownAgent.muxId]);
  assert.equal(new URL(page.url()).hash, '');
  assert.equal(await page.locator('#agent-title-name').innerText(), 'Tau');
});

test('the summary counts what needs attention and opens the next blocked agent', { timeout: 15000 }, async t => {
  const one = await agent('alpha-one', alpha);
  const blocked = await agent('beta-one', beta);
  agentOverview.refresh();
  const page = await open(t, `#agent=${encodeURIComponent(one.muxId)}`);
  await shown(page, one.muxId);
  // This root arrived after the test server started; showing it clears its New mark.
  await row(page, blocked.muxId).click();
  await shown(page, blocked.muxId);
  await page.locator('#agents-summary[disabled]').waitFor();
  await row(page, one.muxId).click();
  await shown(page, one.muxId);
  blocked.publish({ status: 'blocked', blocked: { reason: 'dialog', title: 'Pick a fruit' } });
  agentOverview.refresh();
  await page.locator('#agents-summary', { hasText: '◉ 1 blocked' }).waitFor();
  assert.match(await row(page, blocked.muxId).innerText(), /blocked · Pick a fruit/);
  await page.locator('#agents-summary').click();
  await shown(page, blocked.muxId);
});

test('a view no browser shows is released after the delay while its agent keeps running', { timeout: 15000 }, async t => {
  const delay = liveManager.releaseDelayMs;
  liveManager.releaseDelayMs = 200;
  t.after(() => { liveManager.releaseDelayMs = delay; });
  const stops: string[] = [];
  const stop = liveManager.runtime.stop;
  liveManager.runtime.stop = async (muxId: string) => { stops.push(muxId); throw new Error('release must not stop an agent'); };
  t.after(() => { liveManager.runtime.stop = stop; });
  const left = await agent('alpha-one', alpha);
  const kept = await agent('beta-one', beta);
  agentOverview.refresh();
  const page = await open(t);
  await row(page, left.muxId).click();
  await shown(page, left.muxId);
  await until(() => views(left.muxId).length === 1 && left.connections.size === 1, 'the shown agent is attached');
  await row(page, kept.muxId).click();
  await shown(page, kept.muxId);
  await until(() => views(left.muxId).length === 0 && left.connections.size === 0, 'the view nobody shows is released');
  assert.equal(views(kept.muxId).length, 1, 'the shown view stays attached');
  assert.deepEqual(stops, []);
  assert.ok(fs.existsSync(left.jsonPath), 'the released agent keeps running');
  await row(page, left.muxId).waitFor();
  // Showing it again reattaches the same runtime.
  await row(page, left.muxId).click();
  await shown(page, left.muxId);
  await until(() => views(left.muxId).length === 1, 'reattached');
});

const groupFold = (page: Page, name: string) => page.getByRole('button', { name: `Hide ${name}`, exact: true })
  .or(page.getByRole('button', { name: `Show ${name}`, exact: true }));
const namedGroup = (page: Page, name: string) => page.locator('.agent-space-group').filter({ has: groupFold(page, name) });
const groupDirectory = (page: Page, name: string, directory: string) =>
  namedGroup(page, name).getByRole('button', { name: `Hide ${directory}`, exact: true });

async function createGroup(page: Page, name: string, ...directories: string[]) {
  await page.getByRole('button', { name: 'New group', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New group', exact: true });
  await dialog.getByRole('textbox', { name: 'Group name' }).fill(name);
  for (const directory of directories) await dialog.getByRole('checkbox', { name: directory, exact: true }).check();
  await dialog.getByRole('button', { name: 'Create group', exact: true }).click();
  await namedGroup(page, name).waitFor();
}

async function openGroupAction(page: Page, group: string, action: 'Rename' | 'Edit members' | 'Dissolve', tap = false) {
  const band = namedGroup(page, group);
  const menu = band.getByRole('button', { name: `Actions for ${group}`, exact: true });
  const choice = band.getByRole('button', { name: action, exact: true });
  if (tap) {
    await menu.tap();
    await choice.tap();
  } else {
    await menu.click();
    await choice.click();
  }
}

for (const mobile of [false, true]) {
  test(`nested worker rows step in by parent identity on ${mobile ? 'phone' : 'desktop'}`, { timeout: 15000 }, async t => {
    const root = await agent('alpha-one', alpha);
    const other = await agent('beta-one', beta);
    // Workers can run in a different directory from their parent. The one whose
    // cwd matches the neighboring root still belongs under alpha-one.
    const child = await worker('child', beta, 'alpha-one', 'working');
    const grandchild = await worker('grandchild', beta, 'child', 'working');
    await worker('finished-grandchild', beta, 'child', 'idle');
    const page = await open(t, '', mobile);
    await row(page, grandchild.muxId).waitFor();
    await createGroup(page, 'Work', alpha);
    const band = namedGroup(page, 'Work');
    assert.deepEqual(await band.locator('.agent-row').evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.muxId)),
      [root.muxId, child.muxId, grandchild.muxId]);
    assert.equal(await band.locator(`[data-mux-id="${other.muxId}"]`).count(), 0);

    const drawer = page.getByRole('button', { name: 'Toggle sidebar', exact: true });
    await row(page, grandchild.muxId).click();
    if (mobile) {
      await page.locator('#sidebar.collapsed').waitFor();
      await drawer.tap();
    }
    await shown(page, grandchild.muxId);
    assert.equal(await band.locator('.agent-space-band.contains-active').count(), 1);

    const offsets = await band.locator('.agent-row, .agent-finished').evaluateAll(rows => rows.map(row => ({
      left: row.getBoundingClientRect().left,
      right: row.getBoundingClientRect().right,
    })));
    const [rootBox, childBox, grandchildBox, finishedBox] = offsets;
    assert.equal(childBox.left - rootBox.left, 16);
    assert.equal(grandchildBox.left - childBox.left, 16);
    assert.equal(finishedBox.left, grandchildBox.left);
    assert.ok(offsets.every(box => Math.abs(box.right - rootBox.right) < 1), 'all rows share one right edge');

    const fold = groupFold(page, 'Work');
    await fold.click();
    assert.equal(await fold.getAttribute('aria-expanded'), 'false');
    await row(page, grandchild.muxId).waitFor({ state: 'hidden' });
    assert.equal(await band.locator('.agent-space-band.contains-active').count(), 1);
    await fold.click();
    await shown(page, grandchild.muxId);
  });
}

test('named groups stage changes, move directories, rename and dissolve without stopping agents', { timeout: 18000 }, async t => {
  const first = await agent('alpha-one', alpha);
  const second = await agent('beta-one', beta);
  const page = await open(t);
  await row(page, first.muxId).waitFor();
  await row(page, second.muxId).waitFor();
  await createGroup(page, 'Development', alpha, beta);
  await groupDirectory(page, 'Development', alpha).waitFor();
  await groupDirectory(page, 'Development', beta).waitFor();
  await createGroup(page, 'Review', beta);
  await groupDirectory(page, 'Review', beta).waitFor();
  assert.equal(await groupDirectory(page, 'Development', beta).count(), 0, 'moving a directory leaves just one membership');
  await groupDirectory(page, 'Development', alpha).waitFor();

  await openGroupAction(page, 'Review', 'Rename');
  const rename = page.getByRole('dialog', { name: 'Rename group', exact: true });
  await rename.getByRole('textbox', { name: 'Group name' }).fill('Ready');
  await rename.getByRole('button', { name: 'Save', exact: true }).click();
  await groupDirectory(page, 'Ready', beta).waitFor();

  await openGroupAction(page, 'Ready', 'Edit members');
  const editor = page.getByRole('dialog', { name: 'Edit group members', exact: true });
  const alphaMember = editor.getByRole('checkbox', { name: alpha, exact: true });
  const betaMember = editor.getByRole('checkbox', { name: beta, exact: true });
  assert.equal(await betaMember.isChecked(), true);
  await alphaMember.check();
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  await groupDirectory(page, 'Development', alpha).waitFor();
  assert.equal(await groupDirectory(page, 'Ready', alpha).count(), 0);

  await openGroupAction(page, 'Ready', 'Edit members');
  await alphaMember.check();
  await betaMember.uncheck();
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await groupDirectory(page, 'Ready', alpha).waitFor();
  assert.equal(await groupDirectory(page, 'Ready', beta).count(), 0);
  const topLevel = (directory: string) => page.locator('#agent-list > .agent-group')
    .getByRole('button', { name: `Hide ${directory}`, exact: true });
  await topLevel(beta).waitFor();

  await openGroupAction(page, 'Ready', 'Dissolve');
  await topLevel(alpha).waitFor();
  await topLevel(beta).waitFor();
  await namedGroup(page, 'Ready').waitFor({ state: 'detached' });
  await row(page, first.muxId).click();
  await shown(page, first.muxId);
  assert.ok(fs.existsSync(first.jsonPath) && fs.existsSync(second.jsonPath), 'dissolve leaves both runtimes running');
});

test('named membership survives reload and a directory temporarily having no agents', { timeout: 15000 }, async t => {
  const first = await agent('alpha-one', alpha);
  const page = await open(t);
  await row(page, first.muxId).waitFor();
  await createGroup(page, 'Environment', alpha);
  await groupDirectory(page, 'Environment', alpha).waitFor();
  await first.close();
  await row(page, first.muxId).waitFor({ state: 'detached' });
  await namedGroup(page, 'Environment').waitFor();
  await page.reload();
  await namedGroup(page, 'Environment').waitFor();
  await openGroupAction(page, 'Environment', 'Edit members');
  const editor = page.getByRole('dialog', { name: 'Edit group members', exact: true });
  assert.equal(await editor.getByRole('checkbox', { name: alpha, exact: true }).isChecked(), true);
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  const replacement = await agent('alpha-returned', alpha);
  await groupDirectory(page, 'Environment', alpha).waitFor();
  await namedGroup(page, 'Environment').getByRole('button', { name: /alpha-returned/ }).waitFor();

  const independent = await open(t);
  await row(independent, replacement.muxId).waitFor();
  assert.equal(await namedGroup(independent, 'Environment').count(), 0, 'a separate browser profile has its own groups');
});

test('a phone can edit a group and tap its folded badge to attach once to the newest result', { timeout: 18000 }, async t => {
  // Start the newest result's agent first to distinguish completion from creation order.
  const newest = await agent('newest-result', beta, { status: 'working' });
  const older = await agent('older-result', alpha, { status: 'working' });
  const page = await open(t, '', true);
  const drawer = page.getByRole('button', { name: 'Toggle sidebar', exact: true });
  // With no active agent, the mobile drawer opens automatically.
  await row(page, older.muxId).waitFor();
  await row(page, newest.muxId).waitFor();
  await createGroup(page, 'Work', alpha, beta);
  await openGroupAction(page, 'Work', 'Rename', true);
  const editor = page.getByRole('dialog', { name: 'Rename group', exact: true });
  await editor.getByRole('textbox', { name: 'Group name' }).fill('Results');
  await editor.getByRole('button', { name: 'Save', exact: true }).tap();
  const band = namedGroup(page, 'Results');
  const fold = groupFold(page, 'Results');
  await fold.tap();
  assert.equal(await fold.getAttribute('aria-expanded'), 'false');
  await row(page, older.muxId).waitFor({ state: 'hidden' });

  older.publish({ status: 'idle' });
  const one = band.getByRole('button', { name: 'Results: 1 done', exact: true });
  await one.waitFor();
  assert.equal((await one.innerText()).trim(), '●');
  await one.focus();
  newest.publish({ status: 'idle' });
  const two = band.getByRole('button', { name: 'Results: 2 done', exact: true });
  await two.waitFor();
  assert.equal((await two.innerText()).replace(/\s/g, ''), '●2');
  assert.equal(await two.evaluate(button => button === document.activeElement), true, 'a discovery redraw preserves badge focus');

  const attaches: unknown[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/live-sessions/attach') {
      attaches.push(request.postDataJSON());
    }
  });
  await two.tap();
  await page.waitForURL(url => url.hash === `#agent=${newest.muxId}`);
  await page.locator('#agent-title-name', { hasText: 'newest-result' }).waitFor();
  await until(() => views(newest.muxId).length === 1 && newest.connections.size === 1, 'only one live attachment to the newest result');
  await page.locator('#sidebar.collapsed').waitFor();
  await drawer.tap();
  await one.waitFor();
  assert.equal(await fold.getAttribute('aria-expanded'), 'false');
  await row(page, newest.muxId).waitFor({ state: 'hidden' });
  assert.equal(attaches.length, 1);
  assert.equal(older.connections.size, 0);
});
