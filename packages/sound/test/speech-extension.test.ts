import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import type { ExtensionAPI, ExtensionCommandContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { registerSpeech } from '../src/extension.ts';
import { SpeechRegistry, createSoundRuntime, readVoiceSetting, wav, writeVoiceSetting, type OutputSink, type SpeechRequest } from '../src/index.ts';

type Handler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Synthetic extension action did not settle.');
    await setTimeout(1);
  }
}
function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sound-speech-extension-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const commands = new Map<string, Handler>();
  const events = new Map<string, () => void>();
  const tools: ToolDefinition[] = [];
  const notices: string[] = [];
  const statuses: (string | undefined)[] = [];
  const messages: unknown[] = [];
  const played: Buffer[] = [];
  const requests: SpeechRequest[] = [];
  const keys: string[] = [];
  let block = false;
  const speech = new SpeechRegistry().register('fake', {
    validate: (value) => value,
    create: (_options, context) => ({
      backend: 'fake', maxInputLength: 40,
      async generate(request) {
        requests.push(request);
        keys.push(await context.credentials!('openai', request.signal));
        if (block) await new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason)));
        const audio = request.format === 'wav' ? wav(Buffer.alloc(4)) : Buffer.from('OggS fake');
        return { audio, mediaType: request.format === 'wav' ? 'audio/wav' : 'audio/ogg', format: request.format, voice: request.voice ?? 'configured' };
      },
    }),
  });
  // Empty buffers are device probes, not speech.
  const output: OutputSink = { async play(pcm) { if (pcm.length) played.push(pcm); return 'synthetic-speaker'; }, async notify() { return null; } };
  writeVoiceSetting(dir, { backend: null, options: {}, mode: 'type', speech: { backend: 'fake', options: { secret: 'synthetic-hidden' } } });
  const branch = [
    { type: 'message', message: { role: 'user', content: 'question' } },
    { type: 'message', message: { role: 'assistant', content: [
      { type: 'thinking', thinking: 'hidden reasoning' },
      { type: 'text', text: 'The **answer** is here.\n\n```js\nignored()\n```' },
      { type: 'toolCall', id: 'x', name: 'bash', arguments: {} },
    ] } },
    { type: 'custom', customType: 'other' },
  ];
  const pi = {
    registerCommand: (name: string, spec: { handler: Handler }) => commands.set(name, spec.handler),
    registerTool: (tool: ToolDefinition) => tools.push(tool),
    on: (name: string, callback: () => void) => events.set(name, callback),
    sendMessage: (message: unknown) => messages.push(message),
  } as unknown as ExtensionAPI;
  const ctx = {
    mode: 'tui', hasUI: true,
    ui: { notify: (text: string) => notices.push(text), setStatus: (_key: string, text: string | undefined) => statuses.push(text),
      select: async () => 'status' },
    modelRegistry: { getProviderAuth: async (provider: string) => provider === 'openai' ? { auth: { apiKey: 'sk-session' } } : undefined },
    sessionManager: { getBranch: () => branch },
  } as unknown as ExtensionCommandContext;
  registerSpeech(pi, { runtime: createSoundRuntime({ speech, output }), agentDir: () => dir });
  return { dir, tools, notices, statuses, messages, played, requests, keys, ctx,
    run: (name: string, args = '') => commands.get(name)!(args, ctx), emit: (name: string) => events.get(name)!(),
    blocking: () => { block = true; } };
}

test('/speak plays the last answer as speakable text with session credentials, then clears its status', async (t) => {
  const f = fixture(t);
  await f.run('speak');
  await until(() => f.statuses.at(-1) === undefined && f.played.length === 1);
  assert.deepEqual(f.requests.map((request) => [request.text, request.format]), [['The answer is here.', 'wav']]);
  assert.deepEqual(f.keys, ['sk-session']);
  assert.ok(f.statuses.includes('speech: 1/1 on synthetic-speaker'));
  await f.run('speak', 'Given text.');
  await until(() => f.played.length === 2);
  assert.equal(f.requests.at(-1)?.text, 'Given text.');
  assert.deepEqual(f.notices, []);
});

test('/speak while speaking stops; a new prompt and shutdown cancel silently', async (t) => {
  const f = fixture(t);
  f.blocking();
  for (const stop of [() => f.run('speak'), () => f.emit('input'), () => f.emit('session_shutdown')]) {
    const before = f.requests.length;
    await f.run('speak', 'Long answer.');
    await until(() => f.requests.length === before + 1);
    await stop();
    await until(() => f.requests.at(-1)!.signal.aborted && f.statuses.at(-1) === undefined);
  }
  await setTimeout(5);
  assert.deepEqual(f.played, []);
  assert.deepEqual(f.notices, []);
});

test('speak tool is inactive by default and returns the saved Ogg path for other extensions', async (t) => {
  const f = fixture(t);
  const tool = f.tools.find((candidate) => candidate.name === 'speak');
  assert.ok(tool);
  assert.equal(tool.defaultActive, false);
  const result = await tool.execute('call-1', { text: 'Tool speech.', voice: 'cedar' }, undefined, undefined, f.ctx as never);
  const saved = result.details as { path: string; mediaType: string; voice: string };
  t.after(() => fs.rmSync(saved.path, { force: true }));
  assert.equal(fs.readFileSync(saved.path, 'utf8'), 'OggS fake');
  assert.deepEqual(result.structuredContent, saved);
  assert.equal(saved.mediaType, 'audio/ogg');
  assert.equal(saved.voice, 'cedar');
  assert.match(JSON.stringify(result.content), /Saved speech to .*\.ogg/);
  await assert.rejects(tool.execute('call-2', { text: 'x'.repeat(41) }, undefined, undefined, f.ctx as never), /at most 40/);
});

test('/speak-setting validates, preserves dictation settings and never shows options', async (t) => {
  const f = fixture(t);
  await f.run('speak-setting', 'status');
  assert.equal(f.notices.at(-1), 'Speech backend: fake.');
  assert.equal(f.notices.join('').includes('synthetic-hidden'), false);
  await f.run('speak-setting', 'fake {"voice":"x"}');
  assert.deepEqual(readVoiceSetting(f.dir).speech, { backend: 'fake', options: { voice: 'x' } });
  await assert.rejects(f.run('speak-setting', 'fake []'), /must be an object/);
  await assert.rejects(f.run('speak-setting', 'unknown'), /Invalid speech setting/);
  await f.run('speak-setting', 'disabled');
  assert.deepEqual(readVoiceSetting(f.dir), { backend: null, options: {}, mode: 'type' });
  await f.run('speak');
  assert.match(f.notices.at(-1)!, /Speech is disabled/);
});
