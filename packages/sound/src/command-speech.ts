/** Explicit local speech command backend: any program that writes 16-bit PCM WAV, such as flite or espeak-ng. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { optionalTimeoutMs } from './local.ts';
import { parseWav } from './output.ts';
import { objectValue } from './settings.ts';
import { SPEECH_MEDIA_TYPES, type SpeechBackendDefinition, type SpeechModel } from './speech.ts';

/** Same limit as openai-speech; it also keeps `{text}` well below the kernel's argument size limit. */
export const COMMAND_SPEECH_MAX_INPUT = 4096;
export interface CommandSpeechOptions {
  command: string;
  /**
   * `{text}`, `{voice}` and `{output}` are replaced within each argument. Without `{text}`, text goes to
   * standard input; without `{output}` (a private temporary WAV path), WAV is read from standard output.
   */
  args: string[];
  voice?: string;
  timeoutMs?: number;
}
const KEYS = ['command', 'args', 'voice', 'timeoutMs'];
const PLACEHOLDER = /\{(text|voice|output)\}/g;
// Commands write WAV; saved speech is Ogg Opus, encoded from the WAV's samples.
const OPUS_ENCODER = 'ffmpeg';

export function parseCommandSpeechOptions(value: unknown): CommandSpeechOptions {
  if (!objectValue(value) || Object.keys(value).some((key) => !KEYS.includes(key))) {
    throw new Error(`command speech accepts only ${KEYS.join(', ')}.`);
  }
  if (typeof value.command !== 'string' || !value.command) throw new Error('command speech requires a nonempty command.');
  if (!Array.isArray(value.args) || value.args.some((arg: unknown) => typeof arg !== 'string')) {
    throw new Error('command speech requires a string args array.');
  }
  const args = value.args as string[];
  if (value.voice !== undefined && (typeof value.voice !== 'string' || !value.voice)) throw new Error('voice must be nonempty.');
  const usesVoice = args.some((arg) => arg.includes('{voice}'));
  if (usesVoice !== (value.voice !== undefined)) throw new Error('voice and a {voice} argument require each other.');
  const timeoutMs = optionalTimeoutMs(value.timeoutMs);
  return { command: value.command, args,
    ...(value.voice === undefined ? {} : { voice: value.voice as string }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }) };
}

export function commandSpeechModel(options: CommandSpeechOptions): SpeechModel {
  return {
    backend: 'command',
    maxInputLength: COMMAND_SPEECH_MAX_INPUT,
    async generate(request) {
      request.signal.throwIfAborted();
      if (!request.text.trim()) throw new Error('Speech text is empty.');
      if (request.text.length > COMMAND_SPEECH_MAX_INPUT) {
        throw new Error(`Speech text has ${request.text.length} characters; command speech accepts at most ${COMMAND_SPEECH_MAX_INPUT}.`);
      }
      if (request.instructions !== undefined || request.speed !== undefined) {
        throw new Error('command speech accepts no delivery instructions or speed.');
      }
      if (request.voice !== undefined && options.voice === undefined) throw new Error('This speech command has no {voice} argument.');
      if (request.format !== 'wav' && request.format !== 'opus') throw new Error('command speech produces only WAV and Ogg Opus.');
      const voice = request.voice ?? options.voice;
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(options.timeoutMs ?? 120_000)]);
      const audio = await synthesize(options, request.text, voice ?? '', signal);
      let pcm: ReturnType<typeof parseWav>;
      try { pcm = parseWav(audio); }
      catch (error) { throw new Error(`Speech command did not write 16-bit PCM WAV: ${(error as Error).message}`); }
      if (!pcm.samples.length) throw new Error('Speech command wrote no audio.');
      const encoded = request.format === 'wav' ? audio : await run(OPUS_ENCODER, ['-hide_banner', '-loglevel', 'error',
        '-f', 's16le', '-ar', String(pcm.sampleRate), '-ac', String(pcm.channels), '-i', 'pipe:0',
        '-c:a', 'libopus', '-f', 'ogg', 'pipe:1'], pcm.samples, signal, 'Ogg Opus encoder ffmpeg');
      return { audio: encoded, mediaType: SPEECH_MEDIA_TYPES[request.format], format: request.format,
        ...(voice === undefined ? {} : { voice }) };
    },
  };
}

/** Run the configured command once and return the WAV it wrote. */
async function synthesize(options: CommandSpeechOptions, text: string, voice: string, signal: AbortSignal): Promise<Buffer> {
  const uses = (name: string) => options.args.some((arg) => arg.includes(`{${name}}`));
  // Some engines (flite, pico2wave) write only to named files, and Node's stdout is a socket, not /dev/stdout.
  const dir = uses('output') ? fs.mkdtempSync(path.join(os.tmpdir(), 'pi-speech-command-')) : undefined;
  try {
    const values = { text, voice, output: dir === undefined ? '' : path.join(dir, 'speech.wav') };
    // One pass, so text containing "{voice}" is never substituted again.
    const args = options.args.map((arg) => arg.replace(PLACEHOLDER, (_match, name: keyof typeof values) => values[name]));
    const stdout = await run(options.command, args, uses('text') ? undefined : Buffer.from(text), signal, 'Speech command');
    if (dir === undefined) return stdout;
    try { return fs.readFileSync(values.output); }
    catch { throw new Error('Speech command wrote no {output} file.'); }
  } finally {
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Run exactly this argv without a shell and collect standard output; abort kills the process. */
async function run(command: string, args: string[], input: Buffer | undefined, signal: AbortSignal, label: string): Promise<Buffer> {
  const throwIfAborted = () => {
    if (signal.aborted && (signal.reason as Error | undefined)?.name === 'TimeoutError') throw new Error(`${label} timed out.`);
    signal.throwIfAborted();
  };
  throwIfAborted();
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'] });
  const chunks: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  // A command that ignores its input may exit before reading it; its exit status decides.
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  const kill = () => child.kill('SIGKILL');
  signal.addEventListener('abort', kill, { once: true });
  try {
    const status = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, exitSignal) => resolve({ code, signal: exitSignal }));
    });
    throwIfAborted();
    if (status.code !== 0) throw new Error(`${label} failed (${status.signal ?? `exit ${status.code}`}).`);
  } catch (error) {
    throwIfAborted();
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${label} "${command}" is not installed.`);
    throw error;
  } finally {
    signal.removeEventListener('abort', kill);
  }
  return Buffer.concat(chunks);
}

export const commandSpeechBackend: SpeechBackendDefinition<CommandSpeechOptions> = {
  validate: parseCommandSpeechOptions,
  create: (options) => commandSpeechModel(options),
};
