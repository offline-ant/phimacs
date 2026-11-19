import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createClaimTestEnvironment } from '@phimacs/pimux/ownership';
import { WebSocket } from 'ws';

test('a composed Tau CLI reads the selected transcription backend and options on every connection', { timeout: 10_000 }, async t => {
  const runtime = createClaimTestEnvironment();
  const auth = `Basic ${Buffer.from('voice-user:voice-pass').toString('base64')}`;
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/voice-composition.ts', import.meta.url))], {
    env: { ...runtime.env, HOME: runtime.root, PATH: process.env.PATH,
      PHIMACS_PI: fileURLToPath(new URL('./cli.js', import.meta.resolve('@earendil-works/pi-coding-agent'))),
      PI_CODING_AGENT_DIR: runtime.root, PI_CODING_AGENT_SESSION_DIR: runtime.sessions,
      TAU_HOST: '127.0.0.1', TAU_PORT: '0', TAU_HTTP_PORT: '0', TAU_USER: 'voice-user', TAU_PASS: 'voice-pass' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  let failure = '';
  child.stderr.setEncoding('utf8').on('data', (data: string) => { failure += data; });
  t.after(async () => {
    child.kill('SIGKILL');
    try { await exited; }
    finally { fs.rmSync(runtime.root, { recursive: true, force: true }); }
  });
  let authority: string | undefined;
  const output = createInterface({ input: child.stdout });
  for await (const line of output) {
    authority = /loopback HTTP\): http:\/\/(127\.0\.0\.1:\d+)/.exec(line)?.[1];
    if (authority) break;
  }
  assert.ok(authority, `Composed Tau did not listen: ${failure}`);

  async function utterance() {
    const ws = new WebSocket(`ws://${authority}/ws/voice`, { headers: { Origin: `http://${authority}`, Authorization: auth } });
    const frames: unknown[] = [];
    ws.on('message', data => {
      const frame = JSON.parse(String(data));
      frames.push(frame);
      if (frame.type === 'ready') {
        ws.send(Buffer.alloc(2));
        ws.send(JSON.stringify({ type: 'stop' }));
      }
    });
    try { await once(ws, 'close', { signal: AbortSignal.timeout(1000) }); }
    finally { ws.terminate(); }
    return frames;
  }
  const config = path.join(runtime.root, 'voice.json');
  const write = (backend: string, options: object) => fs.writeFileSync(config, JSON.stringify({ backend, options }));

  assert.deepEqual(await utterance(), [{ type: 'error', message: 'Dictation is disabled. Configure a speech backend explicitly.' }]);
  write('missing', {});
  assert.deepEqual(await utterance(), [{ type: 'error', message: 'Speech backend "missing" is not registered in this runtime.' }]);
  for (const text of ['first', 'updated']) {
    write('fixture', { text });
    assert.deepEqual(await utterance(), [{ type: 'ready', backend: 'fixture', mode: 'type', dictatedFormat: '(dictated) %s' }, { type: 'final', text }]);
  }
  write('fixture', { text: 'fail to open' });
  assert.deepEqual(await utterance(), [{ type: 'error', message: 'Fixture backend failed to open.' }]);
});
