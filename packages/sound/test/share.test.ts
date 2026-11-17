import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { registerDictation } from '../src/extension.ts';
import {
  BackendRegistry, captureFor, checkShareDirectory, connectDevice, createSoundRuntime, deliverToDevice, ensureShareDirectory, outputFor,
  parseVoiceSetting, playSpeech, shareDirectory, sharedCapture, sharedOutput, speakerSamples, startDictation, wav,
  type CaptureSource, type DictationMessage, type OutputSink, type SpeechModel, type Transcriber,
} from '../src/index.ts';
import { age, fakeSocket, refusedSocket, shareDir } from './share-fixture.ts';

test('per kind, the newest socket that accepts a connection wins', async (t) => {
  const dir = shareDir(t);
  const laptopSpeaker = await fakeSocket(t, dir, 'laptop-1a2b', 'speaker');
  const phoneSpeaker = await fakeSocket(t, dir, 'phone-3c4d', 'speaker');
  const laptopNotify = await fakeSocket(t, dir, 'laptop-1a2b', 'notify');
  const phoneNotify = await fakeSocket(t, dir, 'phone-3c4d', 'notify');
  age(laptopSpeaker.file, 30_000); age(phoneSpeaker.file, 10_000);
  age(laptopNotify.file, 5_000); age(phoneNotify.file, 20_000);
  const output = sharedOutput(dir);
  const pcm = Buffer.from([1, 0, 2, 0]);
  assert.equal(await output.play(pcm), 'phone');
  assert.equal(await output.notify('Agent finished', 'All tests pass'), 'laptop');
  assert.deepEqual(await phoneSpeaker.next(), pcm);
  assert.equal((await laptopNotify.next()).toString(), 'Agent finished\nAll tests pass');
  assert.deepEqual([laptopSpeaker.connections, phoneNotify.connections], [0, 0]);
});

test('refused sockets are skipped; only those older than a minute are pruned', async (t) => {
  const dir = shareDir(t);
  const desk = await fakeSocket(t, dir, 'desk-0001', 'mic');
  age(desk.file, 300_000);
  const fresh = path.join(dir, 'tablet-0002.mic.sock');
  const stale = path.join(dir, 'laptop-0003.mic.sock');
  refusedSocket(fresh);
  refusedSocket(stale);
  age(stale, 120_000);
  // Files outside the protocol are never connected to or removed.
  const regular = path.join(dir, 'notes-0004.mic.sock');
  fs.writeFileSync(regular, '');
  const connected = await connectDevice(dir, 'mic');
  assert.ok(connected);
  t.after(() => connected.socket.destroy());
  assert.deepEqual([connected.device, connected.id], ['desk', 'desk-0001']);
  // A fresh refused socket may be a device between bind and listen.
  assert.ok(fs.lstatSync(fresh).isSocket());
  assert.equal(fs.existsSync(stale), false);
  // An answering socket is never pruned, however old.
  assert.ok(fs.lstatSync(desk.file).isSocket());
  assert.ok(fs.existsSync(regular));
  // With nothing answering, the newest refused socket is still not pruned.
  desk.close();
  assert.equal(await connectDevice(dir, 'mic'), null);
  assert.ok(fs.lstatSync(fresh).isSocket());
});

function recorder(onBytes: (total: number) => void) {
  const chunks: Buffer[] = [];
  let total = 0;
  const transcriber: Transcriber = {
    write(chunk) { chunks.push(Buffer.from(chunk)); total += chunk.length; onBytes(total); },
    finish: async () => 'shared words',
    close() {},
  };
  return { transcriber, chunks };
}

test('a shared microphone streams whole 16-bit samples until the host closes it', async (t) => {
  const dir = shareDir(t);
  // Odd chunk boundaries split a sample across writes.
  const mic = await fakeSocket(t, dir, 'laptop-5e6f', 'mic', { send: [Buffer.from([1, 2, 3]), Buffer.from([4, 5, 6, 7, 8])] });
  const messages: DictationMessage[] = [];
  let stop = () => {};
  const recorded = recorder((total) => { if (total >= 8) stop(); });
  const dictation = startDictation({ capture: sharedCapture(dir),
    open: async () => ({ backend: 'fake', transcriber: recorded.transcriber }),
    emit: (message) => messages.push(message) });
  stop = () => dictation.stop();
  await dictation.done;
  assert.deepEqual(Buffer.concat(recorded.chunks), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
  assert.deepEqual(messages, [{ type: 'ready', device: 'laptop', backend: 'fake' },
    { type: 'final', text: 'shared words' }]);
  await mic.hostClosed;
});

test('speaker audio is complete at the host EOF; play settles when the device closes', async (t) => {
  const dir = shareDir(t);
  const speaker = await fakeSocket(t, dir, 'desk-7a8b', 'speaker');
  // Larger than socket buffers, so delivery spans many writes.
  const pcm = Buffer.alloc(2 * 44_100 * 3);
  for (let index = 0; index < pcm.length; index += 2) pcm.writeInt16LE((index % 2000) - 1000, index);
  assert.equal(await sharedOutput(dir).play(pcm), 'desk');
  assert.deepEqual(await speaker.next(), pcm);
  // An empty play probes with one silent sample.
  assert.equal(await sharedOutput(dir).play(Buffer.alloc(0)), 'desk');
  assert.deepEqual(await speaker.next(), Buffer.alloc(2));
});

test('devices that accept and close without reading make play, probes and notifications fail', async (t) => {
  const dir = shareDir(t);
  await fakeSocket(t, dir, 'laptop-0a0b', 'speaker', { drop: true });
  await fakeSocket(t, dir, 'laptop-0a0b', 'notify', { drop: true });
  const output = sharedOutput(dir);
  const failure = /^Error: Shared (speaker|notification) device laptop failed: /;
  await assert.rejects(output.play(Buffer.alloc(0)), failure);
  await assert.rejects(output.play(Buffer.from([1, 0, 2, 0])), failure);
  await assert.rejects(output.notify('Agent finished', 'Tests pass'), failure);
});

test('only an ok status line settles a delivery; failures, missing and invalid lines reject', async (t) => {
  const dir = shareDir(t);
  const pcm = Buffer.from([1, 0, 2, 0]);
  const speaker = await fakeSocket(t, dir, 'desk-6a6b', 'speaker', { status: 'error 3\n' });
  await assert.rejects(sharedOutput(dir).play(pcm), { message: 'Shared speaker device desk failed: player exited 3' });
  // The player still received everything before failing.
  assert.deepEqual(await speaker.next(), pcm);
  const notify = await fakeSocket(t, dir, 'desk-6a6b', 'notify', { status: 'error 1\n' });
  await assert.rejects(sharedOutput(dir).notify('Title', 'Body'), { message: 'Shared notification device desk failed: notifier exited 1' });
  assert.equal((await notify.next()).toString(), 'Title\nBody');
  speaker.close(); notify.close();
  for (const [status, reason] of [['', 'it closed without a status line, so delivery is uncertain'],
    ['ok', 'it sent an invalid status line'], ['ok\nok\n', 'it sent an invalid status line'],
    ['error\n', 'it sent an invalid status line']] as const) {
    const device = await fakeSocket(t, dir, 'phone-7a7b', 'speaker', { status });
    await assert.rejects(sharedOutput(dir).play(pcm), { message: `Shared speaker device phone failed: ${reason}` }, JSON.stringify(status));
    device.close();
  }
  // A failing player fails the probe too, before any speech is paid for.
  await fakeSocket(t, dir, 'laptop-8a8b', 'speaker', { status: 'error 1\n' });
  const requests: string[] = [];
  await assert.rejects(playSpeech(speechModel(requests), 'Paid words.', sharedOutput(dir), { signal: new AbortController().signal }),
    { message: 'Shared speaker device laptop failed: player exited 1' });
  assert.deepEqual(requests, []);
});

test('a signal aborted before writing closes the device connection instead of keeping it', async (t) => {
  const dir = shareDir(t);
  const speaker = await fakeSocket(t, dir, 'desk-9a9b', 'speaker', { hold: true });
  const connected = await connectDevice(dir, 'speaker');
  assert.ok(connected);
  const controller = new AbortController();
  controller.abort(new Error('stopped first'));
  await assert.rejects(deliverToDevice(connected, 'speaker', Buffer.alloc(4, 1), { signal: controller.signal }),
    { message: 'stopped first' });
  assert.equal(connected.socket.destroyed, true);
  // The device sees the connection end without any audio.
  assert.deepEqual(await speaker.next(), Buffer.alloc(0));
});

test('a device that never closes fails after its audio plus the grace; cancellation leaves audio playing', async (t) => {
  const dir = shareDir(t);
  const speaker = await fakeSocket(t, dir, 'desk-1c1d', 'speaker', { hold: true });
  const pcm = Buffer.alloc(2 * 441, 1);
  await assert.rejects(sharedOutput(dir, { closeGraceMs: 50 }).play(pcm),
    { message: 'Shared speaker device desk failed: it did not close within 60 ms' });
  assert.deepEqual(await speaker.next(), pcm);
  const controller = new AbortController();
  const playing = sharedOutput(dir).play(pcm, controller.signal);
  await speaker.next();
  controller.abort(new Error('stopped'));
  await assert.rejects(playing, { message: 'stopped' });
  // The host keeps the connection, so the device still has everything it received.
  assert.equal(speaker.connections, 2);
});

function speechModel(requests: string[]): SpeechModel {
  return { backend: 'fake-speech', maxInputLength: 100,
    async generate(request) {
      requests.push(request.text);
      return { audio: wav(Buffer.alloc(request.text.length * 2, 1)), mediaType: 'audio/wav', format: request.format };
    } };
}

test('speech is never synthesized after a probe of a device that accepts and closes', async (t) => {
  const dir = shareDir(t);
  const dropped = await fakeSocket(t, dir, 'phone-2e2f', 'speaker', { drop: true });
  const requests: string[] = [];
  const never = new AbortController().signal;
  await assert.rejects(playSpeech(speechModel(requests), 'Paid words.', sharedOutput(dir), { signal: never }),
    /^Error: Shared speaker device phone failed: /);
  assert.deepEqual(requests, []);
  dropped.close();
  // A device lost after the probe fails the chunk it drops.
  const flaky = await fakeSocket(t, dir, 'phone-3e3f', 'speaker', { drop: (connection) => connection > 1 });
  await assert.rejects(playSpeech(speechModel(requests), 'One. Two.', sharedOutput(dir), { signal: never }),
    /Shared speaker device phone failed: /);
  assert.deepEqual(await flaky.next(), Buffer.alloc(2));
  assert.deepEqual(requests, ['One. Two.']);
  // A healthy device receives each chunk after the probe.
  flaky.close();
  const healthy = await fakeSocket(t, dir, 'desk-4e4f', 'speaker');
  assert.deepEqual(await playSpeech(speechModel(requests), 'Three.', sharedOutput(dir), { signal: never }),
    { device: 'desk', chunks: 1 });
  assert.deepEqual(await healthy.next(), Buffer.alloc(2));
  assert.deepEqual(await healthy.next(), speakerSamples(wav(Buffer.alloc('Three.'.length * 2, 1))));
});

test('notifications are one UTF-8 title line, then the optional body', async (t) => {
  const dir = shareDir(t);
  const notify = await fakeSocket(t, dir, 'phone-9c0d', 'notify');
  const output = sharedOutput(dir);
  assert.equal(await output.notify('Blocked:\r\nagent ✓', 'Line one\nLine two'), 'phone');
  assert.equal((await notify.next()).toString('utf8'), 'Blocked: agent ✓\nLine one\nLine two');
  await output.notify('Done', '');
  assert.equal((await notify.next()).toString('utf8'), 'Done\n');
});

test('no answering device is a clear error, never a silent fallback', async (t) => {
  const dir = shareDir(t);
  const missing = path.join(dir, 'missing');
  await assert.rejects(sharedOutput(missing).play(Buffer.alloc(0)), { message: `No shared speaker device answers in ${missing}.` });
  await assert.rejects(sharedOutput(dir).notify('t', ''), { message: `No shared notification device answers in ${dir}.` });
  await assert.rejects(Promise.resolve(sharedCapture(dir).open(new AbortController().signal)),
    { message: `No shared microphone device answers in ${dir}.` });
});

test('the share directory must be a real directory owned by the user with mode 0700', async (t) => {
  const dir = shareDir(t);
  const open = path.join(dir, 'open');
  fs.mkdirSync(open, { mode: 0o700 });
  fs.chmodSync(open, 0o755);
  await fakeSocket(t, open, 'laptop-1111', 'speaker');
  const refusal = /Refusing share directory .*: it must be a directory owned by you with mode 0700\.$/;
  await assert.rejects(sharedOutput(open).play(Buffer.alloc(0)), refusal);
  await assert.rejects(connectDevice(open, 'speaker'), refusal);
  const link = path.join(dir, 'link');
  fs.symlinkSync(dir, link);
  assert.throws(() => checkShareDirectory(link), refusal);
  // A trailing slash or `/.` would make lstat follow the link: the path is normalized first.
  for (const suffix of ['//', '/.', '/./', '/././/']) {
    assert.throws(() => checkShareDirectory(`${link}${suffix}`), refusal, suffix);
    assert.throws(() => ensureShareDirectory({ PHIMACS_SHARE_DIR: `${link}${suffix}` }), refusal, suffix);
    await assert.rejects(sharedOutput(`${link}${suffix}`).play(Buffer.alloc(0)), refusal, suffix);
    await assert.rejects(connectDevice(`${link}${suffix}`, 'mic'), refusal, suffix);
  }
  const readOnly = path.join(dir, 'read-only');
  fs.mkdirSync(readOnly, { mode: 0o700 });
  fs.chmodSync(readOnly, 0o500);
  assert.throws(() => checkShareDirectory(readOnly), refusal);
  // Other bits outside the permission bits, such as setgid, are allowed.
  fs.chmodSync(open, 0o2700);
  assert.equal(fs.statSync(open).mode & 0o7777, 0o2700);
  assert.equal(checkShareDirectory(open), true);
  assert.equal(checkShareDirectory(`${dir}/`), true);
  assert.equal(checkShareDirectory(path.join(dir, 'absent')), false);
});

test('a refused stale socket replaced after the probe is not pruned', async (t) => {
  const dir = shareDir(t);
  const file = path.join(dir, 'laptop-5a5b.notify.sock');
  refusedSocket(file);
  age(file, 120_000);
  let replaced = false;
  const connected = await connectDevice(dir, 'notify', { now: () => {
    // A device reconnecting with the same name between the refusal and the prune.
    fs.rmSync(file);
    refusedSocket(file);
    replaced = true;
    return Date.now();
  } });
  assert.equal(connected, null);
  assert.ok(replaced);
  assert.ok(fs.lstatSync(file).isSocket());
});

test('the share directory resolves from PHIMACS_SHARE_DIR or the per-user default', (t) => {
  const dir = shareDir(t);
  const fallback = `/tmp/phimacs-share-${process.getuid!()}`;
  assert.equal(shareDirectory({}), fallback);
  assert.equal(shareDirectory({ PHIMACS_SHARE_DIR: '' }), fallback);
  assert.equal(shareDirectory({ PHIMACS_SHARE_DIR: `${dir}/x//` }), `${dir}/x`);
  assert.equal(shareDirectory({ PHIMACS_SHARE_DIR: `${dir}/x/./` }), `${dir}/x`);
  assert.equal(shareDirectory({ PHIMACS_SHARE_DIR: `${dir}/x/.` }), `${dir}/x`);
  assert.equal(shareDirectory({ PHIMACS_SHARE_DIR: `${dir}/./x/../y` }), `${dir}/y`);
  assert.throws(() => shareDirectory({ PHIMACS_SHARE_DIR: 'relative/share' }), /must be an absolute path/);
  // Missing parents are created with the directory.
  const created = path.join(dir, 'runtime', 'nested', 'share');
  assert.equal(ensureShareDirectory({ PHIMACS_SHARE_DIR: `${created}/` }), created);
  assert.equal(fs.lstatSync(created).mode & 0o777, 0o700);
  assert.equal(ensureShareDirectory({ PHIMACS_SHARE_DIR: created }), created);
  // Like `mkdir -m 700`, exactly 0700 even when the umask removes owner permissions.
  const masked = path.join(dir, 'runtime', 'masked');
  const umask = process.umask(0o277);
  try { assert.equal(ensureShareDirectory({ PHIMACS_SHARE_DIR: masked }), masked); }
  finally { process.umask(umask); }
  assert.equal(fs.lstatSync(masked).mode & 0o777, 0o700);
  fs.chmodSync(created, 0o750);
  assert.throws(() => ensureShareDirectory({ PHIMACS_SHARE_DIR: created }), /Refusing share directory/);
});

test('Pi dictation records from the shared microphone that its settings select', async (t) => {
  const dir = shareDir(t);
  const previous = process.env.PHIMACS_SHARE_DIR;
  process.env.PHIMACS_SHARE_DIR = dir;
  t.after(() => { if (previous === undefined) delete process.env.PHIMACS_SHARE_DIR; else process.env.PHIMACS_SHARE_DIR = previous; });
  const written: Buffer[] = [];
  const runtime = createSoundRuntime({
    backends: new BackendRegistry().register('fake', { validate: (value) => value,
      open: () => ({ write(pcm) { written.push(Buffer.from(pcm)); }, finish: async () => 'from the laptop', close() {} }) }),
    readSetting: () => ({ backend: 'fake', options: {}, mode: 'type', share: true }),
  });
  let shortcut!: (ctx: ExtensionContext) => void;
  const statuses: (string | undefined)[] = []; const notices: string[] = []; const pasted: string[] = [];
  const pi = { registerCommand() {}, on() {}, sendUserMessage() {},
    registerShortcut: (_key: string, spec: { handler: typeof shortcut }) => { shortcut = spec.handler; } } as unknown as ExtensionAPI;
  const ctx = { mode: 'tui', isIdle: () => true, ui: { notify: (text: string) => notices.push(text),
    setStatus: (_key: string, text: string | undefined) => statuses.push(text), pasteToEditor: (text: string) => pasted.push(text),
    theme: { fg: (_color: string, text: string) => text } } } as unknown as ExtensionContext;
  registerDictation(pi, { runtime, agentDir: () => dir });
  const until = async (predicate: () => boolean) => {
    for (const deadline = Date.now() + 2_000; !predicate();) {
      if (Date.now() > deadline) throw new Error(`Dictation did not settle: ${notices.join('; ')}`);
      await delay(1);
    }
  };

  shortcut(ctx);
  await until(() => notices.length > 0);
  assert.deepEqual(notices, [`Dictation failed: No shared microphone device answers in ${dir}.`]);
  const mic = await fakeSocket(t, dir, 'laptop-6a7b', 'mic', { send: [Buffer.from([1, 0, 2, 0])] });
  shortcut(ctx);
  await until(() => written.length > 0);
  assert.ok(statuses.includes('● rec laptop'));
  shortcut(ctx);
  await until(() => pasted.length > 0);
  assert.deepEqual(pasted, ['(dictated) from the laptop']);
  await mic.hostClosed;
});

test('settings select shared devices explicitly, exclusive of a capture command', () => {
  assert.equal(parseVoiceSetting({ backend: 'local', options: {}, share: true }).share, true);
  assert.throws(() => parseVoiceSetting({ share: 'yes' }), /share must be a boolean/);
  assert.throws(() => parseVoiceSetting({ share: true, capture: { command: 'parecord', args: [] } }), /exclusive/);
  const runtime = createSoundRuntime();
  const shared = { backend: null, options: {}, mode: 'type' as const, share: true };
  assert.ok(captureFor(shared, runtime));
  assert.ok(outputFor(shared, runtime));
  assert.equal(captureFor({ ...shared, share: false }, runtime), undefined);
  assert.equal(outputFor({ ...shared, share: false }, runtime), undefined);
  // An explicitly composed runtime keeps its own devices.
  const capture: CaptureSource = { open() { throw new Error('unused'); } };
  const output: OutputSink = { play: async () => 'composed', notify: async () => 'composed' };
  const composed = createSoundRuntime({ capture, output });
  assert.equal(captureFor(shared, composed), capture);
  assert.equal(outputFor(shared, composed), output);
});
