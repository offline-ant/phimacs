/** Explicit OpenAI-compatible `/v1/audio/speech` backend: OpenAI itself or local servers. */
import { endpoint, httpBaseUrl, optionalHeaders, optionalTimeoutMs } from './local.ts';
import { objectValue } from './settings.ts';
import { SPEECH_MEDIA_TYPES, type SpeechBackendDefinition, type SpeechContext, type SpeechModel } from './speech.ts';

/** OpenAI's documented input limit; requests never exceed it. */
export const OPENAI_SPEECH_MAX_INPUT = 4096;
export interface OpenAISpeechOptions {
  url: string;
  model: string;
  voice: string;
  instructions?: string;
  speed?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Pi provider whose API key is sent as a bearer token; omitted means no key (local servers). */
  authProvider?: string;
}
const KEYS = ['url', 'model', 'voice', 'instructions', 'speed', 'timeoutMs', 'headers', 'authProvider'];

export function parseOpenAISpeechOptions(value: unknown): OpenAISpeechOptions {
  if (!objectValue(value) || Object.keys(value).some((key) => !KEYS.includes(key))) {
    throw new Error(`openai-speech accepts only ${KEYS.join(', ')}.`);
  }
  const url = httpBaseUrl(value.url, 'openai-speech');
  for (const key of ['model', 'voice'] as const) {
    if (typeof value[key] !== 'string' || !value[key]) throw new Error(`openai-speech requires a nonempty ${key}.`);
  }
  if (value.instructions !== undefined && typeof value.instructions !== 'string') throw new Error('instructions must be a string.');
  if (value.speed !== undefined && !validSpeed(value.speed)) throw new Error('speed must be a number from 0.25 to 4.');
  if (value.authProvider !== undefined && (typeof value.authProvider !== 'string' || !value.authProvider)) {
    throw new Error('authProvider must name a Pi provider.');
  }
  const timeoutMs = optionalTimeoutMs(value.timeoutMs);
  const headers = optionalHeaders(value.headers);
  if (value.authProvider !== undefined && headers && Object.keys(headers).some((name) => name.toLowerCase() === 'authorization')) {
    throw new Error('Use either authProvider or an Authorization header, not both.');
  }
  return {
    url, model: value.model as string, voice: value.voice as string,
    ...(value.instructions === undefined ? {} : { instructions: value.instructions }),
    ...(value.speed === undefined ? {} : { speed: value.speed as number }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(headers === undefined ? {} : { headers }),
    ...(value.authProvider === undefined ? {} : { authProvider: value.authProvider as string }),
  };
}
function validSpeed(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0.25 && value <= 4;
}

export function openAISpeechModel(options: OpenAISpeechOptions, context: SpeechContext = {}): SpeechModel {
  const target = endpoint(options.url, 'v1/audio/speech');
  const { authProvider } = options;
  if (authProvider !== undefined && !context.credentials) {
    throw new Error(`openai-speech needs Pi credentials for "${authProvider}", but this runtime has no credential resolver.`);
  }
  return {
    backend: 'openai-speech',
    maxInputLength: OPENAI_SPEECH_MAX_INPUT,
    async generate(request) {
      request.signal.throwIfAborted();
      if (!request.text.trim()) throw new Error('Speech text is empty.');
      if (request.text.length > OPENAI_SPEECH_MAX_INPUT) {
        throw new Error(`Speech text has ${request.text.length} characters; openai-speech accepts at most ${OPENAI_SPEECH_MAX_INPUT}.`);
      }
      if (request.speed !== undefined && !validSpeed(request.speed)) throw new Error('speed must be a number from 0.25 to 4.');
      const voice = request.voice ?? options.voice;
      const instructions = request.instructions ?? options.instructions;
      const speed = request.speed ?? options.speed;
      const headers: Record<string, string> = { ...options.headers, 'content-type': 'application/json' };
      if (authProvider !== undefined) headers.authorization = `Bearer ${await context.credentials!(authProvider, request.signal)}`;
      let response: Response;
      try {
        response = await fetch(target, {
          method: 'POST', headers,
          body: JSON.stringify({ model: options.model, input: request.text, voice, response_format: request.format,
            ...(instructions === undefined ? {} : { instructions }), ...(speed === undefined ? {} : { speed }) }),
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(options.timeoutMs ?? 120_000)]),
        });
      } catch {
        request.signal.throwIfAborted();
        throw new Error(`Speech server ${target.origin} unavailable or timed out.`);
      }
      // A server may echo credentials in its body. Never include that body in diagnostics.
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Speech synthesis failed (HTTP ${response.status}).`); }
      let audio: Buffer;
      try { audio = Buffer.from(await response.arrayBuffer()); }
      catch {
        request.signal.throwIfAborted();
        throw new Error(`Speech server ${target.origin} closed the response early.`);
      }
      if (!audio.length) throw new Error('Speech server returned no audio.');
      return { audio, mediaType: SPEECH_MEDIA_TYPES[request.format], format: request.format, voice };
    },
  };
}

export const openAISpeechBackend: SpeechBackendDefinition<OpenAISpeechOptions> = {
  validate: parseOpenAISpeechOptions,
  create: openAISpeechModel,
};
