import fs from 'node:fs';

export const SPEAKER_SAMPLE_RATE = 44_100;
export const SOUNDS = ['done', 'request'] as const;
export type SoundName = (typeof SOUNDS)[number];

export interface OutputSink {
  /** 44.1 kHz mono s16le samples; return a destination label or null. Empty samples probe for a
   * destination. SIGNAL stops waiting; audio already delivered may still play. */
  play(pcm: Buffer, signal?: AbortSignal): Promise<string | null>;
  notify(title: string, body: string): Promise<string | null>;
}

export interface WavPcm { sampleRate: number; channels: number; samples: Buffer }
// Streaming encoders cannot know the length in advance and write one of these placeholders
// (0x7ffff000: espeak-ng --stdout).
const STREAMING_SIZES = new Set([0, 0x7fff_f000, 0xffff_ffff]);

/** Validate chunk bounds and read 16-bit PCM; a streamed data chunk extends to the end. */
export function parseWav(wav: Buffer): WavPcm {
  if (wav.length < 12 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a WAV file.');
  }
  let format: { sampleRate: number; channels: number } | undefined;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'data' && STREAMING_SIZES.has(size) && body < wav.length) {
      if (!format) throw new Error('WAV must be 16-bit PCM.');
      const end = body + Math.floor((wav.length - body) / (2 * format.channels)) * 2 * format.channels;
      return { ...format, samples: wav.subarray(body, end) };
    }
    if (body + size > wav.length) throw new Error('Truncated WAV chunk.');
    if (id === 'fmt ') {
      if (size < 16) throw new Error('Truncated WAV format.');
      const channels = wav.readUInt16LE(body + 2);
      const sampleRate = wav.readUInt32LE(body + 4);
      format = wav.readUInt16LE(body) === 1 && wav.readUInt16LE(body + 14) === 16 && channels > 0 && sampleRate > 0
        ? { sampleRate, channels } : undefined;
    } else if (id === 'data') {
      if (!format || size % (2 * format.channels)) throw new Error('WAV must be 16-bit PCM.');
      return { ...format, samples: wav.subarray(body, body + size) };
    }
    offset = body + size + (size % 2);
  }
  throw new Error('WAV file has no data chunk.');
}

/** Bundled sounds are already in the speaker format. */
export function wavSamples(wav: Buffer): Buffer {
  const pcm = parseWav(wav);
  if (pcm.sampleRate !== SPEAKER_SAMPLE_RATE || pcm.channels !== 1) throw new Error('WAV must be 44100 Hz mono 16-bit PCM.');
  return pcm.samples;
}

/** Mix to mono and resample linearly to the speaker rate, without an external decoder. */
export function speakerSamples(wav: Buffer): Buffer {
  const { sampleRate, channels, samples } = parseWav(wav);
  const frames = samples.length / (2 * channels);
  const mono = new Float64Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel++) sum += samples.readInt16LE((frame * channels + channel) * 2);
    mono[frame] = sum / channels;
  }
  const length = Math.floor(frames * SPEAKER_SAMPLE_RATE / sampleRate);
  const output = Buffer.alloc(length * 2);
  const step = sampleRate / SPEAKER_SAMPLE_RATE;
  for (let index = 0; index < length; index++) {
    const position = index * step;
    const left = Math.floor(position);
    const right = Math.min(left + 1, frames - 1);
    const value = mono[left] + (mono[right] - mono[left]) * (position - left);
    output.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value))), index * 2);
  }
  return output;
}
export function soundFile(name: SoundName): URL {
  if (!SOUNDS.includes(name)) throw new Error('Unknown notification sound.');
  return new URL(`../sounds/${name}.wav`, import.meta.url);
}
export async function playSound(sink: OutputSink | undefined, name: SoundName): Promise<string | null> {
  const file = soundFile(name);
  if (!sink) return null;
  return sink.play(wavSamples(fs.readFileSync(file)));
}
export async function notifyDevice(sink: OutputSink | undefined, title: string, body = ''): Promise<string | null> {
  return sink ? sink.notify(title.replace(/[\r\n]+/g, ' ').trim(), body) : null;
}
