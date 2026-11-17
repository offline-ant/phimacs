import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { registerDictation } from '../src/extension.ts';
import { BackendRegistry, createSoundRuntime, readVoiceSetting, streamCapture, writeVoiceSetting, type VoiceSetting } from '../src/index.ts';

type Handler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Synthetic extension action did not settle.');
    await setTimeout(1);
  }
}
function fixture(t: TestContext, mode: 'tui' | 'rpc' = 'tui', read?: () => VoiceSetting, transcript = 'dictated words') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sound-extension-'));
  const commands = new Map<string, { handler: Handler }>();
  const shortcuts = new Map<string, (ctx: ExtensionContext) => void>();
  const events = new Map<string, () => void>();
  const notices: string[] = [];
  const statuses: (string | undefined)[] = [];
  const pasted: string[] = [];
  const sent: { text: unknown; options: unknown }[] = [];
  const messages: unknown[] = [];
  const stream = new PassThrough();
  let captures = 0;
  let closed = false;
  let written = 0;
  let idle = true;
  let editor = '';
  const registry = new BackendRegistry().register('fake', {
    validate: (value) => value,
    open: (_options, handlers) => ({
      write(pcm) { written += pcm.length; handlers.partial('synthetic preview'); },
      finish: async () => transcript, close() { closed = true; },
    }),
  });
  const runtime = createSoundRuntime({ backends: registry,
    capture: { open(signal) { captures++; return streamCapture(stream, 'synthetic capture').open(signal); } },
    ...(read ? { readSetting: read } : {}),
  });
  if (!read) writeVoiceSetting(dir, { backend: 'fake', options: {}, mode: 'type' });
  const pi = {
    registerCommand: (name: string, spec: { handler: Handler }) => commands.set(name, spec),
    registerShortcut: (key: string, spec: { handler: (ctx: ExtensionContext) => void }) => shortcuts.set(key, spec.handler),
    on: (name: string, callback: () => void) => events.set(name, callback),
    sendUserMessage(text: unknown, options: unknown) { sent.push({ text, options }); },
    sendMessage(message: unknown) { messages.push(message); },
  } as unknown as ExtensionAPI;
  const ctx = {
    mode, hasUI: true, isIdle: () => idle,
    ui: {
      notify: (text: string) => notices.push(text),
      setStatus: (_key: string, text: string | undefined) => statuses.push(text),
      pasteToEditor: (text: string) => { pasted.push(text); editor += text; },
      getEditorText: () => editor,
      setEditorText: (text: string) => { editor = text; },
      select: async () => 'disabled',
      theme: { fg: (_color: string, text: string) => text },
    },
  } as unknown as ExtensionCommandContext;
  registerDictation(pi, { runtime, agentDir: () => dir });
  t.after(() => { events.get('session_shutdown')?.(); stream.destroy(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, notices, statuses, pasted, sent, messages, stream, ctx,
    run: (name: string, args = '') => commands.get(name)!.handler(args, ctx),
    shortcut: () => shortcuts.get('alt+v')!(ctx), shutdown: () => events.get('session_shutdown')!(),
    busy: () => { idle = false; }, setEditor: (text: string) => { editor = text; }, get editor() { return editor; },
    get captures() { return captures; }, get closed() { return closed; }, get written() { return written; } };
}

test('TUI status/partial/stop paste, RPC type refusal, busy send steering', async (t) => {
  const tui = fixture(t);
  tui.shortcut();
  await until(() => tui.captures === 1);
  tui.stream.write(Buffer.from([1, 2]));
  await until(() => tui.statuses.some((status) => status?.includes('synthetic preview')));
  await tui.run('dictate');
  await until(() => tui.pasted.length === 1);
  assert.deepEqual(tui.pasted, ['(dictated) dictated words']);
  assert.equal(tui.statuses.at(-1), undefined);
  assert.ok(tui.statuses.includes('… transcribing'));

  const rpc = fixture(t, 'rpc');
  await rpc.run('dictate');
  assert.match(rpc.notices.at(-1)!, /type mode needs the TUI/);
  assert.equal(rpc.captures, 0);
  await rpc.run('dictate-setting', 'send');
  await rpc.run('dictate');
  await until(() => rpc.captures === 1);
  rpc.stream.write(Buffer.from([1, 2]));
  await until(() => rpc.written === 2);
  rpc.busy();
  await rpc.run('dictate');
  await until(() => rpc.sent.length === 1);
  assert.deepEqual(rpc.sent, [{ text: '(dictated) dictated words', options: { deliverAs: 'steer' } }]);
  assert.deepEqual(rpc.pasted, []);
});

test('TUI type mode: a final "send" pastes the rest and submits the editor', async (t) => {
  const tui = fixture(t, 'tui', undefined, 'dictated words, send.');
  tui.setEditor('draft ');
  tui.shortcut();
  await until(() => tui.captures === 1);
  tui.stream.write(Buffer.from([1, 2]));
  await until(() => tui.written === 2);
  await tui.run('dictate');
  await until(() => tui.sent.length === 1);
  assert.deepEqual(tui.pasted, ['(dictated) dictated words']);
  assert.deepEqual(tui.sent, [{ text: 'draft (dictated) dictated words', options: undefined }]);
  assert.equal(tui.editor, '');
});

test('a final "clear" pastes and sends nothing, in send mode too', async (t) => {
  const f = fixture(t, 'tui', () => ({ backend: 'fake', options: {}, mode: 'send' }), 'dictated words, send. Clear stop.');
  f.setEditor('draft ');
  f.shortcut();
  await until(() => f.captures === 1);
  f.stream.write(Buffer.from([1, 2]));
  await until(() => f.written === 2);
  await f.run('dictate');
  await until(() => f.notices.includes('Dictation cleared.'));
  assert.deepEqual(f.pasted, []);
  assert.deepEqual(f.sent, []);
  assert.equal(f.editor, 'draft ');
});

test('the dictatedFormat setting wraps the text at %s, and "%s" leaves it plain', async (t) => {
  for (const [dictatedFormat, expected] of [['<voice>%s</voice>', '<voice>dictated words</voice>'], ['%s', 'dictated words']]) {
    const f = fixture(t, 'tui', () => ({ backend: 'fake', options: {}, mode: 'send', dictatedFormat }));
    f.shortcut();
    await until(() => f.captures === 1);
    f.stream.write(Buffer.from([1, 2]));
    await until(() => f.written === 2);
    await f.run('dictate');
    await until(() => f.sent.length === 1);
    assert.deepEqual(f.sent, [{ text: expected, options: undefined }]);
    f.shutdown();
  }
});

test('process-wide recording lease works across separate registrations and shutdown cancels', async (t) => {
  const first = fixture(t);
  const second = fixture(t);
  await first.run('dictate');
  await until(() => first.captures === 1);
  await second.run('dictate');
  assert.match(second.notices.at(-1)!, /already recording/);
  assert.equal(second.captures, 0);
  first.shutdown();
  assert.equal(first.closed, true);
  assert.equal(first.statuses.at(-1), undefined);
  await second.run('dictate');
  await until(() => second.captures === 1);
  second.shutdown();
});

test('setting options remain secret in status; composed reader retained for mode/backend writes', async (t) => {
  const f = fixture(t, 'tui', () => ({ backend: 'fake', options: { secret: 'synthetic-hidden' }, mode: 'type' }));
  await f.run('dictate-setting', 'status');
  assert.match(f.notices.at(-1)!, /fake; mode: type/);
  assert.equal(f.notices.join('').includes('synthetic-hidden'), false);
  assert.equal(fs.existsSync(path.join(f.dir, 'voice.json')), false);
  await f.run('dictate-setting', 'send');
  assert.deepEqual(readVoiceSetting(f.dir), { backend: 'fake', options: { secret: 'synthetic-hidden' }, mode: 'send' });
  await f.run('dictate-setting', 'disabled');
  assert.equal(readVoiceSetting(f.dir).backend, null);
  await assert.rejects(f.run('dictate-setting', 'unknown'), /Invalid dictation/);
  (f.ctx as { hasUI: boolean }).hasUI = false;
  await f.run('dictate-setting', 'status');
  assert.match(JSON.stringify(f.messages), /pi-sound:dictate-setting-status/);
});
