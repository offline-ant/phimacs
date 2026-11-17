import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { commandCapture, startDictation, type DictationMessage } from '../src/index.ts';

for (const exitCode of [0, 3]) {
  test(`explicit capture argv propagates exit status ${exitCode} after PCM`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sound-capture-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'capture.cjs');
    fs.writeFileSync(file, `process.stdout.write(Buffer.from([1,2,3,4]), () => { process.exitCode=${exitCode}; });`);
    const chunks: Buffer[] = [];
    const messages: DictationMessage[] = [];
    const dictation = startDictation({
      capture: commandCapture({ command: process.execPath, args: [file] }),
      open: async () => ({ backend: 'fake', transcriber: {
        write(pcm) { chunks.push(pcm); }, finish: async () => 'capture transcript', close() {},
      } }),
      emit: (message) => messages.push(message),
    });
    await dictation.done;
    assert.deepEqual(Buffer.concat(chunks), Buffer.from([1, 2, 3, 4]));
    assert.deepEqual(messages.map((message) => message.type), ['ready', exitCode === 0 ? 'final' : 'error']);
    if (exitCode !== 0) assert.match((messages.at(-1) as { message: string }).message, /capture command failed/);
  });
}

test('missing capture executable reports an error and closes the backend', async () => {
  let closed = false;
  const messages: DictationMessage[] = [];
  await startDictation({
    capture: commandCapture({ command: '/nonexistent/sound-capture', args: [] }),
    open: async () => ({ backend: 'fake', transcriber: { write() {}, finish: async () => '', close() { closed = true; } } }),
    emit: (message) => messages.push(message),
  }).done;
  assert.equal(closed, true);
  assert.deepEqual(messages.map((message) => message.type), ['error']);
});
