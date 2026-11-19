import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import type { LiveSession } from '../../src/public/app-types.ts';

type Reply = { json?: unknown; status?: number; abort?: boolean };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
export function session(id: string, extra: Partial<LiveSession> = {}): LiveSession {
  const file = extra.sessionFile === undefined ? `/synthetic/${id}.jsonl` : extra.sessionFile;
  const leafId = extra.leafId === undefined ? `${id}-leaf` : extra.leafId;
  return { id, cwd: '/synthetic/project', sessionFile: file, sessionName: `Live ${id}`,
    leafId, runtimeContext: { sessionFile: file, leafId, contextId: `fixture:${file}:${leafId}` }, inputReady: true,
    model: null, isStreaming: false, shared: true,
    attached: { muxId: `mux-${id}`, host: 'emacs', placement: 'root', name: null },
    capabilities: { stop: true, navigateTree: true }, ...extra };
}
/** The pimux agent behind a view, as the sidebar lists it. */
export function agent(muxId: string, extra: Record<string, unknown> = {}) {
  return { muxId, name: `Agent ${muxId}`, cwd: '/synthetic/project', status: 'idle', detail: null, placement: 'root', host: 'emacs',
    sessionFile: null, model: null, startedAt: `2026-11-06T10:00:00.${String(muxId.length).padStart(3, '0')}Z`, parentId: null, ...extra };
}
/** Every attached view implies a running agent; explicit agents add or override rows. */
export function agentsFor(sessions: LiveSession[], extra: Array<{ muxId: string }> = []) {
  const byMux = new Map<string, unknown>();
  for (const item of sessions) if (item.attached) byMux.set(item.attached.muxId, agent(item.attached.muxId, { sessionFile: item.sessionFile,
    placement: item.attached.placement }));
  for (const item of extra) byMux.set(item.muxId, item);
  return [...byMux.values()];
}
export function snapshot(value: LiveSession, marker = value.sessionName, generation = 1) {
  return { sessionId: value.id, session: value, sessionFile: value.sessionFile, isStreaming: !!value.isStreaming, generation,
    dialogs: [], entries: [{ type: 'message', id: value.leafId, message: { role: 'user', content: marker } }] };
}
export async function launchBrowser() {
  const executablePath = [process.env.CHROMIUM_BINARY, chromium.executablePath(), '/usr/bin/chromium', '/usr/bin/chromium-browser']
    .find(candidate => candidate && fs.existsSync(candidate));
  assert.ok(executablePath, 'Install Chromium or set CHROMIUM_BINARY');
  return chromium.launch({ executablePath });
}
export async function openUI(browser: Browser, initial = [session('a'), session('b')]) {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1100, height: 800 } });
  const page = await context.newPage();
  const errors: string[] = [], requests: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];
  const holds = new Map<string, Array<{ called: ReturnType<typeof deferred<void>>; reply: ReturnType<typeof deferred<Reply>>; done: ReturnType<typeof deferred<void>> }>>();
  const publicDir = path.resolve(fileURLToPath(new URL('../../public/', import.meta.url)));
  const live = new Map(initial.map(item => [item.id, item]));
  const stored = ['owned-a', 'owned-b', 'resume'].map(id => ({ filePath: `/synthetic/project/${id}.jsonl`, file: `${id}.jsonl`, dir: 'project',
    name: id, owner: id.startsWith('owned') ? { name: id, host: 'emacs' } : null }));
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    assert.equal(url.host, 'tau.invalid', 'The fixture never accesses services or another host');
    const body = request.method() === 'POST' ? request.postDataJSON() as Record<string, unknown> : null;
    requests.push({ method: request.method(), path: url.pathname, body });
    const held = holds.get(`${url.pathname}#${body?.type || ''}`)?.shift() || holds.get(url.pathname)?.shift();
    if (held) {
      held.called.resolve();
      const result = await held.reply.promise;
      if (result.abort) await route.abort();
      else await route.fulfill({ status: result.status || 200, json: result.json || {} });
      // The app's await/json continuation has run, not merely the network response.
      await page.waitForFunction(id => Reflect.get(window, 'fixtureCompletedReads').has(id), Number(request.headers()['x-fixture-read']));
      held.done.resolve();
      return;
    }
    if (url.pathname === '/api/sessions') return route.fulfill({ json: { projects: [{ path: '/synthetic/project', dirName: 'project', count: 3, lastActive: 0 }] } });
    if (url.pathname === '/api/sessions/project') return route.fulfill({ json: { sessions: stored } });
    if (url.pathname.startsWith('/api/sessions/project/')) {
      const name = url.pathname.split('/').at(-1)!;
      return route.fulfill({ json: { entries: [{ type: 'message', message: { role: 'user', content: `history ${name}` } }], offset: 10, reset: false } });
    }
    const selected = url.pathname.match(/^\/api\/live-sessions\/([^/]+)\/snapshot$/)?.[1];
    if (selected) return route.fulfill({ json: snapshot(live.get(selected) || session(selected)) });
    if (url.pathname === '/api/live-sessions') return route.fulfill({ json: { sessions: [...live.values()] } });
    if (url.pathname === '/api/live-sessions/attach') {
      const found = [...live.values()].reverse().find(item => item.attached?.muxId === body?.muxId);
      return route.fulfill(found ? { json: { session: found, attached: true, started: false } } : { status: 404, json: { error: 'Agent not found' } });
    }
    if (url.pathname.endsWith('/stop')) {
      const id = decodeURIComponent(url.pathname.split('/').at(-2)!);
      // Close by view id, or by agent identity for an agent no view here shows.
      const muxId = url.pathname.startsWith('/api/agents/') ? id : live.get(id)?.attached?.muxId;
      live.delete(id);
      return route.fulfill({ json: { receipt: { state: 'stopped', muxId } } });
    }
    if (url.pathname === '/api/rpc') return route.fulfill({ json: { success: true, data: body?.type === 'get_available_models' ? { models: [] }
      : body?.type === 'get_state' ? { isStreaming: false, isCompacting: false }
      : body?.type === 'clear_queue' ? { steering: [], followUp: [] } : {} } });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { success: true, sessions: [], projects: [], platform: 'linux' } });
    const file = path.resolve(publicDir, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404 });
    const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
    return route.fulfill({ body: fs.readFileSync(file), contentType: types[path.extname(file)] || 'application/octet-stream' });
  });
  await context.addInitScript(({ sessions, agents }) => {
    const sent: unknown[] = [], views: unknown[] = [], confirmations: string[] = [], intervals = new Map<number, () => void>();
    const completedReads = new Set<number>();
    let nextRead = 0;
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const id = ++nextRead, headers = new Headers(init?.headers);
      headers.set('x-fixture-read', String(id));
      const finished = () => setTimeout(() => completedReads.add(id), 0);
      try {
        const response = await originalFetch(input, { ...init, headers });
        const json = response.json.bind(response);
        response.json = async () => { try { return await json(); } finally { finished(); } };
        return response;
      } catch (error) { finished(); throw error; }
    };
    let instancePoll: (() => void) | undefined;
    let nextInterval = 100000;
    const originalInterval = window.setInterval.bind(window), originalClear = window.clearInterval.bind(window);
    window.setInterval = ((fn: () => void, ms: number) => {
      if (ms !== 3000 && ms !== 10000) return originalInterval(fn, ms);
      const id = nextInterval++;
      if (ms === 3000) intervals.set(id, fn);
      else instancePoll = fn;
      return id;
    }) as typeof window.setInterval;
    window.clearInterval = (id) => { if (typeof id === 'number') intervals.delete(id); originalClear(id); };
    window.confirm = text => { confirmations.push(text || ''); return true; };
    let socket: Socket;
    let initialConnection = true;
    class Socket {
      static OPEN = 1; static CONNECTING = 0; static CLOSING = 2; static CLOSED = 3;
      readyState = 0;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      constructor() {
        socket = this;
        // Only the first connection opens automatically. Tests control every
        // restart boundary, independently of the client's reconnect backoff.
        if (initialConnection) {
          initialConnection = false;
          setTimeout(() => { this.readyState = 1; this.onopen?.(new Event('open'));
            this.onmessage?.({ data: JSON.stringify({ type: 'state', liveSessions: sessions, agents }) }); }, 0);
        }
      }
      // View declarations are bookkeeping for the server's release delay, not input.
      send(text: string) { const message = JSON.parse(text); (message.type === 'view' ? views : sent).push(message); }
      close() { this.readyState = 3; }
    }
    Object.defineProperty(window, 'WebSocket', { value: Socket });
    Object.assign(window, { fixtureCompletedReads: completedReads, fixtureSent: sent, fixtureViews: views, fixtureConfirmations: confirmations,
      fixtureEmit: (message: unknown) => socket.onmessage?.({ data: JSON.stringify(message) }),
      fixtureDisconnect: () => { socket.readyState = Socket.CLOSED; socket.onclose?.(new CloseEvent('close', { code: 1006 })); },
      fixtureReconnect: (message: unknown) => { socket.readyState = Socket.OPEN; socket.onopen?.(new Event('open'));
        socket.onmessage?.({ data: JSON.stringify(message) }); },
      fixturePollInstances: () => { void instancePoll?.(); },
      fixturePoll: () => { for (const fn of intervals.values()) fn(); }, fixturePollCount: () => intervals.size });
  }, { sessions: initial, agents: agentsFor(initial) });
  // A browser shows the agent its URL names: the first view's.
  const first = initial[0]?.attached?.muxId;
  await page.goto(`https://tau.invalid/${first ? `#agent=${encodeURIComponent(first)}` : ''}`);
  if (first) await page.locator('#messages', { hasText: initial[0].sessionName || '' }).waitFor();
  else await page.waitForFunction(() => (document.getElementById('message-input') as HTMLTextAreaElement).placeholder !== 'Connecting...');
  await frames(page);
  // Tests count only the requests they cause.
  requests.length = 0;
  const muxOf = (id: string) => live.get(id)?.attached?.muxId ?? `mux-${id}`;
  return { page, errors, requests, live,
    hold(path: string, command?: string) {
      const entry = { called: deferred<void>(), reply: deferred<Reply>(), done: deferred<void>() };
      const key = command ? `${path}#${command}` : path;
      const list = holds.get(key) || []; list.push(entry); holds.set(key, list);
      return { called: entry.called.promise,
        resolve(json: unknown, status = 200) { entry.reply.resolve({ json, status }); return entry.done.promise; },
        reject() { entry.reply.resolve({ abort: true }); return entry.done.promise; } };
    },
    async emit(message: unknown) { await page.evaluate(value => Reflect.get(window, 'fixtureEmit')(value), message); },
    async disconnect() { await page.evaluate(() => Reflect.get(window, 'fixtureDisconnect')()); },
    async reconnect(sessions: LiveSession[] = [], agents: Array<{ muxId: string }> = []) {
      await page.evaluate(value => Reflect.get(window, 'fixtureReconnect')(value), { type: 'state', liveSessions: sessions, agents: agentsFor(sessions, agents) });
    },
    async pollInstances() { await page.evaluate(() => Reflect.get(window, 'fixturePollInstances')()); },
    /** Opens a saved session from History. */
    async stored(name: string) {
      if (await page.locator('.history-toggle[aria-expanded="false"]').count()) await page.locator('.history-toggle').click();
      if (!await page.locator('.history-session').count()) await page.locator('.history-project').click();
      await page.locator('.history-session', { has: page.locator('.history-session-title', { hasText: new RegExp(`^${name}$`) }) }).click();
    },
    /** Shows a view's agent through its sidebar row. */
    async select(id: string) { await page.locator(`.agent-row[data-mux-id="${muxOf(id)}"]`).click(); },
    /** The ✕ on a view's agent row, which a desktop shows on hover. */
    async closeRow(id: string) {
      const row = page.locator(`.agent-row[data-mux-id="${muxOf(id)}"]`);
      await row.hover();
      await row.locator('.agent-close').click();
    },
    /** The header's name for the shown agent: its session name, or Tau when none is shown. */
    async shown() { return page.locator('#agent-title-name').innerText(); },
    async hash() { return page.evaluate(() => location.hash); },
    async menu(label: string) { await page.locator('#header-menu-btn').click(); await page.locator('.header-menu-item', { hasText: label }).click(); },
    async command(label: string) { await page.locator('#command-btn').click(); await page.locator('.command-item', { hasText: label }).click(); },
    async flush() { await frames(page); },
    async close() { await context.close(); assert.deepEqual(errors, []); },
  };
}
export async function frames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
