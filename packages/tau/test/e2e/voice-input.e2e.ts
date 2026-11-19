import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { WebSocketServer, type WebSocket } from 'ws';
import { handleVoiceSocket } from '../../bin/voice.js';
import type { TranscriberEvents, VoiceSetting } from '@phimacs/sound';

// Dictation in real Chromium with its fake microphone, against the compiled UI
// and Tau's real voice socket handler with a fake transcriber (no inference).
const publicDir = fileURLToPath(new URL('../../public/', import.meta.url));
const sessions = ['one', 'two'].map(id => ({ id, cwd: '/test', sessionName: id, sessionFile: `/test/${id}.jsonl`, isStreaming: false,
  inputReady: true, runtimeContext: { sessionFile: `/test/${id}.jsonl`, leafId: null, contextId: `context-${id}` },
  attached: { muxId: `agent-${id}`, host: null, placement: 'root', name: null } }));
const agents = sessions.map((session, index) => ({ muxId: session.attached.muxId, name: session.sessionName, cwd: '/test', status: 'idle',
  detail: null, placement: 'root', host: null, sessionFile: session.sessionFile, model: null, startedAt: `2026-11-06T10:00:0${index}.000Z`, parentId: null }));

type Recording = { bytes: number; receivedBytes: number; finished: boolean; closed: boolean; signal: AbortSignal };
let recordings: Recording[] = [];
let backendReady: Promise<void> | undefined;
let prompts = 0;
/** Prompts the composer sent over Tau's socket. */
let sent: string[] = [];
/** The voice setting, live partial and final transcript of the next recording. */
let setting: VoiceSetting;
let transcript = '';
let base = '';
let browser: Browser;
const sockets = new Set<WebSocket>();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://fixture');
  const json = (data: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
  if (url.pathname === '/api/live-sessions') return json({ sessions });
  if (url.pathname === '/api/live-sessions/attach') {
    let body = '';
    for await (const chunk of req) body += chunk;
    return json({ session: sessions.find(s => s.attached.muxId === JSON.parse(body).muxId), attached: true, started: false });
  }
  const snapshot = /^\/api\/live-sessions\/(\w+)\/snapshot$/.exec(url.pathname);
  if (snapshot) return json({ session: sessions.find(s => s.id === snapshot[1]), entries: [], isStreaming: false });
  if (url.pathname === '/api/rpc') {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (/"prompt"/.test(body)) prompts++;
    return json({ success: true, data: {} });
  }
  if (url.pathname === '/api/health') return json({ platform: 'linux' });
  if (url.pathname === '/api/sessions') return json({ projects: [] });
  const file = path.resolve(publicDir, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
  if (!file.startsWith(publicDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
  const type: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
  res.setHeader('Content-Type', type[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
const wss = new WebSocketServer({ noServer: true });
const voiceWss = new WebSocketServer({ noServer: true });
server.on('upgrade', (request, socket, head) => {
  if (request.url === '/ws/voice') {
    voiceWss.handleUpgrade(request, socket, head, ws => {
      sockets.add(ws);
      handleVoiceSocket(ws, () => ({ setting, open: async (events: TranscriberEvents, signal: AbortSignal) => {
        const recording: Recording = { bytes: 0, receivedBytes: 0, finished: false, closed: false, signal };
        ws.on('message', (data: Buffer, binary) => { if (binary) recording.receivedBytes += data.length; });
        recordings.push(recording);
        await backendReady;
        return {
          backend: 'fake',
          transcriber: {
            // One live partial, as a real backend sends none during silence.
            write(pcm: Buffer) {
              const before = recording.bytes;
              recording.bytes += pcm.length;
              if (before < 3200 && recording.bytes >= 3200) events.partial(transcript === 'dictated words' ? 'dictated' : transcript);
            },
            async finish() { recording.finished = true; return transcript; },
            close() { recording.closed = true; },
          },
        };
      } }));
    });
  } else if (request.url === '/ws') {
    wss.handleUpgrade(request, socket, head, ws => {
      sockets.add(ws);
      ws.on('message', data => {
        const message = JSON.parse(String(data));
        if (message.type === 'prompt') sent.push(message.message);
      });
      ws.send(JSON.stringify({ type: 'state', liveSessions: sessions, agents }));
    });
  } else socket.destroy();
});

before(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
  const executablePath = [process.env.CHROMIUM_BINARY, chromium.executablePath(), '/usr/bin/chromium', '/usr/bin/chromium-browser']
    .find(candidate => candidate && fs.existsSync(candidate));
  assert.ok(executablePath, 'Install Chromium or set CHROMIUM_BINARY to run this focused browser test');
  browser = await chromium.launch({
    executablePath,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--host-resolver-rules=MAP insecure.test 127.0.0.1'],
  });
});
after(async () => {
  await browser?.close();
  for (const socket of sockets) socket.terminate();
  await new Promise<void>(resolve => voiceWss.close(() => resolve()));
  await new Promise<void>(resolve => wss.close(() => resolve()));
  await new Promise<void>(resolve => server.close(() => resolve()));
});
beforeEach(() => {
  recordings = []; prompts = 0; sent = []; backendReady = undefined;
  setting = { backend: 'fake', options: {}, mode: 'type', sendWordMs: 50 };
  transcript = 'dictated words';
});

async function open(origin = base) {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1000, height: 800 } });
  await context.addInitScript(() => {
    // Keep every captured stream reachable so the test can check its tracks ended.
    const streams: MediaStream[] = [];
    const contexts: AudioContext[] = [];
    Object.assign(window, { voiceStreams: streams, voiceContexts: contexts });
    const BrowserAudioContext = AudioContext;
    window.AudioContext = class extends BrowserAudioContext {
      constructor(options?: AudioContextOptions) {
        super(options);
        contexts.push(this);
      }
    };
    const original = navigator.mediaDevices?.getUserMedia.bind(navigator.mediaDevices);
    if (original) navigator.mediaDevices.getUserMedia = async (constraints) => { const stream = await original(constraints); streams.push(stream); return stream; };
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/#agent=agent-one`);
  await page.waitForSelector('.agent-row.active[data-mux-id="agent-one"]');
  return { page, errors, close: () => context.close() };
}

const tracksEnded = (page: Page) => page.evaluate(() =>
  (window as unknown as { voiceStreams: MediaStream[] }).voiceStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')));

async function until(condition: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function holdBackend() {
  let ready!: () => void;
  backendReady = new Promise<void>(resolve => { ready = resolve; });
  return ready;
}

test('dictation waits for backend readiness and inserts one marked final transcript without submitting', { timeout: 15000 }, async () => {
  const ready = holdBackend();
  const { page, errors, close } = await open();
  try {
    const input = page.locator('#message-input');
    await input.fill('Hello world');
    await input.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(5, 5));
    await page.click('#mic-btn');
    await until(() => recordings.length === 1);
    // Let the real audio clock run beyond a frame while the backend is held.
    await page.waitForFunction(() => (window as unknown as { voiceContexts: AudioContext[] }).voiceContexts[0]?.currentTime >= 0.25);
    assert.equal(recordings[0].receivedBytes, 0);
    assert.equal(recordings[0].signal.aborted, false);
    await page.waitForSelector('#voice-status >> text=Preparing speech backend');
    ready();
    await until(() => (recordings[0]?.bytes ?? 0) >= 6400);
    await page.waitForSelector('#voice-status >> text=Listening: dictated');
    assert.equal(await input.inputValue(), 'Hello world', 'partial text is previewed, not inserted');
    await page.click('#mic-btn');
    await page.waitForFunction(() => (document.getElementById('message-input') as HTMLTextAreaElement).value !== 'Hello world');
    assert.equal(await input.inputValue(), 'Hello (dictated) dictated words world');
    assert.equal(recordings.length, 1);
    assert.equal(recordings[0].finished, true);
    await until(() => recordings[0].closed);
    assert.equal(await page.locator('#mic-btn.recording, #mic-btn.transcribing').count(), 0);
    assert.equal(await tracksEnded(page), true);
    assert.equal(prompts, 0);
    assert.deepEqual(sent, []);
    assert.deepEqual(errors, []);
  } finally { ready(); await close(); }
});

test('a trailing send word stops by itself, releases the microphone and submits the marked transcript once', { timeout: 15000 }, async () => {
  transcript = 'run the tests, send';
  const { page, errors, close } = await open();
  try {
    await page.click('#mic-btn');
    await until(() => recordings[0]?.finished === true);
    await until(() => sent.length === 1 && recordings[0].closed);
    await page.waitForFunction(() => !document.getElementById('mic-btn')!.classList.contains('recording'));
    assert.deepEqual(sent, ['(dictated) run the tests']);
    assert.equal(await page.locator('#message-input').inputValue(), '');
    assert.equal(await tracksEnded(page), true);
    assert.equal(recordings.length, 1);
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test('a trailing clear word discards the dictation and keeps the draft', { timeout: 15000 }, async () => {
  transcript = 'scratch all of that, clear stop';
  const { page, errors, close } = await open();
  try {
    const input = page.locator('#message-input');
    await input.fill('keep me');
    await page.click('#mic-btn');
    await page.waitForSelector('#voice-status >> text=Dictation cleared');
    assert.equal(await input.inputValue(), 'keep me');
    assert.equal(await tracksEnded(page), true);
    assert.deepEqual(sent, []);
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test('send mode submits a hand-stopped transcript once', { timeout: 15000 }, async () => {
  setting = { ...setting, mode: 'send' };
  const { page, errors, close } = await open();
  try {
    await page.click('#mic-btn');
    await page.waitForSelector('#voice-status >> text=Listening: dictated');
    await page.click('#mic-btn');
    await until(() => sent.length === 1 && recordings[0].closed);
    assert.deepEqual(sent, ['(dictated) dictated words']);
    assert.equal(await page.locator('#message-input').inputValue(), '');
    assert.equal(await tracksEnded(page), true);
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test('stopping before the backend is ready cancels without sending audio or inserting text', { timeout: 15000 }, async () => {
  const ready = holdBackend();
  const { page, errors, close } = await open();
  try {
    const input = page.locator('#message-input');
    await input.fill('unchanged draft');
    await page.click('#mic-btn');
    await until(() => recordings.length === 1);
    await page.waitForSelector('#voice-status >> text=Preparing speech backend');
    await page.click('#mic-btn');
    await page.waitForSelector('#voice-status >> text=Recording cancelled');
    await until(() => recordings[0].signal.aborted);
    ready();
    await until(() => recordings[0].closed);
    assert.equal(recordings[0].receivedBytes, 0);
    assert.equal(recordings[0].finished, false);
    assert.equal(await tracksEnded(page), true);
    assert.equal(await input.inputValue(), 'unchanged draft');
    assert.equal(prompts, 0);
    assert.deepEqual(errors, []);
  } finally { ready(); await close(); }
});

test('switching agents cancels dictation and keeps the unchanged draft with its agent', async () => {
  const { page, errors, close } = await open();
  try {
    await page.locator('#message-input').fill('draft');
    await page.click('#mic-btn');
    await until(() => (recordings[0]?.bytes ?? 0) > 0);
    await page.click('.agent-row[data-mux-id="agent-two"]');
    await until(() => recordings[0].closed);
    assert.equal(recordings[0].finished, false);
    await page.waitForFunction(() => !document.getElementById('mic-btn')!.classList.contains('recording'));
    assert.equal(await tracksEnded(page), true);
    assert.equal(await page.locator('#message-input').inputValue(), '');
    assert.match(await page.locator('#recovered-input .queued-msg-text').innerText(), /agent-one: draft$/);
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test('insecure origins explain that voice input needs HTTPS', async () => {
  const { page, close } = await open(base.replace('127.0.0.1', 'insecure.test'));
  try {
    await page.waitForSelector('#mic-btn.unavailable');
    await page.click('#mic-btn');
    await page.waitForSelector('#voice-status.error >> text=Voice input needs HTTPS');
    assert.equal(recordings.length, 0);
  } finally { await close(); }
});
