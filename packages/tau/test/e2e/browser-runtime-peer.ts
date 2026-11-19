import { launcher } from './fake-browser-runtime.ts';
import type { FakePimux } from '../fake-pimux.ts';
import { until } from '../fake-pimux.ts';
import type { JsonRecord } from '../../src/server/types.ts';

/** A socket-side Pi stand-in with authoritative state and dialog closure. */
export class BrowserRuntimePeer {
  readonly mux: FakePimux;
  private readonly dialogs = new Map<string, JsonRecord>();

  constructor(mux: FakePimux) {
    this.mux = mux;
    mux.withheld.add('prompt');
    mux.withheld.add('abort');
    const write = mux.write.bind(mux);
    mux.write = (socket, record) => {
      if (record.type === 'response' && record.command === 'get_state') record = { ...record, data: {
        sessionFile: (mux.entry.session as JsonRecord).file, isStreaming: !mux.idle, isCompacting: false, thinkingLevel: 'off',
      } };
      write(socket, record);
      if (record.type === 'response' && record.command === 'extension_ui_response' && this.dialogs.delete(String(record.id))) {
        mux.replay = [...this.dialogs.values()];
        mux.broadcast({ type: 'pimux_dialog_closed', id: record.id, reason: 'answered' });
      }
    };
  }

  get commands() { return this.mux.commands; }

  emit = (event: JsonRecord) => {
    if (event.type === 'agent_start') this.mux.idle = false;
    if (event.type === 'agent_settled' || event.type === 'response' && event.command === 'abort' && event.success === true) this.mux.idle = true;
    if (event.type === 'response' && event.command === 'get_state' && typeof (event.data as JsonRecord | undefined)?.isStreaming === 'boolean') {
      this.mux.idle = !(event.data as JsonRecord).isStreaming;
    }
    if (event.type === 'extension_ui_request' && ['confirm', 'select', 'input', 'editor'].includes(String(event.method))) {
      this.dialogs.set(String(event.id), event);
      this.mux.replay = [...this.dialogs.values()];
    }
    this.mux.broadcast(event);
  };

  /** Another frontend answered, or Pi stopped waiting: pimux closes the dialog for every client. */
  closeDialog = (id: string, reason = 'answered') => {
    this.dialogs.delete(id);
    this.mux.replay = [...this.dialogs.values()];
    this.mux.broadcast({ type: 'pimux_dialog_closed', id, reason });
  };

  nextCommand = (type: string) => {
    const start = this.commands.length;
    return until(() => this.commands.slice(start).find(command => command.type === type), `No ${type} command reached the runtime`);
  };
}

export function installBrowserRuntimePeers() {
  const peers: BrowserRuntimePeer[] = [];
  launcher.configure = mux => { peers.push(new BrowserRuntimePeer(mux)); };
  return peers;
}
