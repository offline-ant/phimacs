/** Explicit speech backends; input is English 16 kHz mono s16le PCM. */
export const SAMPLE_RATE = 16_000;

export interface TranscriberEvents {
  partial(text: string): void;
  error(message: string): void;
}
export interface Transcriber {
  write(pcm: Buffer): void;
  finish(): Promise<string>;
  close(): void;
}
export interface BackendDefinition<Options> {
  validate(options: unknown): Options;
  /** Resolve only when ready to accept PCM; release resources on cancellation. */
  open(options: Options, events: TranscriberEvents, signal: AbortSignal): Transcriber | Promise<Transcriber>;
}
export interface PreparedBackend {
  readonly backend: string;
  open(events: TranscriberEvents, signal: AbortSignal): Promise<Transcriber>;
}

/** Backend IDs of both registries; `disabled` names the absent backend in settings commands. */
export function isBackendId(id: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id) && id !== 'disabled';
}

/** Registry is an explicit runtime value, never an ambient module singleton. */
export class BackendRegistry {
  private readonly backends = new Map<string, (options: unknown) => PreparedBackend>();

  register<Options>(id: string, definition: BackendDefinition<Options>): this {
    if (!isBackendId(id)) throw new Error('Invalid backend ID.');
    if (this.backends.has(id)) throw new Error(`Backend "${id}" is already registered.`);
    this.backends.set(id, (value) => {
      const options = definition.validate(value);
      return {
        backend: id,
        async open(events, signal) {
          signal.throwIfAborted();
          const transcriber = await definition.open(options, events, signal);
          if (signal.aborted) {
            transcriber.close();
            signal.throwIfAborted();
          }
          return transcriber;
        },
      };
    });
    return this;
  }

  ids(): string[] { return [...this.backends.keys()]; }

  prepare(id: string | null, options: unknown = {}): PreparedBackend {
    if (id === null) throw new Error('Dictation is disabled. Configure a speech backend explicitly.');
    const prepare = this.backends.get(id);
    if (!prepare) throw new Error(`Speech backend "${id}" is not registered in this runtime.`);
    return prepare(options);
  }
}

export function wav(pcm: Buffer): Buffer {
  if (pcm.length % 2) throw new Error('PCM must contain complete 16-bit samples.');
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
