import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import { speakerSamples, wav, wavSamples, writeVoiceSetting } from '../src/index.ts';
import { fakeSocket, shareDir } from './share-fixture.ts';

const main = path.join(import.meta.dirname, '../src/main.ts');
const emacs = process.env.EMACS || 'emacs';
const hasEmacs = spawnSync(emacs, ['--version'], { stdio: 'ignore' }).status === 0;
const sound = (name: string) => wavSamples(fs.readFileSync(new URL(`../sounds/${name}.wav`, import.meta.url)));

/** Selected agent and share directories in an otherwise empty environment. */
function environment(dir: string, share = path.join(dir, 'share')) {
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir,
    PI_CODING_AGENT_DIR: path.join(dir, 'agent'), PHIMACS_SHARE_DIR: share };
}

/** Run the CLI with an open standard input until it exits. */
async function run(t: TestContext, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [main, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
  child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
  const [code] = await once(child, 'close');
  return { code, stdout, stderr };
}

test('the CLI uses shared devices selected in settings for dictation, sounds and notifications', async (t) => {
  const dir = shareDir(t);
  const env = environment(dir);
  fs.mkdirSync(env.PHIMACS_SHARE_DIR, { mode: 0o700 });
  let audio = Buffer.alloc(0);
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    audio = Buffer.concat(chunks);
    res.setHeader('content-type', 'application/json');
    res.end('{"text":"shared microphone"}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  writeVoiceSetting(env.PI_CODING_AGENT_DIR, { backend: 'local', options: { url: `http://127.0.0.1:${address.port}` },
    mode: 'type', share: true });

  const pcm = Buffer.from([10, 0, 20, 0, 30, 0]);
  // This device ends the recording itself after its audio; control standard input stays open.
  const mic = net.createServer((socket) => socket.end(pcm));
  mic.listen(path.join(env.PHIMACS_SHARE_DIR, 'laptop-2f3a.mic.sock'));
  await once(mic, 'listening');
  t.after(() => mic.close());
  const recording = await run(t, ['dictate'], env);
  assert.equal(recording.code, 0, recording.stderr);
  const messages = recording.stdout.trim().split('\n').map((line) => JSON.parse(line) as { type: string; device?: string; text?: string });
  assert.deepEqual(messages.map((message) => [message.type, message.device ?? message.text]),
    [['ready', 'laptop'], ['final', 'shared microphone']]);
  assert.ok(audio.includes(pcm), 'the transcription request carries the device PCM');

  const speaker = await fakeSocket(t, env.PHIMACS_SHARE_DIR, 'laptop-2f3a', 'speaker');
  const notify = await fakeSocket(t, env.PHIMACS_SHARE_DIR, 'laptop-2f3a', 'notify');
  assert.equal((await run(t, ['play', 'done'], env)).code, 0);
  assert.deepEqual(await speaker.next(), sound('done'));
  assert.equal((await run(t, ['notify', 'Agent finished', 'Tests pass'], env)).code, 0);
  assert.equal((await notify.next()).toString(), 'Agent finished\nTests pass');

  speaker.close();
  const missing = await run(t, ['play', 'request'], env);
  assert.equal(missing.code, 1);
  assert.equal(missing.stderr, `pi-sound: No shared speaker device answers in ${env.PHIMACS_SHARE_DIR}.\n`);
  notify.close();
  await fakeSocket(t, env.PHIMACS_SHARE_DIR, 'laptop-2f3a', 'speaker', { drop: true });
  await fakeSocket(t, env.PHIMACS_SHARE_DIR, 'laptop-2f3a', 'notify', { drop: true });
  const playDropped = await run(t, ['play', 'done'], env);
  assert.equal(playDropped.code, 1);
  assert.match(playDropped.stderr, /^pi-sound: Shared speaker device laptop failed: /);
  const notifyDropped = await run(t, ['notify', 'Agent finished'], env);
  assert.equal(notifyDropped.code, 1);
  assert.match(notifyDropped.stderr, /^pi-sound: Shared notification device laptop failed: /);
});

test('speech playback probes and plays on the shared speaker, never synthesizing without one', async (t) => {
  const dir = shareDir(t);
  const env = environment(dir);
  fs.mkdirSync(env.PHIMACS_SHARE_DIR, { mode: 0o700 });
  const requests: string[] = [];
  const synthesized = wav(Buffer.from([0, 1, 0, 2, 0, 3, 0, 4]));
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()).input as string);
    res.end(synthesized);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  writeVoiceSetting(env.PI_CODING_AGENT_DIR, { backend: null, options: {}, mode: 'type', share: true,
    speech: { backend: 'openai-speech', options: { url: `http://127.0.0.1:${address.port}`, model: 'tts', voice: 'marin' } } });

  const absent = await run(t, ['speak', '--play', 'Nobody listens.'], env);
  assert.equal(absent.code, 1);
  assert.match(absent.stderr, /No shared speaker device answers/);
  assert.deepEqual(requests, []);

  // A forward that accepts and closes is no device either: nothing is synthesized.
  const dropped = await fakeSocket(t, env.PHIMACS_SHARE_DIR, 'phone-0b1c', 'speaker', { drop: true });
  const reset = await run(t, ['speak', '--play', 'Nobody reads.'], env);
  assert.equal(reset.code, 1);
  assert.match(reset.stderr, /^pi-sound: Shared speaker device phone failed: /);
  assert.equal(dropped.connections, 1);
  assert.deepEqual(requests, []);
  dropped.close();

  const speaker = await fakeSocket(t, env.PHIMACS_SHARE_DIR, 'desk-4b5c', 'speaker');
  const played = await run(t, ['speak', '--play', 'Shared speech.'], env);
  assert.equal(played.code, 0, played.stderr);
  assert.deepEqual(JSON.parse(played.stdout), { type: 'played', backend: 'openai-speech', device: 'desk', chunks: 1 });
  assert.deepEqual(await speaker.next(), Buffer.alloc(2), 'one silent sample probes the device');
  assert.deepEqual(await speaker.next(), speakerSamples(synthesized));
  assert.deepEqual(requests, ['Shared speech.']);
});

test('share-dir creates and prints the private share directory, refusing a wrong one', async (t) => {
  const dir = shareDir(t);
  const share = path.join(dir, 'runtime', 'share');
  const created = await run(t, ['share-dir'], environment(dir, share));
  assert.equal(created.code, 0, created.stderr);
  assert.equal(created.stdout, `${share}\n`);
  assert.equal(fs.statSync(share).mode & 0o777, 0o700);
  fs.chmodSync(share, 0o755);
  const refused = await run(t, ['share-dir'], environment(dir, share));
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /Refusing share directory/);
  assert.equal((await run(t, ['share-dir'], environment(dir, 'relative'))).code, 1);
});

test('pi-deck notifications reach the shared device through the Emacs hook', { skip: !hasEmacs && 'needs Emacs' }, async (t) => {
  const dir = shareDir(t);
  const env = environment(dir);
  fs.mkdirSync(env.PHIMACS_SHARE_DIR, { mode: 0o700 });
  writeVoiceSetting(env.PI_CODING_AGENT_DIR, { backend: null, options: {}, mode: 'type', share: true });
  const speaker = await fakeSocket(t, env.PHIMACS_SHARE_DIR, 'phone-8d9e', 'speaker');
  const notify = await fakeSocket(t, env.PHIMACS_SHARE_DIR, 'phone-8d9e', 'notify');
  const program = path.join(dir, 'pi-sound');
  fs.writeFileSync(program, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(main)} "$@"\n`, { mode: 0o700 });
  const lisp = path.join(import.meta.dirname, '../emacs');
  // Asynchronous, so the fake devices in this process can answer while Emacs waits for its CLI.
  const child = spawn(emacs, ['-Q', '--batch', '--eval', '(setq load-prefer-newer t)', '-L', lisp, '-l', 'pi-sound', '--eval', `(progn
    (setq pi-sound-program ${JSON.stringify(program)})
    (pi-sound-deck-notify 'blocked "Agent blocked" "Needs an answer" nil)
    (let ((deadline (+ (float-time) 10)))
      (while (and (seq-some #'process-live-p (process-list)) (< (float-time) deadline))
        (accept-process-output nil 0.05)))
    (kill-emacs (if (seq-some #'process-live-p (process-list)) 1 0)))`],
  { env, stdio: ['ignore', 'ignore', 'pipe'], timeout: 15_000 });
  let stderr = '';
  child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
  const [code] = await once(child, 'close');
  assert.equal(code, 0, stderr);
  assert.deepEqual(await speaker.next(), sound('request'));
  assert.equal((await notify.next()).toString(), 'Agent blocked\nNeeds an answer');
});
