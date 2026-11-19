import { runtimeEnvironment, projects, launcher, installFakeRuntime, closeFakeRuntime, launchBrowser, listenFakeServer } from './fake-browser-runtime.ts';
import { test, before, after } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Browser, Page } from 'playwright';

// History, the sidebar's list of saved sessions no agent runs. Real HTTP,
// browser and protocol-2 sockets, with synthetic session files.
const sessionsDir = runtimeEnvironment.sessions;

const BIG = path.join(projects, 'big');
const SMALL = path.join(projects, 'small');
const RUN = path.join(projects, 'run');
const BIG_COUNT = 13;

let base = '';
let browser: Browser | null = null;
let browserUnavailable = '';

function writeSession(projectPath: string, name: string, title: string, ageSeconds: number) {
  const dir = path.join(sessionsDir, `--${path.basename(projectPath)}--`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.jsonl`);
  const lines = [
    { type: 'session', id: name, timestamp: '2026-01-01T00:00:00.000Z', cwd: projectPath },
    { type: 'message', message: { role: 'user', content: title } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: `reply to ${title}` }] } },
  ];
  fs.writeFileSync(file, lines.map((entry, index) => JSON.stringify(index === 0 ? entry : { ...entry, id: `entry-${index}`, parentId: index === 1 ? null : `entry-${index - 1}` })).join('\n') + '\n');
  const when = new Date(Date.now() - ageSeconds * 1000);
  fs.utimesSync(file, when, when);
  return file;
}

const runFiles: string[] = [];

before(async () => {
  installFakeRuntime();
  for (const dir of [BIG, SMALL, RUN]) fs.mkdirSync(dir, { recursive: true });
  // Session 0 is the newest, session 12 the oldest.
  for (let i = 0; i < BIG_COUNT; i++) writeSession(BIG, `big-${i}`, `big session ${i}`, 60 + i);
  for (let i = 0; i < 2; i++) writeSession(SMALL, `small-${i}`, `small session ${i}`, 10 + i);
  for (let i = 0; i < 3; i++) runFiles.push(writeSession(RUN, `run-${i}`, `run session ${i}`, 30 + i));
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

async function openPage(t: TestContext): Promise<{ page: Page; sessionReads: string[] } | null> {
  if (!browser) { t.skip(browserUnavailable); return null; }
  const context = await browser.newContext({ serviceWorkers: 'block' });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on('pageerror', (error: Error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'browser must not throw'));
  const sessionReads: string[] = [];
  page.on('request', request => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith('/api/sessions')) sessionReads.push(decodeURIComponent(pathname));
  });
  await page.goto(base);
  await page.locator('#agents-summary').waitFor();
  return { page, sessionReads };
}

const project = (page: Page, name: string) => page.locator('.history-group').filter({ has: page.locator(`.history-project[title$="/${name}"]`) });
const titles = (page: Page, name: string) => project(page, name).locator('.history-session-title').allTextContents();

async function expand(page: Page, name: string) {
  await project(page, name).locator('.history-project').click();
  await project(page, name).locator('.history-session').first().waitFor();
}

test('History starts closed, then lists projects and reads a project\'s sessions only once it is expanded', async (t) => {
  const opened = await openPage(t);
  if (!opened) return;
  const { page, sessionReads } = opened;
  assert.equal(await page.locator('.history-body').isVisible(), false);
  assert.deepEqual(sessionReads, [], 'a closed History reads nothing');

  await page.click('.history-toggle');
  await project(page, 'big').waitFor();
  assert.equal(await page.locator('.history-session').count(), 0, 'projects start collapsed');
  assert.deepEqual(sessionReads, ['/api/sessions']);

  await expand(page, 'big');
  assert.deepEqual(sessionReads, ['/api/sessions', '/api/sessions/--big--']);
  assert.deepEqual(await titles(page, 'big'), Array.from({ length: 10 }, (_, i) => `Big session ${i}`));
  await project(page, 'big').locator('.history-more', { hasText: `Show all ${BIG_COUNT}` }).click();
  assert.equal((await titles(page, 'big')).length, BIG_COUNT);
  await project(page, 'big').locator('.history-more', { hasText: 'Show fewer' }).click();
  assert.equal((await titles(page, 'big')).length, 10);

  await expand(page, 'small');
  assert.equal((await titles(page, 'small')).length, 2);
  assert.equal(await project(page, 'small').locator('.history-more').count(), 0);
});

test('the title filter searches every project, beyond the ten shown, and clearing it restores the browsing state', async (t) => {
  const opened = await openPage(t);
  if (!opened) return;
  const { page } = opened;
  await page.click('.history-toggle');
  await expand(page, 'big');
  await page.fill('.history-filter', 'session 12');
  await project(page, 'big').locator('.history-session').first().waitFor();
  assert.deepEqual(await titles(page, 'big'), ['Big session 12']);
  assert.equal(await project(page, 'small').count(), 0, 'projects without a match are hidden');

  await page.fill('.history-filter', 'no such title');
  await page.locator('.history-status', { hasText: 'No matching sessions' }).waitFor();

  await page.fill('.history-filter', '');
  assert.equal((await titles(page, 'big')).length, 10);
  assert.equal(await project(page, 'small').locator('.history-project[aria-expanded="false"]').count(), 1, 'an unexpanded project folds again');
});

test('a session an agent runs is in the agent list, not History', async (t) => {
  const response = await fetch(`${base}/api/live-sessions/resume`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filePath: runFiles[0] }),
  });
  assert.equal(response.status, 200);
  const { session } = await response.json() as { session: { id: string; attached: { muxId: string } } };
  t.after(async () => { await fetch(`${base}/api/live-sessions/${session.id}`, { method: 'DELETE' }); });
  const opened = await openPage(t);
  if (!opened) return;
  const { page } = opened;
  await page.locator(`.agent-row[data-mux-id="${session.attached.muxId}"]`).waitFor();
  await page.click('.history-toggle');
  await expand(page, 'run');
  assert.deepEqual(await titles(page, 'run'), ['Run session 1', 'Run session 2']);
});

test('opening a saved session resumes it as the shown agent, which then leaves History', async (t) => {
  const opened = await openPage(t);
  if (!opened) return;
  const { page } = opened;
  await page.click('.history-toggle');
  await expand(page, 'run');
  const file = runFiles[2];
  await page.click(`.history-session[data-file-path="${file}"]`);
  await page.waitForFunction(() => document.getElementById('messages')?.textContent?.includes('reply to run session 2'));
  const mux = launcher.muxes.find(runtime => (runtime.entry.session as Record<string, unknown>).file === file);
  assert.ok(mux, 'opening resumed the session in a runtime');
  await page.locator(`.agent-row.active[data-mux-id="${mux.muxId}"]`).waitFor();
  assert.equal(new URL(page.url()).hash, `#agent=${encodeURIComponent(mux.muxId)}`);
  assert.equal(await page.locator('#message-input').isDisabled(), false);
  await page.locator(`.history-session[data-file-path="${file}"]`).waitFor({ state: 'detached' });
});
