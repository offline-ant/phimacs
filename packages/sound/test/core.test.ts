import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import {
  BackendRegistry, createSoundRuntime, configuredTranscriber, parseVoiceSetting, readVoiceSetting,
  setMode, startDictation, streamCapture, transcriberFor, writeVoiceSetting,
  type DictationMessage, type SoundRuntime, type Transcriber, type TranscriberEvents,
} from '../src/index.ts';
import { runCli } from '../src/cli.ts';

function temporary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sound-core-'));
  return { dir, close: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function recorder() {
  const chunks: Buffer[] = [];
  let closed = 0;
  const transcriber: Transcriber = {
    write: (chunk) => { chunks.push(Buffer.from(chunk)); },
    finish: async () => 'hello world',
    close: () => { closed++; },
  };
  return { transcriber, chunks, get closed() { return closed; } };
}
function output() {
  let text = '';
  const stream = new Writable({ write(chunk, _encoding, callback) { text += String(chunk); callback(); } });
  return { stream, get text() { return text; } };
}

// Missing/unregistered backends fail before any capture, network or credential discovery.
test('missing settings disable recording and never touch any other file or capture', async (t) => {
  const temp = temporary(); t.after(temp.close);
  const reads: string[] = [];
  const original = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
    reads.push(String(args[0]));
    return Reflect.apply(original, fs, args);
  });
  let captures = 0;
  const runtime = createSoundRuntime({ capture: { open() { captures++; throw new Error('must not capture'); } } });
  assert.deepEqual(runtime.readSetting(temp.dir), { backend: null, options: {}, mode: 'type' });
  await assert.rejects(configuredTranscriber(temp.dir, runtime)({ partial() {}, error() {} }, new AbortController().signal), /disabled/);
  const stdout = output();
  assert.equal(await runCli(['dictate'], { runtime, agentDir: temp.dir, stdin: new PassThrough(), stdout: stdout.stream }), 0);
  assert.equal(captures, 0);
  assert.ok(reads.every((file) => file === path.join(temp.dir, 'voice.json')));
  assert.equal(JSON.parse(stdout.text).type, 'error');
});

test('private atomic settings, arbitrary IDs, validation and mode do not enable backend', (t) => {
  const temp = temporary(); t.after(temp.close);
  const dir = path.join(temp.dir, 'new');
  assert.equal(setMode(dir, 'toggle').backend, null);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, 'voice.json')).mode & 0o777, 0o600);
  writeVoiceSetting(dir, { backend: 'plugin.custom-1', options: { project: 'synthetic' }, mode: 'send' });
  assert.equal(readVoiceSetting(dir).backend, 'plugin.custom-1');
  for (const value of [[], { backend: '' }, { extra: true }, { mode: 'bad' }, { options: [] }, { options: { bad: NaN } }, { capture: { command: 'x', args: [1] } }, { dictatedFormat: 1 }, { dictatedFormat: 'no slot' }, { dictatedFormat: '%s and %s' }, { sendWordMs: '1000' }, { sendWordMs: 0 }, { sendWord: 1 }, { clearWord: 1 }]) {
    assert.throws(() => parseVoiceSetting(value));
  }
  fs.writeFileSync(path.join(dir, 'voice.json'), '{bad');
  assert.throws(() => setMode(dir, 'type'), /Invalid voice configuration/);
  assert.equal(fs.readFileSync(path.join(dir, 'voice.json'), 'utf8'), '{bad');
});

test('registry instances are independent and plugin options validate before opening', async () => {
  let opened = 0;
  const backend = new BackendRegistry().register('custom', {
    validate(value) { assert.deepEqual(value, { accepted: true }); return { accepted: true }; },
    open() { opened++; return recorder().transcriber; },
  });
  assert.throws(() => transcriberFor({ backend: 'custom', options: {}, mode: 'type' }, backend));
  assert.throws(() => new BackendRegistry().prepare('custom'), /not registered/);
  assert.equal(opened, 0);
  const open = transcriberFor({ backend: 'custom', options: { accepted: true }, mode: 'type' }, backend);
  const result = await open({ partial() {}, error() {} }, new AbortController().signal);
  assert.equal(result.backend, 'custom');
  assert.equal(opened, 1);
  result.transcriber.close();
});

test('await backend readiness before capture; retain odd samples; one terminal result', async () => {
  const ready = deferred<Transcriber>();
  const announced = deferred<void>();
  const stream = new PassThrough();
  const recorded = recorder();
  let captureOpened = false;
  const messages: DictationMessage[] = [];
  const dictation = startDictation({
    open: async () => ({ backend: 'synthetic', transcriber: await ready.promise }),
    capture: { open(signal) { captureOpened = true; return streamCapture(stream, 'synthetic').open(signal); } },
    emit(message) { messages.push(message); if (message.type === 'ready') announced.resolve(); },
  });
  await setImmediate();
  assert.equal(captureOpened, false);
  ready.resolve(recorded.transcriber);
  await announced.promise;
  stream.write(Buffer.from([1]));
  stream.write(Buffer.from([2, 3]));
  stream.end(Buffer.from([4, 5]));
  await dictation.done;
  dictation.stop(); dictation.cancel();
  assert.deepEqual(Buffer.concat(recorded.chunks), Buffer.from([1, 2, 3, 4]));
  assert.deepEqual(messages.map((message) => message.type), ['ready', 'final']);
  assert.equal(recorded.closed, 1);
});

test('"send" plus 1 s or any 4 s pause after speech stops and sends; manual stops send only on the word', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const stop of ['word', 'pause', 'manual word', 'manual'] as const) {
    const stream = new PassThrough();
    const ready = deferred<void>();
    const messages: DictationMessage[] = [];
    let events!: TranscriberEvents;
    let latest = '';
    const dictation = startDictation({
      open: async (handlers) => {
        events = handlers;
        return { backend: 'fake', transcriber: { write() {}, finish: async () => latest, close() {} } };
      },
      // The one audio chunk below must not run into the no-audio limit.
      capture: streamCapture(stream), idleMs: 60_000,
      emit(message) { messages.push(message); if (message.type === 'ready') ready.resolve(); },
    });
    await ready.promise;
    stream.write(Buffer.from([1, 2]));
    const say = (text: string) => { latest = text; events.partial(text); };
    const stopped = async () => { await setImmediate(); return messages.some((message) => message.type === 'final'); };
    // No speech yet: silence never stops the recording.
    t.mock.timers.tick(10_000);
    assert.equal(await stopped(), false);
    if (stop === 'word') {
      say('Send');
      t.mock.timers.tick(999);
      // Speaking on cancels the pending stop; a longer word is not "send".
      say('Send it to Bob, then resend');
      t.mock.timers.tick(3_999);
      assert.equal(await stopped(), false);
      say('Send it to Bob. Send.');
      t.mock.timers.tick(1_000);
      await dictation.done;
      assert.deepEqual(messages.at(-1), { type: 'final', text: 'Send it to Bob.', send: true });
    } else if (stop === 'pause') {
      say('Fix the build');
      t.mock.timers.tick(3_999);
      assert.equal(await stopped(), false);
      t.mock.timers.tick(1);
      await dictation.done;
      assert.deepEqual(messages.at(-1), { type: 'final', text: 'Fix the build', send: true });
    } else {
      say(stop === 'manual' ? 'Fix the build' : 'Fix the build, send');
      dictation.stop();
      await dictation.done;
      assert.deepEqual(messages.at(-1), { type: 'final', text: 'Fix the build',
        ...(stop === 'manual' ? {} : { send: true }) });
    }
  }
});

test('the send and clear words are configurable, may be phrases, and "" disables them', async () => {
  const cases = [
    [{ sendWord: 'over and out' }, 'Deploy it. Over, and out.', { type: 'final', text: 'Deploy it.', send: true }],
    [{ sendWord: '' }, 'Fix it, send', { type: 'final', text: 'Fix it, send' }],
    // The default clear word discards the dictation, also after the send word.
    [{}, 'Fix it, send. Clear, stop.', { type: 'final', text: '', clear: true }],
    [{}, 'Keep this clear stopwatch', { type: 'final', text: 'Keep this clear stopwatch' }],
    [{ clearWord: 'never mind' }, 'Fix it. Never mind!', { type: 'final', text: '', clear: true }],
    [{ clearWord: '' }, 'Fix it, clear stop', { type: 'final', text: 'Fix it, clear stop' }],
  ] as const;
  for (const [words, said, expected] of cases) {
    const stream = new PassThrough();
    const messages: DictationMessage[] = [];
    const dictation = startDictation({ ...words,
      open: async () => ({ backend: 'fake', transcriber: { write() {}, finish: async () => said, close() {} } }),
      capture: streamCapture(stream),
      emit(message) { messages.push(message); if (message.type === 'ready') stream.end(Buffer.from([1, 2])); },
    });
    await dictation.done;
    assert.deepEqual(messages.at(-1), expected);
  }
});

test('cancel while opening settles immediately and closes a late backend without capture', async () => {
  const opened = deferred<Transcriber>();
  const recorded = recorder();
  let captures = 0;
  const messages: DictationMessage[] = [];
  const dictation = startDictation({
    open: async () => ({ backend: 'fake', transcriber: await opened.promise }),
    capture: { open() { captures++; throw new Error('must not capture'); } },
    emit: (message) => messages.push(message),
  });
  await setImmediate();
  dictation.cancel();
  await dictation.done;
  opened.resolve(recorded.transcriber);
  await setImmediate();
  assert.equal(recorded.closed, 1);
  assert.equal(captures, 0);
  assert.deepEqual(messages, []);
});

test('audio limit clips exactly and marks final; idle and empty input are errors', async () => {
  for (const kind of ['limit', 'idle', 'empty'] as const) {
    const stream = new PassThrough();
    const recorded = recorder();
    const ready = deferred<void>();
    const messages: DictationMessage[] = [];
    const dictation = startDictation({
      open: async () => ({ backend: 'fake', transcriber: recorded.transcriber }),
      capture: streamCapture(stream), maxSeconds: 1 / 16_000, idleMs: 10,
      emit(message) { messages.push(message); if (message.type === 'ready') ready.resolve(); },
    });
    await ready.promise;
    if (kind === 'limit') stream.write(Buffer.from([1, 2, 3, 4]));
    else if (kind === 'empty') stream.end();
    await dictation.done;
    const terminal = messages.at(-1);
    if (kind === 'limit') {
      assert.deepEqual(terminal, { type: 'final', text: 'hello world', limited: true });
      assert.deepEqual(Buffer.concat(recorded.chunks), Buffer.from([1, 2]));
    } else assert.equal(terminal?.type, 'error');
    assert.equal(messages.filter((message) => message.type === 'final' || message.type === 'error').length, 1);
  }
});

test('backend synchronous error and thrown PCM write settle once', async () => {
  for (const kind of ['open', 'write'] as const) {
    const messages: DictationMessage[] = [];
    const stream = new PassThrough();
    const dictation = startDictation({
      open: async (events) => {
        if (kind === 'open') events.error('synthetic backend failure');
        return { backend: 'fake', transcriber: { write() { throw new Error('synthetic write failure'); }, finish: async () => '', close() {} } };
      },
      capture: streamCapture(stream),
      emit(message) { messages.push(message); if (message.type === 'ready') stream.end(Buffer.from([1, 2])); },
    });
    await dictation.done;
    assert.equal(messages.filter((message) => message.type === 'error').length, 1);
  }
});

test('CLI mode updates use the composed reader and canonical private writer', async (t) => {
  const temp = temporary(); t.after(temp.close);
  const runtime: SoundRuntime = createSoundRuntime({ readSetting: () => ({ backend: 'custom', options: { x: true }, mode: 'type' }) });
  const stdout = output();
  assert.equal(await runCli(['mode', 'toggle'], { runtime, agentDir: temp.dir, stdout: stdout.stream }), 0);
  assert.equal(readVoiceSetting(temp.dir).backend, 'custom');
  assert.equal(readVoiceSetting(temp.dir).mode, 'send');
  assert.deepEqual(JSON.parse(stdout.text), { mode: 'send' });
});

test('CLI explicit PCM source transcribes without a capture driver and preserves exit protocol', async (t) => {
  const temp = temporary(); t.after(temp.close);
  const recorded = recorder();
  const runtime = createSoundRuntime({
    backends: new BackendRegistry().register('fake', { validate: () => ({}), open: () => recorded.transcriber }),
    readSetting: () => ({ backend: 'fake', options: {}, mode: 'send' }),
  });
  const stdout = output(); const stderr = output();
  assert.equal(await runCli(['dictate', '--pcm', '-'], { runtime, agentDir: temp.dir,
    stdin: Readable.from([Buffer.from([1, 2])]), stdout: stdout.stream, stderr: stderr.stream }), 0);
  assert.deepEqual(stdout.text.trim().split('\n').map((line) => JSON.parse(line).type), ['ready', 'final']);
  assert.equal(JSON.parse(stdout.text.split('\n')[0]).mode, 'send');
  assert.equal(JSON.parse(stdout.text.split('\n')[0]).dictatedFormat, '(dictated) %s');
  assert.equal(await runCli(['bad'], { stderr: stderr.stream }), 2);
  assert.equal(await runCli(['mode', 'bad'], { stderr: stderr.stream }), 1);
  assert.equal(stderr.text.includes('Usage:'), true);
});

test('CLI dictation stops on the send or clear word after the sendWordMs setting', async (t) => {
  const temp = temporary(); t.after(temp.close);
  for (const [said, expected] of [['Fix it, send', { type: 'final', text: 'Fix it', send: true }],
    ['Fix it, clear stop', { type: 'final', text: '', clear: true }]] as const) {
    const runtime = createSoundRuntime({
      backends: new BackendRegistry().register('fake', { validate: () => ({}),
        open: (_options, events) => ({ write() { events.partial(said); }, finish: async () => said, close() {} }) }),
      readSetting: () => ({ backend: 'fake', options: {}, mode: 'type', sendWordMs: 5 }),
    });
    // Standard input stays open: only the word's delay ends the recording.
    const stdin = new PassThrough();
    stdin.write(Buffer.from([1, 2]));
    const stdout = output();
    const started = performance.now();
    assert.equal(await runCli(['dictate', '--pcm', '-'], { runtime, agentDir: temp.dir, stdin, stdout: stdout.stream }), 0);
    // Far below the one-second default.
    assert.ok(performance.now() - started < 500);
    assert.deepEqual(JSON.parse(stdout.text.trim().split('\n').at(-1)!), expected);
  }
});

test('CLI --send-word, --clear-word and --pause-ms override the settings for one recording', async (t) => {
  const temp = temporary(); t.after(temp.close);
  const said = 'Fix it, send';
  const runtime = createSoundRuntime({
    backends: new BackendRegistry().register('fake', { validate: () => ({}),
      open: () => ({ write() {}, finish: async () => said, close() {} }) }),
    readSetting: () => ({ backend: 'fake', options: {}, mode: 'type' }),
  });
  const finalOf = async (args: string[]) => {
    const stdout = output();
    assert.equal(await runCli(['dictate', ...args, '--pcm', '-'], { runtime, agentDir: temp.dir,
      stdin: Readable.from([Buffer.from([1, 2])]), stdout: stdout.stream }), 0);
    return JSON.parse(stdout.text.trim().split('\n').at(-1)!);
  };
  assert.deepEqual(await finalOf([]), { type: 'final', text: 'Fix it', send: true });
  // A target that cannot submit keeps its words and never stops by itself.
  assert.deepEqual(await finalOf(['--send-word', '', '--pause-ms', '0']), { type: 'final', text: said });
  assert.deepEqual(await finalOf(['--send-word', 'fix it, send']), { type: 'final', text: '', send: true });
  assert.deepEqual(await finalOf(['--clear-word', 'send']), { type: 'final', text: '', clear: true });
  const stderr = output();
  for (const bad of [['--pause-ms', 'soon'], ['--pause-ms'], ['--send-word', 'a', '--send-word', 'b'], ['--clear-word', 'a', '--clear-word', 'b'], ['--loud', 'x']]) {
    assert.equal(await runCli(['dictate', ...bad], { runtime, agentDir: temp.dir, stderr: stderr.stream }), 2);
  }
});

test('a zero pause never stops the recording; the send word still does', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stream = new PassThrough();
  const ready = deferred<void>();
  const messages: DictationMessage[] = [];
  let events!: TranscriberEvents;
  let latest = '';
  const dictation = startDictation({ sendPauseMs: 0, idleMs: 600_000,
    open: async (handlers) => {
      events = handlers;
      return { backend: 'fake', transcriber: { write() {}, finish: async () => latest, close() {} } };
    },
    capture: streamCapture(stream),
    emit(message) { messages.push(message); if (message.type === 'ready') ready.resolve(); },
  });
  await ready.promise;
  stream.write(Buffer.from([1, 2]));
  const say = (text: string) => { latest = text; events.partial(text); };
  say('A long thought');
  t.mock.timers.tick(60_000);
  await setImmediate();
  assert.equal(messages.some((message) => message.type === 'final'), false);
  say('A long thought, send');
  t.mock.timers.tick(1_000);
  await dictation.done;
  assert.deepEqual(messages.at(-1), { type: 'final', text: 'A long thought', send: true });
  assert.throws(() => startDictation({ sendPauseMs: -1, capture: streamCapture(new PassThrough()),
    open: async () => { throw new Error('unused'); }, emit() {} }), /Invalid dictation limits/);
});

test('early partials wait for ready and pre-cancelled input opens nothing', async () => {
  const stream = new PassThrough();
  const messages: DictationMessage[] = [];
  const transcriber = recorder().transcriber;
  const dictation = startDictation({
    open: async (events) => { events.partial('early preview'); return { backend: 'fake', transcriber }; },
    capture: streamCapture(stream),
    emit(message) {
      messages.push(message);
      if (message.type === 'ready') stream.end(Buffer.from([1, 2]));
    },
  });
  await dictation.done;
  assert.deepEqual(messages.map((message) => message.type), ['ready', 'partial', 'final']);
  const controller = new AbortController();
  controller.abort();
  let opened = 0;
  const cancelled = startDictation({ signal: controller.signal,
    open: async () => { opened++; return { backend: 'fake', transcriber }; },
    capture: streamCapture(new PassThrough()), emit() { assert.fail('Cancelled recording must be silent.'); } });
  await cancelled.done;
  await setImmediate();
  assert.equal(opened, 0);
});

test('malformed settings never echo backend option values', (t) => {
  const temp = temporary(); t.after(temp.close);
  fs.writeFileSync(path.join(temp.dir, 'voice.json'), '{"options":{"key":"synthetic-hidden"} bad');
  assert.throws(() => readVoiceSetting(temp.dir), (error: unknown) => error instanceof Error &&
    error.message.includes('malformed JSON') && !error.message.includes('synthetic-hidden'));
});
