/** Speech operations of the CLI and extension: synthesize to a private file or play on the speaker. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SPEAKER_SAMPLE_RATE, speakerSamples, type OutputSink } from './output.ts';
import type { SoundRuntime } from './runtime.ts';
import type { VoiceSetting } from './settings.ts';
import type { CredentialResolver, SpeechAudio, SpeechModel } from './speech.ts';
import { splitSpeechText } from './speech-text.ts';

/** Playback chunks stay short so speech starts soon; the next chunk is synthesized while one plays. */
export const PLAYBACK_CHUNK_CHARS = 500;
export interface SpeakOptions { voice?: string; instructions?: string; signal: AbortSignal }
export interface SavedSpeech { path: string; mediaType: string; bytes: number; backend: string; voice?: string }

/** Validate the configured backend before any network or credential access. */
export function speechFor(setting: VoiceSetting, runtime: SoundRuntime, credentials?: CredentialResolver): SpeechModel {
  const configured = setting.speech;
  return runtime.speech.prepare(configured?.backend ?? null, configured?.options ?? {},
    credentials ? { credentials } : {});
}

/** Private per-user directory for speech files, kept until the caller or the system removes them. */
export function speechDir(env: NodeJS.ProcessEnv = process.env): string {
  // Separate from the device share directory, which holds only device sockets.
  return path.join(env.XDG_RUNTIME_DIR || os.tmpdir(), `pi-speech-${os.userInfo().uid}`);
}

/** Synthesize one request as Ogg Opus; text over the backend limit is an error, never truncated. */
export async function saveSpeech(model: SpeechModel, text: string, options: SpeakOptions & { out?: string }): Promise<SavedSpeech> {
  if (text.length > model.maxInputLength) {
    throw new Error(`Speech text has ${text.length} characters; ${model.backend} accepts at most ${model.maxInputLength}. Split it into several requests.`);
  }
  let file = options.out;
  if (file === undefined) {
    const dir = speechDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}.ogg`);
  }
  // Create exclusively before the request: never replace a file (or follow a planted symlink),
  // and never pay for audio that cannot be saved.
  const descriptor = fs.openSync(file, 'wx', 0o600);
  let result: SpeechAudio;
  try {
    result = await model.generate({ text, format: 'opus', signal: options.signal,
      ...(options.voice === undefined ? {} : { voice: options.voice }),
      ...(options.instructions === undefined ? {} : { instructions: options.instructions }) });
    fs.writeFileSync(descriptor, result.audio);
  } catch (error) {
    fs.closeSync(descriptor);
    fs.rmSync(file, { force: true });
    throw error;
  }
  fs.closeSync(descriptor);
  return { path: path.resolve(file), mediaType: result.mediaType, bytes: result.audio.length, backend: model.backend,
    ...(result.voice === undefined ? {} : { voice: result.voice }) };
}

export interface PlaybackProgress { chunk: number; chunks: number; device: string }

/**
 * Speak text of any length on the speaker. Each chunk is sent when the previous one should have
 * finished, because every speaker connection starts its own player. Cancellation stops further
 * synthesis and sending; audio already sent plays to its end.
 */
export async function playSpeech(model: SpeechModel, text: string, sink: OutputSink | undefined,
  options: SpeakOptions & { onProgress?(progress: PlaybackProgress): void }): Promise<{ device: string; chunks: number }> {
  if (!sink) throw new Error('No speaker output is configured in this runtime.');
  const chunks = splitSpeechText(text, Math.min(model.maxInputLength, PLAYBACK_CHUNK_CHARS));
  if (!chunks.length) throw new Error('Nothing to speak.');
  // Zero samples probe for a device, so no speech is synthesized (and paid for) without one.
  if (await sink.play(Buffer.alloc(0), options.signal) === null) throw new Error('No speaker device is connected.');
  const synthesize = (chunk: string) => {
    const pcm = model.generate({ text: chunk, format: 'wav', signal: options.signal,
      ...(options.voice === undefined ? {} : { voice: options.voice }),
      ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
    }).then((result) => speakerSamples(result.audio));
    // A prefetched chunk may fail while the previous one plays; its rejection surfaces when awaited.
    pcm.catch(() => {});
    return pcm;
  };
  let next = synthesize(chunks[0]);
  let device = '';
  let playingUntil = Date.now();
  for (let index = 0; index < chunks.length; index++) {
    const pcm = await next;
    if (index + 1 < chunks.length) next = synthesize(chunks[index + 1]);
    await delay(Math.max(0, playingUntil - Date.now()), undefined, { signal: options.signal });
    // A sink may resolve only once the chunk has played, so time it from sending.
    const sent = Date.now();
    const played = await sink.play(pcm, options.signal);
    if (played === null) throw new Error('No speaker device is connected.');
    device = played;
    playingUntil = sent + pcm.length / 2 / SPEAKER_SAMPLE_RATE * 1000;
    options.onProgress?.({ chunk: index + 1, chunks: chunks.length, device });
  }
  await delay(Math.max(0, playingUntil - Date.now()), undefined, { signal: options.signal });
  return { device, chunks: chunks.length };
}
