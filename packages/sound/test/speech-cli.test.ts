import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { test } from 'node:test';
import { runCli } from '../src/cli.ts';
import { createSoundRuntime, wav, writeVoiceSetting, type OutputSink, type VoiceSetting } from '../src/index.ts';

function temporary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sound-speak-cli-'));
  return { dir, close: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
function output() {
  let text = '';
  const stream = new Writable({ write(chunk, _encoding, callback) { text += String(chunk); callback(); } });
  return { stream, get text() { return text; } };
}
async function speechServer() {
  const received: { authorization?: string; body: Record<string, unknown> }[] = [];
  const host = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const data of req) chunks.push(Buffer.from(data));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    received.push({ authorization: req.headers.authorization, body });
    res.end(body.response_format === 'wav' ? wav(Buffer.alloc(32)) : Buffer.from('OggS synthetic opus'));
  });
  host.listen(0, '127.0.0.1');
  await once(host, 'listening');
  const address = host.address();
  assert.ok(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}`, received, close() { host.closeAllConnections(); host.close(); } };
}

test('CLI speak saves Ogg Opus, plays through the sink, reads stdin and keeps the exit protocol', async (t) => {
  const temp = temporary(); t.after(temp.close);
  const server = await speechServer(); t.after(() => server.close());
  const played: Buffer[] = [];
  // Empty buffers are device probes, not speech.
  const sink: OutputSink = { async play(pcm) { if (pcm.length) played.push(pcm); return 'synthetic-speaker'; }, async notify() { return null; } };
  let setting: VoiceSetting = { backend: null, options: {}, mode: 'type',
    speech: { backend: 'openai-speech', options: { url: server.url, model: 'tts', voice: 'marin', authProvider: 'openai' } } };
  const providers: string[] = [];
  const runtime = createSoundRuntime({ output: sink, readSetting: () => setting,
    credentials: async (provider) => { providers.push(provider); return 'sk-synthetic'; } });
  const run = async (args: string[], stdin: Readable = Readable.from([])) => {
    const stdout = output(); const stderr = output();
    const code = await runCli(args, { runtime, agentDir: temp.dir, stdin, stdout: stdout.stream, stderr: stderr.stream });
    return { code, stdout: stdout.text, stderr: stderr.text };
  };

  const out = path.join(temp.dir, 'hello.ogg');
  const saved = await run(['speak', '--voice', 'cedar', '--instructions', 'warm', '--out', out, 'Hello there.']);
  assert.equal(saved.code, 0, saved.stderr);
  assert.deepEqual(JSON.parse(saved.stdout), { type: 'speech', path: out, mediaType: 'audio/ogg', bytes: 19, backend: 'openai-speech', voice: 'cedar' });
  assert.equal(fs.readFileSync(out, 'utf8'), 'OggS synthetic opus');
  assert.deepEqual(server.received[0], { authorization: 'Bearer sk-synthetic',
    body: { model: 'tts', input: 'Hello there.', voice: 'cedar', response_format: 'opus', instructions: 'warm' } });

  const spoken = await run(['speak', '--play', '-'], Readable.from([Buffer.from('From standard input.\n')]));
  assert.equal(spoken.code, 0, spoken.stderr);
  assert.deepEqual(JSON.parse(spoken.stdout), { type: 'played', backend: 'openai-speech', device: 'synthetic-speaker', chunks: 1 });
  assert.equal(server.received[1].body.input, 'From standard input.');
  assert.equal(server.received[1].body.response_format, 'wav');
  assert.equal(played.length, 1);
  assert.deepEqual(providers, ['openai', 'openai']);

  for (const args of [['speak'], ['speak', '--play', '--out', out, 'x'], ['speak', '--bad', 'x'], ['speak', 'a', 'b'], ['speak', '--voice', '', 'x']]) {
    const result = await run(args);
    assert.equal(result.code, 2, args.join(' '));
    assert.match(result.stderr, /Usage: .*speak/);
  }
  const existing = await run(['speak', '--out', out, 'Again.']);
  assert.equal(existing.code, 1);
  assert.match(existing.stderr, /EEXIST/);
  setting = { backend: null, options: {}, mode: 'type' };
  const disabled = await run(['speak', 'x']);
  assert.equal(disabled.code, 1);
  assert.match(disabled.stderr, /Speech is disabled/);
  assert.equal(server.received.length, 2);
});

test('real CLI speak resolves the API key from Pi auth in the agent directory', { timeout: 15_000 }, async (t) => {
  const temp = temporary(); t.after(temp.close);
  const server = await speechServer(); t.after(() => server.close());
  fs.writeFileSync(path.join(temp.dir, 'auth.json'), JSON.stringify({ openai: { type: 'api_key', key: 'sk-synthetic-stored' } }), { mode: 0o600 });
  writeVoiceSetting(temp.dir, { backend: null, options: {}, mode: 'type',
    speech: { backend: 'openai-speech', options: { url: server.url, model: 'tts', voice: 'marin', authProvider: 'openai' } } });
  const out = path.join(temp.dir, 'speech.ogg');
  const { OPENAI_API_KEY: _ambient, ...env } = process.env;
  const child = spawn(process.execPath, [path.join(import.meta.dirname, '../src/main.ts'), 'speak', '--out', out, 'Stored key.'], {
    env: { ...env, PI_CODING_AGENT_DIR: temp.dir }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
  child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
  const [code] = await once(child, 'close');
  assert.equal(code, 0, stderr);
  assert.equal(JSON.parse(stdout).path, out);
  assert.equal(server.received[0].authorization, 'Bearer sk-synthetic-stored');
  assert.equal(stdout.includes('sk-synthetic') || stderr.includes('sk-synthetic'), false);
});
