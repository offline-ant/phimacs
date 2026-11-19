import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { WebSocketServer, type WebSocket } from 'ws';

// The URL names the agent a browser shows (`#agent=<muxId>`). Actual compiled UI
// with a read-only fake backend: no Pi subprocess, inference or Tau service.
const publicDir = fileURLToPath(new URL('../../public/', import.meta.url));
const ids = ['mux/one+&', 'two'];
const sessions = ids.map((muxId, index) => ({
  id: `view-${index}`, cwd: '/test', sessionName: `Agent ${index}`, sessionFile: `/test/${index}.jsonl`, isStreaming: false,
  inputReady: true, runtimeContext: { sessionFile: `/test/${index}.jsonl`, leafId: null, contextId: `context-${index}` },
  attached: { muxId, host: null, placement: 'root', name: null },
}));
const agents = sessions.map((session, index) => ({ muxId: session.attached.muxId, name: session.sessionName, cwd: '/test', status: 'idle',
  detail: null, placement: 'root', host: null, sessionFile: session.sessionFile, model: null, startedAt: `2026-11-06T10:00:0${index}.000Z`, parentId: null }));
const requests: string[] = [];
const received: Array<{ type: string; sessionId?: string | null }> = [];
let base = '';
let browser: Browser;
const sockets = new Set<WebSocket>();
const contexts = new Set<BrowserContext>();
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://fixture');
  let body = '';
  for await (const chunk of req) body += String(chunk);
  const json = (data: unknown, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
  if (url.pathname.startsWith('/api/') && url.pathname !== '/api/rpc') requests.push(`${req.method} ${url.pathname}${body ? ` ${body}` : ''}`);
  if (url.pathname === '/api/live-sessions') return json({ sessions });
  if (url.pathname === '/api/live-sessions/attach') {
    const found = sessions.find(session => session.attached.muxId === JSON.parse(body).muxId);
    return found ? json({ session: found, attached: true, started: false }) : json({ error: 'Unknown agent' }, 404);
  }
  const snapshot = /^\/api\/live-sessions\/(.+)\/snapshot$/.exec(url.pathname);
  if (snapshot) return json({ session: sessions.find(session => session.id === decodeURIComponent(snapshot[1])), entries: [], isStreaming: false });
  if (url.pathname === '/api/rpc') return json({ success: true, data: {} });
  if (url.pathname === '/api/health') return json({ platform: 'linux' });
  if (url.pathname === '/api/sessions') return json({ projects: [] });
  const file = path.resolve(publicDir, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
  if (!file.startsWith(publicDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
  const type: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
  res.setHeader('Content-Type', type[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', socket => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  socket.on('message', data => received.push(JSON.parse(String(data))));
  socket.send(JSON.stringify({ type: 'state', liveSessions: [], agents }));
});

before(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
  const executablePath = [process.env.CHROMIUM_BINARY, chromium.executablePath(), '/usr/bin/chromium', '/usr/bin/chromium-browser']
    .find(candidate => candidate && fs.existsSync(candidate));
  assert.ok(executablePath, 'Install Chromium or set CHROMIUM_BINARY to run this focused browser test');
  browser = await chromium.launch({ executablePath });
});
after(async () => {
  for (const context of contexts) await context.close();
  await browser?.close();
  for (const socket of sockets) socket.terminate();
  await new Promise<void>(resolve => wss.close(() => resolve()));
  await new Promise<void>(resolve => server.close(() => resolve()));
});

async function open(hash: string) {
  requests.length = 0;
  received.length = 0;
  const context = await browser.newContext({ serviceWorkers: 'block' });
  contexts.add(context);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/${hash}`);
  return { page, errors, async close() { await context.close(); contexts.delete(context); } };
}
const hashOf = (muxId: string) => `#agent=${encodeURIComponent(muxId)}`;
async function shows(page: Page, muxId: string) {
  await page.locator(`.agent-row.active[data-mux-id="${muxId}"]`).waitFor();
  await page.waitForSelector('#message-input:not([disabled])');
  assert.equal(await page.locator('#agent-title-name').innerText(), agents.find(agent => agent.muxId === muxId)!.name);
}
async function until(condition: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`condition not met: ${JSON.stringify(received)}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
const attaches = () => requests.filter(request => request.startsWith('POST /api/live-sessions/attach')).map(request => JSON.parse(request.split(' ').slice(2).join(' ')).muxId);

test('a link names the agent to show by its exact mux id, attaches only that one and declares the view', async () => {
  const view = await open(hashOf(ids[0]));
  try {
    await shows(view.page, ids[0]);
    assert.deepEqual(attaches(), [ids[0]]);
    assert.equal(requests.some(request => /^POST \/api\/live-sessions(\/resume)?( |$)/.test(request)), false, 'a link never starts or resumes an agent');
    assert.equal(new URL(view.page.url()).hash, hashOf(ids[0]));
    await until(() => received.some(message => message.type === 'view' && message.sessionId === sessions[0].id));
    assert.deepEqual(view.errors, []);
  } finally { await view.close(); }
});

test('choosing an agent replaces the URL without a history entry, and reloading returns to it', async () => {
  const view = await open('');
  try {
    await view.page.locator(`.agent-row[data-mux-id="${ids[0]}"]`).click();
    await shows(view.page, ids[0]);
    const length = await view.page.evaluate(() => history.length);
    await view.page.locator(`.agent-row[data-mux-id="${ids[1]}"]`).click();
    await shows(view.page, ids[1]);
    assert.equal(new URL(view.page.url()).hash, hashOf(ids[1]));
    assert.equal(await view.page.evaluate(() => history.length), length);
    await view.page.reload();
    await shows(view.page, ids[1]);
    assert.deepEqual(view.errors, []);
  } finally { await view.close(); }
});

test('a changed fragment shows the agent it names', async () => {
  const view = await open(hashOf(ids[0]));
  try {
    await shows(view.page, ids[0]);
    await view.page.evaluate(hash => { location.hash = hash; }, hashOf(ids[1]));
    await shows(view.page, ids[1]);
    assert.deepEqual(attaches(), ids);
    assert.deepEqual(view.errors, []);
  } finally { await view.close(); }
});

test('an unknown agent is reported and nothing is shown; a malformed fragment attaches nothing', async () => {
  const unknown = await open(hashOf('gone'));
  try {
    await unknown.page.locator('#status-text', { hasText: 'Unknown agent' }).waitFor();
    assert.deepEqual(attaches(), ['gone']);
    assert.equal(await unknown.page.locator('.agent-row.active').count(), 0);
    assert.equal(await unknown.page.locator('#message-input').isDisabled(), true);
  } finally { await unknown.close(); }
  const malformed = await open('#agent=%FF');
  try {
    await malformed.page.locator('.agent-row').first().waitFor();
    await malformed.page.waitForFunction(() => (document.getElementById('message-input') as HTMLTextAreaElement).placeholder === 'Select or start an agent to chat');
    assert.deepEqual(attaches(), []);
    assert.equal(await malformed.page.locator('.agent-row.active').count(), 0);
    assert.deepEqual(malformed.errors, []);
  } finally { await malformed.close(); }
});
