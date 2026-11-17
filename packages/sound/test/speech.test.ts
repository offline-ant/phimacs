import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import {
  OPENAI_SPEECH_MAX_INPUT, SPEAKER_SAMPLE_RATE, SpeechRegistry, createPublicSpeech, openAISpeechModel, parseOpenAISpeechOptions,
  parseVoiceSetting, parseWav, playSpeech, readVoiceSetting, saveSpeech, setMode, setSpeechBackend, speakableText,
  speakerSamples, speechFor, splitSpeechText, createSoundRuntime, wav, writeVoiceSetting,
  type OutputSink, type SpeechModel, type SpeechRequest,
} from '../src/index.ts';

const never = new AbortController().signal;
function temporary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sound-speech-'));
  return { dir, close: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
interface Received { url?: string; authorization?: string; custom?: string; body: Record<string, unknown> }
async function speechServer(reply: (body: Record<string, unknown>, res: http.ServerResponse) => void = (body, res) => {
  res.end(body.response_format === 'wav' ? wav(Buffer.alloc(32)) : Buffer.from('OggS synthetic opus'));
}) {
  const received: Received[] = [];
  const host = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const data of req) chunks.push(Buffer.from(data));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    received.push({ url: req.url, authorization: req.headers.authorization, custom: req.headers['x-custom'] as string | undefined, body });
    reply(body, res);
  });
  host.listen(0, '127.0.0.1');
  await once(host, 'listening');
  const address = host.address();
  assert.ok(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}`, received, async close() {
    host.closeAllConnections();
    await new Promise<void>((resolve) => host.close(() => resolve()));
  } };
}
/** Speech model answering WAV at 16 kHz with one sample per character, and fake Ogg data. */
function fakeModel(maxInputLength = 50, fail?: (request: SpeechRequest) => boolean) {
  const requests: SpeechRequest[] = [];
  const model: SpeechModel = {
    backend: 'fake', maxInputLength,
    async generate(request) {
      requests.push(request);
      request.signal.throwIfAborted();
      if (fail?.(request)) throw new Error('synthetic synthesis failure');
      const audio = request.format === 'wav' ? wav(Buffer.alloc(request.text.length * 2, 1)) : Buffer.from(`OggS ${request.text}`);
      return { audio, mediaType: request.format === 'wav' ? 'audio/wav' : 'audio/ogg', format: request.format, voice: request.voice ?? 'default' };
    },
  };
  return { model, requests };
}
function fakeSink(device: string | null = 'synthetic-speaker') {
  const played: Buffer[] = [];
  const sink: OutputSink = { async play(pcm) { played.push(pcm); return device; }, async notify() { return device; } };
  return { sink, played };
}

test('openai-speech posts JSON to /v1/audio/speech with request-time Pi credentials and overrides', async (t) => {
  const server = await speechServer();
  t.after(() => server.close());
  const providers: string[] = [];
  const model = createPublicSpeech().prepare('openai-speech', {
    url: server.url, model: 'gpt-4o-mini-tts', voice: 'marin', instructions: 'calm', speed: 1.25,
    headers: { 'x-custom': 'kept' }, authProvider: 'openai',
  }, { credentials: async (provider) => { providers.push(provider); return 'sk-synthetic'; } });
  assert.deepEqual(providers, []);
  const opus = await model.generate({ text: 'Hello there.', format: 'opus', signal: never });
  assert.equal(opus.mediaType, 'audio/ogg');
  assert.equal(opus.voice, 'marin');
  assert.equal(opus.audio.toString(), 'OggS synthetic opus');
  const overridden = await model.generate({ text: 'Again.', voice: 'cedar', instructions: 'brisk', format: 'wav', signal: never });
  assert.equal(parseWav(overridden.audio).sampleRate, 16_000);
  assert.deepEqual(providers, ['openai', 'openai']);
  assert.deepEqual(server.received.map((request) => [request.url, request.authorization, request.custom]),
    [['/v1/audio/speech', 'Bearer sk-synthetic', 'kept'], ['/v1/audio/speech', 'Bearer sk-synthetic', 'kept']]);
  assert.deepEqual(server.received[0].body, { model: 'gpt-4o-mini-tts', input: 'Hello there.', voice: 'marin',
    response_format: 'opus', instructions: 'calm', speed: 1.25 });
  assert.deepEqual(server.received[1].body, { model: 'gpt-4o-mini-tts', input: 'Again.', voice: 'cedar',
    response_format: 'wav', instructions: 'brisk', speed: 1.25 });
});

test('openai-speech validation, limits and errors never echo response bodies or need credentials for local servers', async (t) => {
  const base = { url: 'http://localhost:1', model: 'm', voice: 'v' };
  for (const value of [{}, { ...base, url: 'file:///x' }, { ...base, url: 'http://u:p@localhost' }, { ...base, model: '' },
    { ...base, voice: 1 }, { ...base, speed: 9 }, { ...base, timeoutMs: 0 }, { ...base, headers: { a: 1 } }, { ...base, extra: true },
    { ...base, authProvider: '' }, { ...base, authProvider: 'openai', headers: { Authorization: 'x' } }]) {
    assert.throws(() => parseOpenAISpeechOptions(value));
  }
  assert.throws(() => openAISpeechModel({ ...base, authProvider: 'openai' }), /no credential resolver/);
  assert.throws(() => new SpeechRegistry().prepare(null, {}), /disabled/);
  assert.throws(() => new SpeechRegistry().prepare('missing', {}), /not registered/);
  const server = await speechServer((_body, res) => { res.statusCode = 401; res.end('synthetic-secret-echo'); });
  t.after(() => server.close());
  const model = openAISpeechModel({ ...base, url: server.url });
  await assert.rejects(model.generate({ text: 'x', format: 'opus', signal: never }), (error: unknown) =>
    error instanceof Error && error.message.includes('HTTP 401') && !error.message.includes('synthetic-secret-echo'));
  assert.equal(server.received[0].authorization, undefined);
  await assert.rejects(model.generate({ text: 'x'.repeat(OPENAI_SPEECH_MAX_INPUT + 1), format: 'opus', signal: never }), /at most 4096/);
  await assert.rejects(model.generate({ text: ' ', format: 'opus', signal: never }), /empty/);
  assert.equal(server.received.length, 1);
});

test('speech settings are strict, private and preserve dictation settings', (t) => {
  const temp = temporary(); t.after(temp.close);
  writeVoiceSetting(temp.dir, { backend: 'local', options: { url: 'http://127.0.0.1:1' }, mode: 'send' });
  setSpeechBackend(temp.dir, 'openai-speech', { url: 'http://127.0.0.1:2', model: 'm', voice: 'v' });
  assert.deepEqual(readVoiceSetting(temp.dir), { backend: 'local', options: { url: 'http://127.0.0.1:1' }, mode: 'send',
    speech: { backend: 'openai-speech', options: { url: 'http://127.0.0.1:2', model: 'm', voice: 'v' } } });
  assert.equal(setMode(temp.dir, 'toggle').speech?.backend, 'openai-speech');
  assert.equal(fs.statSync(path.join(temp.dir, 'voice.json')).mode & 0o777, 0o600);
  assert.equal(setSpeechBackend(temp.dir, null).speech, undefined);
  assert.equal(readVoiceSetting(temp.dir).backend, 'local');
  for (const speech of [null, { backend: 'disabled' }, { backend: 'x', options: [] }, { backend: 'x', extra: 1 }, { options: {} }]) {
    assert.throws(() => parseVoiceSetting({ speech }), /speech must/);
  }
  assert.throws(() => speechFor(readVoiceSetting(temp.dir), createSoundRuntime()), /Speech is disabled/);
});

test('speakable text drops code and markup; chunks keep sentences within the limit', () => {
  const spoken = speakableText([
    '# Result', '', 'The **fix** is in `src/a.ts`, see [the docs](https://example.com).', '', '```ts', 'const x = 1;', '```',
    '- First item', '- Second item', '', '| a | b |', '|---|---|', '| 1 | 2 |', '', 'Visit https://example.com/x now.',
  ].join('\n'));
  assert.equal(spoken.includes('const x'), false);
  assert.equal(spoken, 'Result\n\nThe fix is in src/a.ts, see the docs.\n\nFirst item\nSecond item\n\na, b\n\n1, 2\n\nVisit link now.');
  assert.equal(speakableText('Text\n```\nunterminated code'), 'Text');
  assert.deepEqual(splitSpeechText('One. Two is 3.14 long! Three?', 12), ['One. Two is', '3.14 long!', 'Three?']);
  assert.deepEqual(splitSpeechText('One. Two. Three.', 10), ['One. Two.', 'Three.']);
  assert.deepEqual(splitSpeechText('abcdefghij', 4), ['abcd', 'efgh', 'ij']);
  assert.ok(splitSpeechText('word '.repeat(300), 100).every((chunk) => chunk.length <= 100));
});

test('speaker samples mix stereo, resample to 44.1 kHz and accept streamed WAV sizes', () => {
  const mono = speakerSamples(wav(Buffer.from(new Int16Array([0, 1000, 2000, 3000]).buffer)));
  assert.equal(mono.length / 2, Math.floor(4 * SPEAKER_SAMPLE_RATE / 16_000));
  assert.equal(mono.readInt16LE(0), 0);
  const stereo = wav(Buffer.from(new Int16Array([100, 300, 100, 300]).buffer));
  stereo.writeUInt16LE(2, 22);
  stereo.writeUInt32LE(SPEAKER_SAMPLE_RATE, 24);
  assert.deepEqual([...new Int16Array(new Uint8Array(speakerSamples(stereo)).buffer)], [200, 200]);
  const streamed = wav(Buffer.alloc(6));
  streamed.writeUInt32LE(0xffff_ffff, 40);
  assert.equal(parseWav(streamed).samples.length, 6);
  assert.throws(() => parseWav(Buffer.concat([wav(Buffer.alloc(4)).subarray(0, 44), Buffer.alloc(2)])), /Truncated/);
});

test('saveSpeech writes exclusive private Ogg files and rejects text over the backend limit', async (t) => {
  const temp = temporary(); t.after(temp.close);
  const { model, requests } = fakeModel();
  const out = path.join(temp.dir, 'speech.ogg');
  const saved = await saveSpeech(model, 'Hello.', { out, voice: 'cedar', signal: never });
  assert.deepEqual(saved, { path: out, mediaType: 'audio/ogg', bytes: 11, backend: 'fake', voice: 'cedar' });
  assert.equal(fs.readFileSync(out, 'utf8'), 'OggS Hello.');
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  await assert.rejects(saveSpeech(model, 'Again.', { out, signal: never }), /EEXIST/);
  assert.equal(fs.readFileSync(out, 'utf8'), 'OggS Hello.');
  await assert.rejects(saveSpeech(model, 'x'.repeat(51), { signal: never }), /accepts at most 50/);
  const failed = path.join(temp.dir, 'failed.ogg');
  await assert.rejects(saveSpeech(fakeModel(50, () => true).model, 'Fails.', { out: failed, signal: never }), /synthetic synthesis failure/);
  assert.equal(fs.existsSync(failed), false);
  assert.equal(requests.length, 1);
  const generated = await saveSpeech(model, 'Default path.', { signal: never });
  t.after(() => fs.rmSync(generated.path, { force: true }));
  assert.match(generated.path, /pi-speech-\d+\/[^/]+\.ogg$/);
  assert.equal(fs.statSync(path.dirname(generated.path)).mode & 0o777, 0o700);
});

test('playSpeech sends chunks in order, prefetches, reports progress and fails explicitly', async () => {
  const { model, requests } = fakeModel(11);
  const { sink, played } = fakeSink();
  const progress: string[] = [];
  const result = await playSpeech(model, 'One two. Three four. Five.', sink, { signal: never,
    onProgress: ({ chunk, chunks, device }) => progress.push(`${chunk}/${chunks}@${device}`) });
  assert.deepEqual(result, { device: 'synthetic-speaker', chunks: 3 });
  assert.deepEqual(requests.map((request) => [request.text, request.format]), [['One two.', 'wav'], ['Three four.', 'wav'], ['Five.', 'wav']]);
  assert.deepEqual(progress, ['1/3@synthetic-speaker', '2/3@synthetic-speaker', '3/3@synthetic-speaker']);
  assert.deepEqual(played.map((pcm) => pcm.length / 2), [0, 8, 11, 5].map((length) => Math.floor(length * SPEAKER_SAMPLE_RATE / 16_000)));
  await assert.rejects(playSpeech(model, 'Hi.', undefined, { signal: never }), /No speaker output/);
  await assert.rejects(playSpeech(model, 'Hi.', fakeSink(null).sink, { signal: never }), /No speaker device/);
  assert.equal(requests.length, 3);
  await assert.rejects(playSpeech(model, '   ', sink, { signal: never }), /Nothing to speak/);
  const failing = fakeModel(5, (request) => request.text === 'Two.');
  const partial = fakeSink();
  await assert.rejects(playSpeech(failing.model, 'One. Two. Three.', partial.sink, { signal: never }), /synthetic synthesis failure/);
  assert.equal(partial.played.length, 2);
  const controller = new AbortController();
  const cancelled = fakeSink();
  await assert.rejects(playSpeech(model, 'One two. Three four.', { ...cancelled.sink,
    async play(pcm) { if (pcm.length) controller.abort(); return cancelled.sink.play(pcm); } }, { signal: controller.signal }), /abort/i);
  assert.equal(cancelled.played.length, 2);
});
