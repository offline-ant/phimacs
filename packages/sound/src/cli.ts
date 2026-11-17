/** Composable JSON-lines CLI; importing this module never starts recording. */
import { text as readAll } from 'node:stream/consumers';
import type { Readable, Writable } from 'node:stream';
import { fileCapture, streamCapture } from './capture.ts';
import { startDictation } from './dictation.ts';
import { SOUNDS, notifyDevice, playSound, type SoundName } from './output.ts';
import { piCredentials } from './pi-credentials.ts';
import { captureFor, createSoundRuntime, outputFor, transcriberFor, type SoundRuntime } from './runtime.ts';
import { MODES, clearWord, defaultAgentDir, dictatedFormat, sendWord, setMode, type DictationMode } from './settings.ts';
import { ensureShareDirectory } from './share.ts';
import { playSpeech, saveSpeech, speechFor } from './speak.ts';

export interface CliOptions {
  runtime?: SoundRuntime;
  agentDir?: string;
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
  signal?: AbortSignal;
}
const USAGE = 'Usage: pi-sound dictate [--pcm FILE|-] [--send-word W] [--clear-word W] [--pause-ms N] | speak [--voice V] [--instructions I] [--out FILE | --play] (TEXT|-) | ' +
  'mode [type|send|toggle] | play done|request | notify TITLE [BODY] | share-dir';

interface DictateArguments { pcm?: string; sendWord?: string; clearWord?: string; pauseMs?: number }
/** Dictate options, each at most once; null for anything else. */
function dictateArguments(args: string[]): DictateArguments | null {
  const parsed: DictateArguments = {};
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (value === undefined) return null;
    if (option === '--pcm' && parsed.pcm === undefined) parsed.pcm = value;
    else if (option === '--send-word' && parsed.sendWord === undefined) parsed.sendWord = value;
    else if (option === '--clear-word' && parsed.clearWord === undefined) parsed.clearWord = value;
    else if (option === '--pause-ms' && parsed.pauseMs === undefined && /^\d+$/.test(value)) parsed.pauseMs = Number(value);
    else return null;
  }
  return parsed;
}

interface SpeakArguments { text: string; voice?: string; instructions?: string; out?: string; play: boolean }
function speakArguments(args: string[]): SpeakArguments | null {
  const parsed: Partial<SpeakArguments> & { play: boolean } = { play: false };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument === '--play' && !parsed.play) parsed.play = true;
    else if ((argument === '--voice' || argument === '--instructions' || argument === '--out') && value) {
      const key = argument.slice(2) as 'voice' | 'instructions' | 'out';
      if (parsed[key] !== undefined) return null;
      parsed[key] = value;
      index++;
    } else if (parsed.text === undefined && !(argument.startsWith('--') && argument !== '-')) parsed.text = argument;
    else return null;
  }
  if (parsed.text === undefined || (parsed.play && parsed.out !== undefined)) return null;
  return parsed as SpeakArguments;
}

export async function runCli(args: string[], options: CliOptions = {}): Promise<number> {
  const runtime = options.runtime ?? createSoundRuntime();
  const agentDir = options.agentDir ?? defaultAgentDir();
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const print = (value: object) => { stdout.write(`${JSON.stringify(value)}\n`); };
  const [command, argument, ...extra] = args;
  const dictate = command === 'dictate' ? dictateArguments(args.slice(1)) : null;
  if (dictate) {
    let stop: (() => void) | undefined;
    const onEnd = () => stop?.();
    try {
      const setting = runtime.readSetting(agentDir);
      // Resolve and validate before creating a capture stream or starting a command.
      const open = transcriberFor(setting, runtime.backends);
      const pcm = dictate.pcm;
      const capture = pcm === undefined ? captureFor(setting, runtime)
        : pcm === '-' ? streamCapture(stdin, 'standard input') : fileCapture(pcm);
      if (!capture) throw new Error('No capture source configured. Supply --pcm FILE|-, an explicit capture command or share.');
      // Options choose this recording's stops over the settings, for targets that cannot submit.
      const dictation = startDictation({ capture, open, signal: options.signal,
        sendWord: dictate.sendWord ?? sendWord(setting), clearWord: dictate.clearWord ?? clearWord(setting),
        sendWordMs: setting.sendWordMs,
        ...(dictate.pauseMs === undefined ? {} : { sendPauseMs: dictate.pauseMs }),
        emit: (message) => print(message.type === 'ready'
          ? { ...message, mode: setting.mode, dictatedFormat: dictatedFormat(setting) } : message) });
      stop = () => dictation.stop();
      if (pcm === undefined) {
        stdin.on('end', onEnd);
        stdin.on('error', onEnd);
        stdin.resume();
        if (stdin.readableEnded) stop();
      }
      await dictation.done;
    } catch (error) {
      if (!options.signal?.aborted) print({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      stdin.off('end', onEnd);
      stdin.off('error', onEnd);
      if (dictate.pcm === undefined) stdin.pause();
    }
    return 0;
  }
  const speak = command === 'speak' ? speakArguments(args.slice(1)) : null;
  try {
    if (command === 'mode' && extra.length === 0) {
      if (argument !== undefined && argument !== 'toggle' && !MODES.includes(argument as DictationMode)) throw new Error(USAGE);
      const setting = argument === undefined ? runtime.readSetting(agentDir) : setMode(agentDir, argument as DictationMode | 'toggle', runtime.readSetting);
      print({ mode: setting.mode });
    } else if (command === 'play' && SOUNDS.includes(argument as SoundName) && extra.length === 0) {
      await playSound(outputFor(runtime.readSetting(agentDir), runtime), argument as SoundName);
    } else if (command === 'notify' && argument !== undefined && extra.length <= 1) {
      await notifyDevice(outputFor(runtime.readSetting(agentDir), runtime), argument, extra[0]);
    } else if (command === 'share-dir' && argument === undefined) {
      stdout.write(`${ensureShareDirectory()}\n`);
    } else if (speak) {
      // Validate settings before reading standard input or resolving credentials.
      const setting = runtime.readSetting(agentDir);
      const model = speechFor(setting, runtime, runtime.credentials ?? piCredentials(agentDir));
      const text = (speak.text === '-' ? await readAll(stdin) : speak.text).trim();
      if (!text) throw new Error('Speech text is empty.');
      const signal = options.signal ?? new AbortController().signal;
      const speakOptions = { ...(speak.voice === undefined ? {} : { voice: speak.voice }),
        ...(speak.instructions === undefined ? {} : { instructions: speak.instructions }), signal };
      if (speak.play) print({ type: 'played', backend: model.backend, ...await playSpeech(model, text, outputFor(setting, runtime), speakOptions) });
      else print({ type: 'speech', ...await saveSpeech(model, text, { ...speakOptions, ...(speak.out === undefined ? {} : { out: speak.out }) }) });
    } else {
      stderr.write(`${USAGE}\n`);
      return 2;
    }
    return 0;
  } catch (error) {
    // Signal cancellation is silent, as in dictation, but still not a success.
    if (!options.signal?.aborted) stderr.write(`pi-sound: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
