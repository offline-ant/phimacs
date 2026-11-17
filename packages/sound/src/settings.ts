/** Strict, private settings. Missing configuration disables speech. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writePrivateJson } from '@phimacs/pimux/private-files';
import { isBackendId } from './backends.ts';

export const MODES = ['type', 'send'] as const;
export type DictationMode = (typeof MODES)[number];
export interface CaptureCommand { command: string; args: string[] }
/** Text-to-speech backend; an absent section disables speech. */
export interface SpeechSetting { backend: string; options: Record<string, unknown> }
export interface VoiceSetting {
  backend: string | null;
  options: Record<string, unknown>;
  mode: DictationMode;
  capture?: CaptureCommand;
  /** Use the newest answering shared devices (protocol v1) for capture, speaker and notifications. */
  share?: boolean;
  speech?: SpeechSetting;
  /** Wraps dictated text sent to Pi at its one `%s`; missing means `DEFAULT_DICTATED_FORMAT`. */
  dictatedFormat?: string;
  /** Ending a transcript sends it; missing means `DEFAULT_SEND_WORD`, "" none. */
  sendWord?: string;
  /** Ending a transcript discards it; missing means `DEFAULT_CLEAR_WORD`, "" none. */
  clearWord?: string;
  /** Milliseconds a transcript must end in the send or clear word before recording stops; missing means `SEND_WORD_MS`. */
  sendWordMs?: number;
}
/** The word that, ending a transcript, sends it. */
export const DEFAULT_SEND_WORD = 'send';

/** The send word under SETTING. */
export function sendWord(setting: VoiceSetting): string {
  return setting.sendWord ?? DEFAULT_SEND_WORD;
}
/** The phrase that, ending a transcript, discards it; two words, since transcription
 * tends to merge a repeated single word. */
export const DEFAULT_CLEAR_WORD = 'clear stop';

/** The clear word under SETTING. */
export function clearWord(setting: VoiceSetting): string {
  return setting.clearWord ?? DEFAULT_CLEAR_WORD;
}
/** Tells the model the text was dictated, so it can read a misheard word as a transcription error. */
export const DEFAULT_DICTATED_FORMAT = '(dictated) %s';

/** The format for dictated text sent to Pi under SETTING; `%s` stands for the text. */
export function dictatedFormat(setting: VoiceSetting): string {
  return setting.dictatedFormat ?? DEFAULT_DICTATED_FORMAT;
}

/** TEXT as dictated text sent to Pi under SETTING. */
export function formatDictated(setting: VoiceSetting, text: string): string {
  // A function replacement keeps `$` patterns in TEXT literal.
  return dictatedFormat(setting).replace('%s', () => text);
}

export function defaultAgentDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  const configured = env.PI_CODING_AGENT_DIR;
  if (!configured) return path.join(home, '.pi', 'agent');
  if (configured === '~') return home;
  return configured.startsWith('~/') ? path.join(home, configured.slice(2)) : configured;
}
export function voiceSettingFile(agentDir: string): string { return path.join(agentDir, 'voice.json'); }

export function objectValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseVoiceSetting(value: unknown): VoiceSetting {
  if (!objectValue(value) || Object.keys(value).some((key) => !['backend', 'options', 'mode', 'capture', 'share', 'speech', 'dictatedFormat', 'sendWord', 'clearWord', 'sendWordMs'].includes(key))) {
    throw new Error('Expected backend, options, mode, optional capture command, share, speech, dictatedFormat, sendWord, clearWord and sendWordMs.');
  }
  if (value.share !== undefined && typeof value.share !== 'boolean') throw new Error('share must be a boolean.');
  if (value.share === true && value.capture !== undefined) {
    throw new Error('share and capture are exclusive: shared devices replace the capture command.');
  }
  if (value.sendWordMs !== undefined &&
      (typeof value.sendWordMs !== 'number' || !Number.isFinite(value.sendWordMs) || value.sendWordMs <= 0)) {
    throw new Error('sendWordMs must be a positive number.');
  }
  for (const key of ['dictatedFormat', 'sendWord', 'clearWord'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') throw new Error(`${key} must be a string.`);
  }
  if (value.dictatedFormat !== undefined && (value.dictatedFormat as string).split('%s').length !== 2) {
    throw new Error('dictatedFormat must contain %s exactly once.');
  }
  if (value.backend !== undefined && value.backend !== null &&
      (typeof value.backend !== 'string' || !isBackendId(value.backend))) {
    throw new Error('backend must be a nonempty backend ID or null (disabled).');
  }
  if (value.options !== undefined && !objectValue(value.options)) throw new Error('options must be an object.');
  if (value.mode !== undefined && !MODES.includes(value.mode as DictationMode)) throw new Error('mode must be type or send.');
  const setting: VoiceSetting = {
    backend: (value.backend as string | null | undefined) ?? null,
    options: (value.options as Record<string, unknown> | undefined) ?? {},
    mode: (value.mode as DictationMode | undefined) ?? 'type',
  };
  if (value.capture !== undefined) {
    const capture = value.capture;
    if (!objectValue(capture) || Object.keys(capture).some((key) => key !== 'command' && key !== 'args') ||
        typeof capture.command !== 'string' || !capture.command || !Array.isArray(capture.args) ||
        capture.args.some((arg: unknown) => typeof arg !== 'string')) {
      throw new Error('capture must contain an explicit command and string args array.');
    }
    setting.capture = { command: capture.command, args: capture.args as string[] };
  }
  if (value.share !== undefined) setting.share = value.share as boolean;
  if (value.speech !== undefined) {
    const speech = value.speech;
    if (!objectValue(speech) || Object.keys(speech).some((key) => key !== 'backend' && key !== 'options') ||
        typeof speech.backend !== 'string' || !isBackendId(speech.backend) ||
        (speech.options !== undefined && !objectValue(speech.options))) {
      throw new Error('speech must contain a backend ID and an options object.');
    }
    setting.speech = { backend: speech.backend, options: (speech.options as Record<string, unknown> | undefined) ?? {} };
  }
  if (value.dictatedFormat !== undefined) setting.dictatedFormat = value.dictatedFormat as string;
  if (value.sendWord !== undefined) setting.sendWord = value.sendWord as string;
  if (value.clearWord !== undefined) setting.clearWord = value.clearWord as string;
  if (value.sendWordMs !== undefined) setting.sendWordMs = value.sendWordMs;
  // Settings are JSON data; reject unsupported values instead of dropping them on write.
  const encoded = JSON.stringify(setting, (_key, item: unknown) => {
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint' ||
        (typeof item === 'number' && !Number.isFinite(item))) throw new Error('Settings must contain finite JSON values.');
    return item;
  });
  if (!encoded) throw new Error('Invalid voice configuration.');
  return setting;
}

export function readVoiceSetting(agentDir: string): VoiceSetting {
  const file = voiceSettingFile(agentDir);
  let contents: string;
  try { contents = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { backend: null, options: {}, mode: 'type' };
    throw new Error(`Cannot read voice configuration ${file}.`);
  }
  let value: unknown;
  try { value = JSON.parse(contents); }
  catch { throw new Error(`Invalid voice configuration ${file}: malformed JSON.`); }
  try { return parseVoiceSetting(value); }
  catch (error) { throw new Error(`Invalid voice configuration ${file}: ${error instanceof Error ? error.message : String(error)}`); }
}

export function writeVoiceSetting(agentDir: string, value: VoiceSetting): void {
  const setting = parseVoiceSetting(value);
  const file = voiceSettingFile(agentDir);
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  writePrivateJson(file, setting);
}

export function setBackend(agentDir: string, backend: string | null, options: Record<string, unknown> = {},
  readSetting: (dir: string) => VoiceSetting = readVoiceSetting): VoiceSetting {
  let previous: VoiceSetting | undefined;
  try { previous = readSetting(agentDir); } catch {}
  const setting = parseVoiceSetting({ ...previous, backend, options, mode: previous?.mode ?? 'type' });
  writeVoiceSetting(agentDir, setting);
  return setting;
}

/** Select a speech backend, or remove the speech section with null; dictation settings are kept. */
export function setSpeechBackend(agentDir: string, backend: string | null, options: Record<string, unknown> = {},
  readSetting: (dir: string) => VoiceSetting = readVoiceSetting): VoiceSetting {
  const { speech: _previous, ...rest } = readSetting(agentDir);
  const setting = parseVoiceSetting(backend === null ? rest : { ...rest, speech: { backend, options } });
  writeVoiceSetting(agentDir, setting);
  return setting;
}

export function setMode(agentDir: string, mode: DictationMode | 'toggle',
  readSetting: (dir: string) => VoiceSetting = readVoiceSetting): VoiceSetting {
  const previous = readSetting(agentDir);
  const next = mode === 'toggle' ? (previous.mode === 'type' ? 'send' : 'type') : mode;
  const setting = { ...previous, mode: next };
  writeVoiceSetting(agentDir, setting);
  return setting;
}
