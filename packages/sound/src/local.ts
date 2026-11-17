/** Explicit OpenAI-compatible multipart transcription backend. */
import { wav, type BackendDefinition, type Transcriber } from './backends.ts';
import { objectValue } from './settings.ts';

export interface LocalOptions { url: string; model?: string; timeoutMs?: number; headers?: Record<string, string> }

/** Shared option checks of the OpenAI-compatible HTTP backends. */
export function httpBaseUrl(value: unknown, backend: string): string {
  const url = typeof value === 'string' ? URL.parse(value) : null;
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${backend} url must be an explicit credential-free http(s) base URL.`);
  }
  return url.href;
}
export function optionalTimeoutMs(value: unknown): number | undefined {
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) {
    throw new Error('timeoutMs must be a positive finite number.');
  }
  return value as number | undefined;
}
export function optionalHeaders(value: unknown): Record<string, string> | undefined {
  if (value !== undefined && (!objectValue(value) || Object.values(value).some((entry) => typeof entry !== 'string'))) {
    throw new Error('headers must contain string values.');
  }
  return value as Record<string, string> | undefined;
}
export function endpoint(base: string, route: string): URL {
  return new URL(route, base.endsWith('/') ? base : `${base}/`);
}

export function parseLocalOptions(value: unknown): LocalOptions {
  if (!objectValue(value) || Object.keys(value).some((key) => !['url', 'model', 'timeoutMs', 'headers'].includes(key))) {
    throw new Error('Local backend accepts only url, model, timeoutMs and headers.');
  }
  const url = httpBaseUrl(value.url, 'Local backend');
  if (value.model !== undefined && (typeof value.model !== 'string' || !value.model)) throw new Error('model must be nonempty.');
  const timeoutMs = optionalTimeoutMs(value.timeoutMs);
  const headers = optionalHeaders(value.headers);
  return { url, ...(value.model === undefined ? {} : { model: value.model as string }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }), ...(headers === undefined ? {} : { headers }) };
}

export function localTranscriber(options: LocalOptions, signal?: AbortSignal): Transcriber {
  options = parseLocalOptions(options);
  let chunks: Buffer[] = [];
  let closed = false;
  let finishing: Promise<string> | undefined;
  const controller = new AbortController();
  const abort = () => { closed = true; chunks = []; controller.abort(signal?.reason); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  return {
    write(pcm) {
      if (closed || finishing) throw new Error('Transcriber is closed.');
      chunks.push(Buffer.from(pcm));
    },
    finish() {
      if (finishing) return finishing;
      finishing = (async () => {
        controller.signal.throwIfAborted();
        if (closed) throw new Error('Transcriber is closed.');
        const pcm = Buffer.concat(chunks);
        chunks = [];
        if (!pcm.length) return '';
        const form = new FormData();
        form.append('file', new Blob([new Uint8Array(wav(pcm))], { type: 'audio/wav' }), 'recording.wav');
        form.append('model', options.model ?? 'whisper-1');
        form.append('language', 'en');
        form.append('response_format', 'json');
        const target = endpoint(options.url, 'v1/audio/transcriptions');
        let response: Response;
        try {
          response = await fetch(target, { method: 'POST', body: form, headers: options.headers,
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(options.timeoutMs ?? 120_000)]) });
        } catch {
          throw new Error(`Transcription server ${target.origin} unavailable or request cancelled.`);
        }
        // A server may echo secrets in its body. Never include that body in diagnostics.
        if (!response.ok) { await response.body?.cancel(); throw new Error(`Transcription failed (HTTP ${response.status}).`); }
        let value: unknown;
        try { value = await response.json(); } catch { throw new Error('Transcription server returned invalid JSON.'); }
        if (!objectValue(value) || typeof value.text !== 'string') throw new Error('Transcription server returned no text.');
        return value.text.trim();
      })();
      return finishing;
    },
    close() {
      closed = true;
      chunks = [];
      controller.abort();
      signal?.removeEventListener('abort', abort);
    },
  };
}
export const localBackend: BackendDefinition<LocalOptions> = {
  validate: parseLocalOptions,
  open: (options, _events, signal) => localTranscriber(options, signal),
};
