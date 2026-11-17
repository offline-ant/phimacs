import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { writeVoiceSetting } from '../src/settings.ts';

/** Only the selected agent directory; nothing inherited selects other state or devices. */
function environment(dir: string) {
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, PI_CODING_AGENT_DIR: dir };
}

test('real CLI transcribes a PCM file even when control stdin is already EOF', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sound-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* Drain synthetic multipart audio. */ }
    res.setHeader('content-type', 'application/json');
    res.end('{"text":"file transcript"}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  writeVoiceSetting(dir, { backend: 'local', options: { url: `http://127.0.0.1:${address.port}` }, mode: 'send' });
  const file = path.join(dir, 'synthetic.pcm');
  fs.writeFileSync(file, Buffer.from([1, 2, 3, 4]));
  const child = spawn(process.execPath, [path.join(import.meta.dirname, '../src/main.ts'), 'dictate', '--pcm', file], {
    env: environment(dir), stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output: Buffer[] = []; const errors: Buffer[] = [];
  child.stdout.on('data', (data: Buffer) => output.push(data));
  child.stderr.on('data', (data: Buffer) => errors.push(data));
  const [code] = await once(child, 'close');
  assert.equal(code, 0, Buffer.concat(errors).toString());
  const messages = Buffer.concat(output).toString().trim().split('\n').map((line) => JSON.parse(line) as { type: string; text?: string; mode?: string });
  assert.deepEqual(messages.map((message) => message.type), ['ready', 'final']);
  assert.equal(messages[0].mode, 'send');
  assert.equal(messages[1].text, 'file transcript');
});

test('real CLI signal cancellation is silent after ready and releases its capture child', { timeout: 5_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sound-cli-cancel-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const capture = path.join(dir, 'capture.cjs');
  fs.writeFileSync(capture, 'setInterval(() => process.stdout.write(Buffer.from([1,2])), 5);');
  writeVoiceSetting(dir, { backend: 'local', options: { url: 'http://127.0.0.1:1' }, mode: 'type',
    capture: { command: process.execPath, args: [capture] } });
  const child = spawn(process.execPath, [path.join(import.meta.dirname, '../src/main.ts'), 'dictate'], {
    env: environment(dir), stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let output = ''; let errors = '';
  child.stderr.on('data', (data: Buffer) => { errors += data.toString(); });
  child.stdout.on('data', (data: Buffer) => {
    output += data.toString();
    if (output.includes('"type":"ready"')) child.kill('SIGTERM');
  });
  const [code] = await once(child, 'close');
  assert.equal(code, 0, errors);
  assert.deepEqual(output.trim().split('\n').map((line) => JSON.parse(line).type), ['ready']);
});
