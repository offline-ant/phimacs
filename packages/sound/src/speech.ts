/** Explicit text-to-speech models, after the shape of the Vercel AI SDK's speech models. */
import { isBackendId } from './backends.ts';

/** Audio containers a speech model may be asked for; `opus` is Ogg Opus. */
export const SPEECH_MEDIA_TYPES = {
  opus: 'audio/ogg', wav: 'audio/wav', mp3: 'audio/mpeg', flac: 'audio/flac', aac: 'audio/aac', pcm: 'audio/pcm',
} as const;
export type SpeechFormat = keyof typeof SPEECH_MEDIA_TYPES;

export interface SpeechRequest {
  text: string;
  /** Overrides the backend's configured voice. */
  voice?: string;
  /** Overrides the backend's configured delivery instructions. */
  instructions?: string;
  speed?: number;
  format: SpeechFormat;
  signal: AbortSignal;
}
export interface SpeechAudio {
  audio: Buffer;
  mediaType: string;
  format: SpeechFormat;
  voice?: string;
}
export interface SpeechModel {
  readonly backend: string;
  /** Longest text one request accepts, in UTF-16 code units. */
  readonly maxInputLength: number;
  generate(request: SpeechRequest): Promise<SpeechAudio>;
}
/** Resolve an API key for a Pi provider ID at request time; reject when none is configured. */
export type CredentialResolver = (provider: string, signal: AbortSignal) => Promise<string>;
export interface SpeechContext { credentials?: CredentialResolver }
export interface SpeechBackendDefinition<Options> {
  validate(options: unknown): Options;
  /** Construct without network access; requests happen in `generate`. */
  create(options: Options, context: SpeechContext): SpeechModel;
}

/** Registry is an explicit runtime value, never an ambient module singleton. */
export class SpeechRegistry {
  private readonly backends = new Map<string, (options: unknown, context: SpeechContext) => SpeechModel>();

  register<Options>(id: string, definition: SpeechBackendDefinition<Options>): this {
    if (!isBackendId(id)) throw new Error('Invalid speech backend ID.');
    if (this.backends.has(id)) throw new Error(`Speech backend "${id}" is already registered.`);
    this.backends.set(id, (value, context) => definition.create(definition.validate(value), context));
    return this;
  }

  ids(): string[] { return [...this.backends.keys()]; }

  /** Validate options and construct the model; never touches the network or credentials. */
  prepare(id: string | null, options: unknown, context: SpeechContext = {}): SpeechModel {
    if (id === null) throw new Error('Speech is disabled. Configure a speech backend explicitly.');
    const create = this.backends.get(id);
    if (!create) throw new Error(`Speech backend "${id}" is not registered in this runtime.`);
    return create(options, context);
  }
}
