import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createPublicSpeech, parseCommandSpeechOptions, parseWav, wav } from '../src/index.ts';

const never = new AbortController().signal;
// Records its argv and standard input, then writes one 16 kHz sample per input character as WAV.
const FAKE = `
const fs = require('node:fs');
const [log, ...rest] = process.argv.slice(1);
const stdin = fs.readFileSync(0, 'utf8');
fs.writeFileSync(log, JSON.stringify({ args: rest, stdin }));
const pcm = Buffer.alloc((rest.join('') + stdin).length * 2, 1);
const header = Buffer.alloc(44);
header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
header.write('data', 36); header.writeUInt32LE(0x7ffff000, 40);
process.stdout.write(Buffer.concat([header, pcm]));
`;
function fixture(t: { after(fn: () => void): void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sound-command-speech-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'log.json');
  return { log, read: () => JSON.parse(fs.readFileSync(log, 'utf8')) as { args: string[]; stdin: string } };
}
const script = (source: string) => ({ command: process.execPath, args: ['-e', source] });

test('command speech substitutes {text} and {voice} once per argument and returns its WAV', async (t) => {
  const { log, read } = fixture(t);
  const model = createPublicSpeech().prepare('command', {
    command: process.execPath, args: ['-e', FAKE, log, '--voice={voice}', '{text}'], voice: 'kal' });
  const result = await model.generate({ text: 'Hi {voice}', format: 'wav', signal: never });
  assert.deepEqual(read(), { args: ['--voice=kal', 'Hi {voice}'], stdin: '' });
  assert.equal(result.mediaType, 'audio/wav');
  assert.equal(result.voice, 'kal');
  // The streamed data size espeak-ng writes extends to the end of its output.
  assert.equal(parseWav(result.audio).samples.length, '--voice=kalHi {voice}'.length * 2);
  assert.equal((await model.generate({ text: 'x', voice: 'rms', format: 'wav', signal: never })).voice, 'rms');
  assert.deepEqual(read().args, ['--voice=rms', 'x']);
});

test('command speech without {text} writes text to standard input and encodes Ogg Opus with ffmpeg', async (t) => {
  const { log, read } = fixture(t);
  const model = createPublicSpeech().prepare('command', { command: process.execPath, args: ['-e', FAKE, log] });
  const result = await model.generate({ text: 'Spoken from standard input.', format: 'opus', signal: never });
  assert.deepEqual(read(), { args: [], stdin: 'Spoken from standard input.' });
  assert.equal(result.mediaType, 'audio/ogg');
  assert.equal(result.voice, undefined);
  assert.equal(result.audio.subarray(0, 4).toString(), 'OggS');
  assert.ok(result.audio.includes(Buffer.from('OpusHead')));
});

test('command speech reads WAV from a private {output} file and removes it', async (t) => {
  const { log } = fixture(t);
  // Writes WAV to the {output} path and records that path, as flite -o does.
  const writer = `const fs = require('node:fs'); const [log, out] = process.argv.slice(1); fs.writeFileSync(log, out);
    fs.writeFileSync(out, Buffer.from('${wav(Buffer.alloc(8, 2)).toString('base64')}', 'base64'));`;
  const model = createPublicSpeech().prepare('command', { command: process.execPath, args: ['-e', writer, log, '{output}', '{text}'] });
  const result = await model.generate({ text: 'x', format: 'wav', signal: never });
  assert.equal(parseWav(result.audio).samples.length, 8);
  const output = fs.readFileSync(log, 'utf8');
  assert.match(path.basename(path.dirname(output)), /^pi-speech-command-/);
  assert.equal(fs.existsSync(path.dirname(output)), false);
  const silent = createPublicSpeech().prepare('command', { command: process.execPath, args: ['-e', '', '{output}'] });
  await assert.rejects(silent.generate({ text: 'x', format: 'wav', signal: never }), /no \{output\} file/);
});

test('command speech options and requests are validated before running anything', () => {
  const valid = { command: 'flite', args: ['-voice', '{voice}', '-t', '{text}', '-o', '/dev/stdout'], voice: 'kal' };
  assert.deepEqual(parseCommandSpeechOptions(valid), valid);
  assert.throws(() => parseCommandSpeechOptions({ ...valid, shell: true }), /accepts only/);
  assert.throws(() => parseCommandSpeechOptions({ ...valid, command: '' }), /nonempty command/);
  assert.throws(() => parseCommandSpeechOptions({ command: 'flite', args: '-t {text}' }), /string args/);
  assert.throws(() => parseCommandSpeechOptions({ command: 'flite', args: ['{voice}'] }), /require each other/);
  assert.throws(() => parseCommandSpeechOptions({ command: 'flite', args: [], voice: 'kal' }), /require each other/);
  assert.throws(() => parseCommandSpeechOptions({ ...valid, timeoutMs: 0 }), /timeoutMs/);
});

test('command speech rejects unsupported requests before running and reports a missing command', async () => {
  const model = createPublicSpeech().prepare('command', { command: '/nonexistent/speech-command', args: [] });
  await assert.rejects(model.generate({ text: 'x', instructions: 'calm', format: 'wav', signal: never }), /no delivery instructions/);
  await assert.rejects(model.generate({ text: 'x', voice: 'kal', format: 'wav', signal: never }), /no \{voice\} argument/);
  await assert.rejects(model.generate({ text: 'x', format: 'mp3', signal: never }), /only WAV and Ogg Opus/);
  await assert.rejects(model.generate({ text: 'x'.repeat(4097), format: 'wav', signal: never }), /at most 4096/);
  await assert.rejects(model.generate({ text: 'x', format: 'wav', signal: never }), /"\/nonexistent\/speech-command" is not installed/);
});

test('command speech fails on exit status, non-WAV output, timeout and cancellation', async () => {
  const speech = createPublicSpeech();
  const generate = (options: object, signal = never) => speech.prepare('command', options).generate({ text: 'x', format: 'wav', signal });
  const silent = wav(Buffer.alloc(0)).toString('base64');
  await assert.rejects(generate(script('process.exit(3)')), /Speech command failed \(exit 3\)/);
  await assert.rejects(generate(script('process.stdout.write("not audio")')), /did not write 16-bit PCM WAV/);
  await assert.rejects(generate(script(`process.stdout.write(Buffer.from('${silent}', 'base64'))`)), /wrote no audio/);
  const hang = script('setInterval(() => {}, 1000)');
  await assert.rejects(generate({ ...hang, timeoutMs: 50 }), /Speech command timed out/);
  const controller = new AbortController();
  const pending = generate(hang, controller.signal);
  controller.abort(new Error('synthetic cancel'));
  await assert.rejects(pending, /synthetic cancel/);
});
