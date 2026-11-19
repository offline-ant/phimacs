/*
 * Dictation socket (`/ws/voice`).
 *
 * The browser streams 16 kHz mono linear16 PCM as binary frames and sends
 * `{"type":"stop"}` when done. Tau replies
 * `{"type":"ready","backend","mode","dictatedFormat"}`, any number of
 * `{"type":"partial","text"}` previews, then exactly one terminal
 * `{"type":"final","text","limited"?,"send"?,"clear"?}` or
 * `{"type":"error","message"}` before closing. Closing the socket cancels the
 * recording. Audio and text never reach Pi from here: the browser decides what
 * to insert or submit.
 *
 * Each connection is one @phimacs/sound dictation, the same logic `pi-sound
 * dictate` runs for Emacs: a trailing send word or a pause after speech stops
 * the recording and sets `send`; a trailing clear word discards it.
 */

import { PassThrough } from 'node:stream';
import { WebSocket } from 'ws';

import {
  IDLE_MS, MAX_RECORDING_SECONDS, SEND_PAUSE_MS, clearWord, createSoundRuntime, dictatedFormat, sendWord, startDictation,
  transcriberFor, type CaptureSource, type OpenTranscriber, type SoundRuntime, type VoiceSetting,
} from '@phimacs/sound';

export const VOICE_PATH = '/ws/voice';
export const MAX_FRAME_BYTES = 64 * 1024;

export type VoiceLimits = { maxSeconds?: number; idleMs?: number; sendPauseMs?: number };

/** One connection's voice setting and transcriber; it may throw for invalid settings. */
export type VoiceConfiguration = () => { setting: VoiceSetting; open: OpenTranscriber };

/** Read the voice setting through RUNTIME for every connection, and open its selected backend. */
export function configuredVoice(agentDir: string, runtime: SoundRuntime = createSoundRuntime()): VoiceConfiguration {
  return () => {
    const setting = runtime.readSetting(agentDir);
    // Preparing validates the backend; a rejection reports it through the dictation.
    return { setting, open: async (events, signal) => transcriberFor(setting, runtime.backends)(events, signal) };
  };
}

export function handleVoiceSocket(ws: WebSocket, configure: VoiceConfiguration, limits: VoiceLimits = {}): void {
  const idleMs = limits.idleMs ?? IDLE_MS;
  const audio = new PassThrough();
  let ready = false;
  let done = false;
  let opening: NodeJS.Timeout | undefined;
  const send = (message: object) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); };
  function end(message: object) {
    if (done) return;
    done = true;
    clearTimeout(opening);
    audio.destroy();
    send(message);
    if (ws.readyState === WebSocket.OPEN) ws.close(1000);
  }
  const fail = (message: string) => end({ type: 'error', message });

  let setting: VoiceSetting;
  let open: OpenTranscriber;
  try { ({ setting, open } = configure()); }
  catch (error) { return fail(error instanceof Error ? error.message : String(error)); }

  // The socket's PCM frames are this dictation's capture stream.
  const capture: CaptureSource = {
    open(signal) {
      signal.throwIfAborted();
      return { device: 'browser microphone', stream: audio, close: () => audio.destroy() };
    },
  };
  const dictation = startDictation({
    capture, open, maxSeconds: limits.maxSeconds ?? MAX_RECORDING_SECONDS, idleMs,
    sendWord: sendWord(setting), clearWord: clearWord(setting), sendWordMs: setting.sendWordMs,
    sendPauseMs: limits.sendPauseMs ?? SEND_PAUSE_MS,
    emit(message) {
      if (message.type === 'ready') {
        ready = true;
        clearTimeout(opening);
        send({ type: 'ready', backend: message.backend, mode: setting.mode, dictatedFormat: dictatedFormat(setting) });
      } else if (message.type === 'partial') send(message);
      else end(message);
    },
  });
  // Dictation's idle limit starts with capture; this one bounds backend opening.
  opening = setTimeout(() => {
    dictation.cancel();
    fail('The speech backend did not become ready in time; recording stopped.');
  }, idleMs);

  const cancel = () => { done = true; clearTimeout(opening); dictation.cancel(); };
  ws.on('close', cancel);
  ws.on('error', cancel);
  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (done) return;
    if (!isBinary) {
      let message: { type?: unknown } = {};
      try { message = JSON.parse(String(data)); } catch {}
      if (message.type === 'stop') dictation.stop();
      else { dictation.cancel(); fail('Unknown voice message.'); }
      return;
    }
    if (!ready) {
      dictation.cancel();
      return fail('Audio received before the speech backend was ready. Wait for the ready message before sending PCM.');
    }
    // A stop, the send or clear word, a pause or the limit has ended capture; late frames are dropped.
    if (audio.destroyed) return;
    if (data.length > MAX_FRAME_BYTES) { dictation.cancel(); return fail('Audio frame exceeds the 64 KiB limit.'); }
    if (data.length % 2 !== 0) { dictation.cancel(); return fail('Audio frames must contain whole 16-bit samples.'); }
    audio.write(Buffer.from(data));
  });
}
