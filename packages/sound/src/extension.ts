/** Opt-in Pi frontend; runtime integrations are explicitly composed by its owner. */
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { startDictation, type Dictation } from './dictation.ts';
import { captureFor, createSoundRuntime, transcriberFor, type SoundRuntime } from './runtime.ts';
import { MODES, clearWord, formatDictated, sendWord, setBackend, setMode, type DictationMode } from './settings.ts';
import { registerSpeech } from './speech-extension.ts';

export interface DictationDeps { runtime?: SoundRuntime; agentDir?: () => string }
const STATUS = 'dictation';
// Deliberate process-wide recording lease, even if Pi loads separate module roots.
// Backend registries/runtime composition remain independent explicit values.
const ACTIVE = Symbol.for('pi-sound:active-dictation');
const processRecording = globalThis as typeof globalThis & { [ACTIVE]?: Dictation };

export function registerDictation(pi: ExtensionAPI, deps: DictationDeps = {}): void {
  const runtime = deps.runtime ?? createSoundRuntime();
  const agentDir = deps.agentDir ?? getAgentDir;
  let active: Dictation | undefined;
  let context: ExtensionContext | undefined;
  const text = (error: unknown) => error instanceof Error ? error.message : String(error);

  function toggle(ctx: ExtensionContext): void {
    if (active) {
      active.stop();
      if (active) ctx.ui.setStatus(STATUS, '… transcribing');
      return;
    }
    if (processRecording[ACTIVE]) {
      ctx.ui.notify('Dictation is already recording in this Pi process.', 'warning');
      return;
    }
    try {
      const setting = runtime.readSetting(agentDir());
      if (setting.mode === 'type' && ctx.mode !== 'tui') {
        ctx.ui.notify('Dictation type mode needs the TUI editor. Use your frontend dictation command, or /dictate-setting send.', 'warning');
        return;
      }
      const open = transcriberFor(setting, runtime.backends);
      const capture = captureFor(setting, runtime);
      if (!capture) throw new Error('No capture source configured for dictation.');
      context = ctx;
      const dot = ctx.ui.theme.fg('error', '●');
      let device = '';
      const dictation = startDictation({ capture, open, sendWord: sendWord(setting), clearWord: clearWord(setting),
        sendWordMs: setting.sendWordMs,
        emit(message) {
          if (active !== dictation) return;
          if (message.type === 'ready') {
            device = message.device;
            ctx.ui.setStatus(STATUS, `${dot} rec ${device}`);
          } else if (message.type === 'partial') {
            const preview = message.text.replace(/\s+/g, ' ').trim();
            ctx.ui.setStatus(STATUS, `${dot} rec ${device}: ${preview.length > 40 ? '…' + preview.slice(-40) : preview}`);
          } else {
            active = undefined;
            if (processRecording[ACTIVE] === dictation) delete processRecording[ACTIVE];
            context = undefined;
            ctx.ui.setStatus(STATUS, undefined);
            if (message.type === 'error') ctx.ui.notify(`Dictation failed: ${message.message}`, 'error');
            else if (message.clear) ctx.ui.notify('Dictation cleared.', 'info');
            else {
              if (message.limited) ctx.ui.notify('Dictation stopped at the 5-minute limit.', 'warning');
              const spoken = message.text.trim();
              let transcript = spoken && formatDictated(setting, spoken);
              if (setting.mode === 'type') {
                if (transcript) ctx.ui.pasteToEditor(transcript);
                // A `send` final submits the editor, including the pasted transcript.
                if (message.send) {
                  transcript = ctx.ui.getEditorText().trim();
                  if (transcript) ctx.ui.setEditorText('');
                }
              }
              if (!transcript) ctx.ui.notify('Dictation: nothing heard.', 'info');
              else if (setting.mode === 'send' || message.send) {
                try { pi.sendUserMessage(transcript, ctx.isIdle() ? undefined : { deliverAs: 'steer' }); }
                catch (error) { ctx.ui.notify(`Dictation could not send: ${text(error)}`, 'error'); }
              }
            }
          }
        },
      });
      active = dictation;
      processRecording[ACTIVE] = dictation;
      ctx.ui.setStatus(STATUS, `${dot} rec connecting…`);
    } catch (error) { ctx.ui.notify(text(error), 'error'); }
  }

  pi.registerCommand('dictate', { description: 'Start or stop explicitly configured dictation',
    handler: async (_args, ctx) => toggle(ctx) });
  pi.registerShortcut('alt+v', { description: 'Start or stop dictation', handler: toggle });
  pi.on('session_shutdown', () => {
    const previous = active;
    active = undefined;
    if (processRecording[ACTIVE] === previous) delete processRecording[ACTIVE];
    previous?.cancel();
    context?.ui.setStatus(STATUS, undefined);
    context = undefined;
  });
  const choices = () => [...runtime.backends.ids(), 'disabled', ...MODES, 'status'];
  pi.registerCommand('dictate-setting', {
    description: 'Select a registered backend, mode, disabled or status; backend options are a JSON object',
    getArgumentCompletions(prefix) {
      return choices().filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
    },
    async handler(args, ctx) {
      const trimmed = args.trim();
      const match = /^(\S+)(?:\s+([\s\S]+))?$/.exec(trimmed);
      const choice = match?.[1] ?? await ctx.ui.select('Dictation setting', choices());
      const value = match?.[2];
      if (!choice) return;
      if (!choices().includes(choice) || (value && ['status', 'disabled', ...MODES].includes(choice))) throw new Error('Invalid dictation setting.');
      if (choice === 'status') {
        const setting = runtime.readSetting(agentDir());
        // Backend options may hold credentials; status never prints them or probes networks.
        const status = `Dictation backend: ${setting.backend ?? 'disabled'}; mode: ${setting.mode}.`;
        if (ctx.hasUI) ctx.ui.notify(status, 'info');
        else pi.sendMessage({ customType: 'pi-sound:dictate-setting-status', content: status, display: true });
        return;
      }
      if (MODES.includes(choice as DictationMode)) setMode(agentDir(), choice as DictationMode, runtime.readSetting);
      else if (choice === 'disabled') setBackend(agentDir(), null, {}, runtime.readSetting);
      else {
        const options: unknown = value ? JSON.parse(value) : {};
        runtime.backends.prepare(choice, options);
        if (typeof options !== 'object' || options === null || Array.isArray(options)) throw new Error('Backend options must be an object.');
        setBackend(agentDir(), choice, options as Record<string, unknown>, runtime.readSetting);
      }
      ctx.ui.notify('Saved dictation setting.', 'info');
    },
  });
}
export { registerSpeech };
export default function soundExtension(pi: ExtensionAPI): void {
  const runtime = createSoundRuntime();
  registerDictation(pi, { runtime });
  registerSpeech(pi, { runtime });
}
