/** Opt-in Pi speech frontend: /speak plays on the speaker; the inactive `speak` tool saves Ogg Opus files. */
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { createSoundRuntime, outputFor, type SoundRuntime } from './runtime.ts';
import { setSpeechBackend } from './settings.ts';
import { playSpeech, saveSpeech, speechFor } from './speak.ts';
import type { CredentialResolver } from './speech.ts';
import { speakableText } from './speech-text.ts';

export interface SpeechDeps { runtime?: SoundRuntime; agentDir?: () => string }
const STATUS = 'speech';

/** Credentials of the session's own model registry, resolved per request. */
function sessionCredentials(ctx: ExtensionContext): CredentialResolver {
  return async (provider) => {
    const key = (await ctx.modelRegistry.getProviderAuth(provider))?.auth.apiKey;
    if (!key) throw new Error(`No API key for Pi provider "${provider}". Configure it with /login or its environment variable.`);
    return key;
  };
}

/** Text of the latest assistant message on the current branch, reduced for speech. */
function lastAssistantText(ctx: ExtensionContext): string | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type !== 'message' || entry.message.role !== 'assistant') continue;
    const text = entry.message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n\n');
    if (text.trim()) return speakableText(text);
  }
  return undefined;
}

export function registerSpeech(pi: ExtensionAPI, deps: SpeechDeps = {}): void {
  const runtime = deps.runtime ?? createSoundRuntime();
  const agentDir = deps.agentDir ?? getAgentDir;
  let active: { controller: AbortController; ctx: ExtensionContext } | undefined;
  const message = (error: unknown) => error instanceof Error ? error.message : String(error);

  function stop(): void {
    const previous = active;
    active = undefined;
    previous?.controller.abort();
    previous?.ctx.ui.setStatus(STATUS, undefined);
  }

  pi.registerCommand('speak', {
    description: 'Speak text, or the last answer, with the configured voice; while speaking, stop',
    async handler(args, ctx) {
      const given = args.trim();
      if (active && !given) { stop(); return; }
      stop();
      try {
        const setting = runtime.readSetting(agentDir());
        const model = speechFor(setting, runtime, runtime.credentials ?? sessionCredentials(ctx));
        const text = given || lastAssistantText(ctx);
        if (!text) throw new Error('No assistant answer to speak.');
        const controller = new AbortController();
        const speaking = { controller, ctx };
        active = speaking;
        ctx.ui.setStatus(STATUS, 'speech: synthesizing…');
        // Playback continues in the background; the command returns so the session stays usable.
        playSpeech(model, text, outputFor(setting, runtime), { signal: controller.signal,
          onProgress: ({ chunk, chunks, device }) => {
            if (active === speaking) ctx.ui.setStatus(STATUS, `speech: ${chunk}/${chunks} on ${device}`);
          } }).then(() => {
          if (active === speaking) stop();
        }, (error: unknown) => {
          if (active !== speaking) return;
          stop();
          ctx.ui.notify(`Speech failed: ${message(error)}`, 'error');
        });
      } catch (error) { ctx.ui.notify(message(error), 'error'); }
    },
  });
  // A new prompt or the end of the session ends speech about the previous answer.
  pi.on('input', () => { stop(); });
  pi.on('session_shutdown', () => { stop(); });

  const choices = () => [...runtime.speech.ids(), 'disabled', 'status'];
  pi.registerCommand('speak-setting', {
    description: 'Select a registered speech backend with JSON options, disabled or status',
    getArgumentCompletions(prefix) {
      return choices().filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
    },
    async handler(args, ctx) {
      const match = /^(\S+)(?:\s+([\s\S]+))?$/.exec(args.trim());
      const choice = match?.[1] ?? await ctx.ui.select('Speech setting', choices());
      const value = match?.[2];
      if (!choice) return;
      if (!choices().includes(choice) || (value && (choice === 'status' || choice === 'disabled'))) throw new Error('Invalid speech setting.');
      if (choice === 'status') {
        // Backend options may hold credentials; status never prints them or probes networks.
        const status = `Speech backend: ${runtime.readSetting(agentDir()).speech?.backend ?? 'disabled'}.`;
        if (ctx.hasUI) ctx.ui.notify(status, 'info');
        else pi.sendMessage({ customType: 'pi-sound:speak-setting-status', content: status, display: true });
        return;
      }
      if (choice === 'disabled') setSpeechBackend(agentDir(), null, {}, runtime.readSetting);
      else {
        const options: unknown = value ? JSON.parse(value) : {};
        if (typeof options !== 'object' || options === null || Array.isArray(options)) throw new Error('Speech backend options must be an object.');
        // Validation only: credentials are resolved when speech is generated.
        runtime.speech.prepare(choice, options, { credentials: sessionCredentials(ctx) });
        setSpeechBackend(agentDir(), choice, options as Record<string, unknown>, runtime.readSetting);
      }
      ctx.ui.notify('Saved speech setting.', 'info');
    },
  });

  pi.registerTool({
    name: 'speak',
    label: 'Speak',
    description: 'Synthesize text as speech in the configured voice and save it as an Ogg Opus file; returns the file path ' +
      'and does not play it. One call accepts at most the backend limit (4096 characters for openai-speech); split longer text.',
    promptSnippet: 'Synthesize text as speech into an Ogg Opus file',
    parameters: Type.Object({
      text: Type.String({ description: 'Plain text to speak, without Markdown' }),
      voice: Type.Optional(Type.String({ description: 'Voice name overriding the configured voice' })),
      instructions: Type.Optional(Type.String({ description: 'Delivery instructions such as tone or pace, if the backend supports them' })),
    }),
    outputSchema: Type.Object({
      path: Type.String(), mediaType: Type.String(), bytes: Type.Number(), backend: Type.String(), voice: Type.Optional(Type.String()),
    }),
    defaultActive: false,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const model = speechFor(runtime.readSetting(agentDir()), runtime, runtime.credentials ?? sessionCredentials(ctx));
      const saved = await saveSpeech(model, params.text, { signal: signal ?? new AbortController().signal,
        ...(params.voice === undefined ? {} : { voice: params.voice }),
        ...(params.instructions === undefined ? {} : { instructions: params.instructions }) });
      return {
        content: [{ type: 'text', text: `Saved speech to ${saved.path} (${saved.mediaType}, ${saved.bytes} bytes).` }],
        details: saved,
        structuredContent: { ...saved },
      };
    },
  });
}
