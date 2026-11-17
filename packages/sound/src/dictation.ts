import { SAMPLE_RATE, type Transcriber } from './backends.ts';
import type { Capture, CaptureSource } from './capture.ts';
import type { OpenTranscriber } from './runtime.ts';
import { DEFAULT_CLEAR_WORD, DEFAULT_SEND_WORD } from './settings.ts';

export const MAX_RECORDING_SECONDS = 300;
export const IDLE_MS = 15_000;
/** How long a live transcript must end in the send or clear word before recording stops by itself. */
export const SEND_WORD_MS = 1_000;
/** How long a pause after speech stops the recording and sends it. */
export const SEND_PAUSE_MS = 4_000;

/** Match WORD ending a transcript, then only punctuation; the words of a phrase may be
 * separated by spaces and punctuation.  Undefined for an empty WORD. */
function endWordPattern(word: string): RegExp | undefined {
  const words = word.trim().split(/\s+/u).filter(Boolean)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
  return words.length ? new RegExp(`(^|[^\\p{L}\\p{N}'’])${words.join('[\\s\\p{P}]+')}[\\s\\p{P}]*$`, 'iu') : undefined;
}
export type DictationMessage =
  | { type: 'ready'; device: string; backend: string }
  | { type: 'partial'; text: string }
  /** `send`: the transcript ended in the send word, which `text` omits, or a pause
   * stopped the recording; frontends submit it.  `clear`: the transcript ended in
   * the clear word; `text` is empty and frontends discard the dictation. */
  | { type: 'final'; text: string; limited?: true; send?: true; clear?: true }
  | { type: 'error'; message: string };
export interface Dictation {
  stop(): void;
  cancel(): void;
  readonly done: Promise<void>;
}
export interface DictationOptions {
  capture: CaptureSource;
  open: OpenTranscriber;
  emit(message: DictationMessage): void;
  maxSeconds?: number;
  idleMs?: number;
  /** Default `DEFAULT_SEND_WORD`; "" sends only on a pause. */
  sendWord?: string;
  /** Default `DEFAULT_CLEAR_WORD`; "" none. */
  clearWord?: string;
  sendWordMs?: number;
  /** Default `SEND_PAUSE_MS`; 0 never stops on a pause. */
  sendPauseMs?: number;
  signal?: AbortSignal;
}

/** The final message for TEXT: a trailing CLEAR-WORD match discards it, else a
 * trailing SEND-WORD match or a PAUSED stop sets `send`. */
function finalMessage(text: string, limited: boolean, paused: boolean,
  sendWord: RegExp | undefined, clearWord: RegExp | undefined): DictationMessage {
  if (clearWord?.test(text)) return { type: 'final', text: '', clear: true };
  const match = sendWord?.exec(text);
  const kept = match ? text.slice(0, match.index + match[1].length).replace(/[\s,;:]+$/u, '') : text;
  return { type: 'final', text: kept, ...(limited ? { limited: true as const } : {}),
    ...(match || paused ? { send: true as const } : {}) };
}

/** One utterance, exactly one terminal message unless cancelled. */
export function startDictation(options: DictationOptions): Dictation {
  const maxSeconds = options.maxSeconds ?? MAX_RECORDING_SECONDS;
  const idleMs = options.idleMs ?? IDLE_MS;
  const sendWordMs = options.sendWordMs ?? SEND_WORD_MS;
  const sendPauseMs = options.sendPauseMs ?? SEND_PAUSE_MS;
  const sendWord = endWordPattern(options.sendWord ?? DEFAULT_SEND_WORD);
  const clearWord = endWordPattern(options.clearWord ?? DEFAULT_CLEAR_WORD);
  if (!Number.isFinite(maxSeconds) || maxSeconds <= 0 || maxSeconds > MAX_RECORDING_SECONDS ||
      [idleMs, sendWordMs].some((ms) => !Number.isFinite(ms) || ms <= 0) ||
      !Number.isFinite(sendPauseMs) || sendPauseMs < 0) {
    throw new Error('Invalid dictation limits.');
  }
  const maxBytes = Math.floor(maxSeconds * SAMPLE_RATE) * 2;
  const backendAbort = new AbortController();
  const captureAbort = new AbortController();
  let capture: Capture | undefined;
  let transcriber: Transcriber | undefined;
  let received = 0;
  let odd: Buffer | undefined;
  let done = false;
  let finishing = false;
  let stopRequested = false;
  let ready = false;
  let pendingPartial: string | undefined;
  let idle: NodeJS.Timeout | undefined;
  let pause: NodeJS.Timeout | undefined;
  let paused = false;
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => { settle = resolve; });

  function releaseCapture() {
    clearTimeout(idle);
    clearTimeout(pause);
    captureAbort.abort();
    capture?.close();
  }
  function end(message: DictationMessage | null) {
    if (done) return;
    done = true;
    releaseCapture();
    backendAbort.abort();
    transcriber?.close();
    options.signal?.removeEventListener('abort', cancel);
    try { if (message) options.emit(message); } finally { settle(); }
  }
  function cancel() { end(null); }
  function fail(error: unknown) {
    end({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
  function finish(limited: boolean) {
    if (done || finishing || !transcriber || !capture) return;
    finishing = true;
    releaseCapture();
    if (!received) return fail(new Error('The configured capture source produced no audio.'));
    Promise.resolve().then(() => transcriber!.finish()).then(
      (text) => end(finalMessage(text, limited, paused, sendWord, clearWord)), fail);
  }
  function resetIdle() {
    clearTimeout(idle);
    idle = setTimeout(() => fail(new Error('No audio from the configured capture source; recording stopped.')), idleMs);
  }
  async function run() {
    backendAbort.signal.throwIfAborted();
    const opened = await options.open({
      partial: (text) => {
        if (done || finishing) return;
        // Silence sends no partials, so the time since the latest one is the pause.
        clearTimeout(pause);
        const delay = !text.trim() ? 0 : sendWord?.test(text) || clearWord?.test(text) ? sendWordMs : sendPauseMs;
        if (delay) pause = setTimeout(() => { paused = true; finish(false); }, delay);
        if (ready) options.emit({ type: 'partial', text });
        else pendingPartial = text;
      },
      error: (message) => fail(new Error(message)),
    }, backendAbort.signal);
    transcriber = opened.transcriber;
    if (done) { transcriber.close(); return; }
    // Await backend readiness before capture is opened or ready is reported.
    capture = await options.capture.open(captureAbort.signal);
    if (done) { capture.close(); return; }
    options.emit({ type: 'ready', device: capture.device, backend: opened.backend });
    ready = true;
    if (pendingPartial !== undefined && !done) options.emit({ type: 'partial', text: pendingPartial });
    if (done) return;
    capture.stream.on('error', fail);
    capture.stream.on('end', () => finish(false));
    capture.stream.on('close', () => { if (!done && !finishing) finish(false); });
    capture.stream.on('data', (data: Buffer | string) => {
      if (done || finishing || !transcriber) return;
      const bytes = typeof data === 'string' ? Buffer.from(data) : data;
      let chunk = odd ? Buffer.concat([odd, bytes]) : bytes;
      odd = undefined;
      if (chunk.length % 2) { odd = chunk.subarray(-1); chunk = chunk.subarray(0, -1); }
      chunk = chunk.subarray(0, maxBytes - received);
      received += chunk.length;
      try { if (chunk.length) transcriber.write(Buffer.from(chunk)); } catch (error) { fail(error); return; }
      if (received >= maxBytes) finish(true);
      else resetIdle();
    });
    if (stopRequested) finish(false);
    else resetIdle();
  }
  // A microtask boundary prevents synchronous callbacks from preceding caller setup.
  Promise.resolve().then(run).catch(fail);
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  return { stop() { stopRequested = true; finish(false); }, cancel, done: settled };
}
