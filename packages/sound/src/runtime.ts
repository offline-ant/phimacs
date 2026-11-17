import { BackendRegistry, type TranscriberEvents, type Transcriber } from './backends.ts';
import { commandCapture, type CaptureSource } from './capture.ts';
import { commandSpeechBackend } from './command-speech.ts';
import { localBackend } from './local.ts';
import { openAISpeechBackend } from './openai-speech.ts';
import type { OutputSink } from './output.ts';
import { readVoiceSetting, type VoiceSetting } from './settings.ts';
import { sharedCapture, sharedOutput } from './share.ts';
import { SpeechRegistry, type CredentialResolver } from './speech.ts';

export type OpenTranscriber = (events: TranscriberEvents, signal: AbortSignal) =>
  Promise<{ backend: string; transcriber: Transcriber }>;

export interface SoundRuntime {
  readonly backends: BackendRegistry;
  readonly speech: SpeechRegistry;
  readonly capture?: CaptureSource;
  readonly output?: OutputSink;
  /** Overrides the frontend's Pi credentials (the CLI's agent directory, the extension's session). */
  readonly credentials?: CredentialResolver;
  readSetting(agentDir: string): VoiceSetting;
}
export function createPublicBackends(): BackendRegistry { return new BackendRegistry().register('local', localBackend); }
export function createPublicSpeech(): SpeechRegistry {
  return new SpeechRegistry().register('openai-speech', openAISpeechBackend).register('command', commandSpeechBackend);
}
export function createSoundRuntime(options: Partial<SoundRuntime> = {}): SoundRuntime {
  return { backends: options.backends ?? createPublicBackends(), speech: options.speech ?? createPublicSpeech(),
    capture: options.capture, output: options.output, credentials: options.credentials,
    readSetting: options.readSetting ?? readVoiceSetting };
}
/** The composed capture source, else the shared devices or capture command SETTING selects. */
export function captureFor(setting: VoiceSetting, runtime: SoundRuntime): CaptureSource | undefined {
  if (runtime.capture) return runtime.capture;
  if (setting.share) return sharedCapture();
  return setting.capture && commandCapture(setting.capture);
}
/** The composed output sink, else the shared devices SETTING selects. */
export function outputFor(setting: VoiceSetting, runtime: SoundRuntime): OutputSink | undefined {
  return runtime.output ?? (setting.share ? sharedOutput() : undefined);
}
/** Validation runs before capture/network resources are acquired. */
export function transcriberFor(setting: VoiceSetting, backends: BackendRegistry): OpenTranscriber {
  const prepared = backends.prepare(setting.backend, setting.options);
  return async (events, signal) => ({ backend: prepared.backend, transcriber: await prepared.open(events, signal) });
}
/** Re-read settings for every utterance; callers own their registry explicitly. */
export function configuredTranscriber(agentDir: string, runtime: SoundRuntime = createSoundRuntime()): OpenTranscriber {
  return async (events, signal) => transcriberFor(runtime.readSetting(agentDir), runtime.backends)(events, signal);
}
