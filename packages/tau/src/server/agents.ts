/*
 * Agent overview: every pimux-shared Pi on this machine, from pimux's live
 * discovery watch, so browsers see status changes as they happen.
 *
 * Discovery status is `starting`, `blocked`, `working` or `idle`. The
 * overview adds `done`, as pi-deck does: an agent that finished work (working
 * or blocked, then idle) while no browser showed it is done until a browser
 * shows it or it works again. A shown agent is never done.
 *
 * A root agent is also new until a browser shows it, when its conversation
 * was not running at the first snapshot (an agent some other program started
 * since Tau started). A conversation stays known, so a pimux service restart,
 * which reopens it under a new mux id, does not make it new again.
 */

import { registeredEmacsPanels } from '@phimacs/orchestration/panel-owner';
import { watchDiscovery } from '@phimacs/pimux/discovery';
import { sameProcessIdentity } from '@phimacs/pimux/process-identity';
import { pimuxDirectory, pimuxDisplayName, type PimuxEntry, type PimuxRef } from './pimux.js';

export type AgentStatus = 'starting' | 'blocked' | 'working' | 'done' | 'idle';
export type Agent = {
  muxId: string;
  name: string;
  cwd: string;
  status: AgentStatus;
  /** A root agent no browser has shown since it appeared after Tau started. */
  isNew: boolean;
  detail: string | null;
  placement: PimuxEntry['placement'] | 'panel';
  host: string | null;
  sessionFile: string | null;
  model: string | null;
  /** When pimux started it: the sidebar lists agents in creation order. */
  startedAt: string;
  updatedAt: string;
  /** Mux id of the agent this one is nested under (a worker's parent), or null. */
  parentId: string | null;
};

const targetKey = ({ host, endpoint, id }: PimuxRef) => JSON.stringify([host, endpoint, id]);

function parentsByTarget(entries: PimuxEntry[]): Map<string, string | null> {
  const targets = new Map<string, string | null>();
  for (const entry of entries) {
    if (!entry.orchestration) continue;
    const key = targetKey(entry.orchestration);
    // If two runtimes claim the same host target, do not guess which owns the child.
    targets.set(key, targets.has(key) ? null : entry.muxId);
  }
  return targets;
}

function detail(entry: PimuxEntry): string | null {
  if (entry.blocked?.reason === 'worker-waiting') return 'waiting for you';
  if (entry.blocked?.reason === 'dialog') return entry.blocked.title || `asks (${entry.blocked.method || 'dialog'})`;
  return entry.model ? `${entry.model.provider}/${entry.model.id}` : null;
}

export class AgentOverview {
  private readonly dir: string;
  private readonly viewed: () => Set<string>;
  private readonly onChange: (agents: Agent[]) => void;
  private watch: { close(): void } | null = null;
  private panelWatch: ReturnType<typeof setInterval> | undefined;
  private entries: PimuxEntry[] = [];
  private agents: Agent[] = [];
  private signature = '';
  /** Last discovery status and done flag per mux id. */
  private memory = new Map<string, { status: string; done: boolean }>();
  /** Mux ids and session files running at the first snapshot or shown since; null before it. */
  private known: Set<string> | null = null;

  /** `viewed` returns the mux ids some browser shows. */
  constructor(options: { dir?: string; viewed: () => Set<string>; onChange: (agents: Agent[]) => void }) {
    this.dir = options.dir ?? pimuxDirectory();
    this.viewed = options.viewed;
    this.onChange = options.onChange;
  }

  /** Follows pimux's discovery watch; the delays exist for tests. */
  start(delays: { debounceMs?: number; backstopMs?: number } = {}) {
    this.watch = watchDiscovery(this.dir, (entries) => {
      this.known ??= new Set(entries.flatMap((entry) => [entry.muxId, ...entry.session?.file ? [entry.session.file] : []]));
      this.entries = entries;
      this.refresh();
    }, {
      ...delays,
      // An unreadable discovery directory ends Tau, as its first read does: the service restarts it.
      onError: (error) => { throw error; },
    });
    // Panel status is written independently of pimux discovery.
    this.panelWatch = setInterval(() => this.refresh(), 1000).unref();
  }

  stop() {
    this.watch?.close();
    this.watch = null;
    clearInterval(this.panelWatch);
  }

  list() { return this.agents; }

  /** Recomputes from the last snapshot, for example after browsers show other agents. */
  refresh() {
    const entries = this.entries;
    const live = new Set(entries.map((entry) => entry.muxId));
    for (const id of this.memory.keys()) if (!live.has(id)) this.memory.delete(id);
    const viewed = this.viewed();
    const known = this.known ?? new Set<string>();
    for (const entry of entries) {
      const file = entry.session?.file;
      // A starting agent's file becomes known with it; a shown or reopened conversation is known.
      if (viewed.has(entry.muxId) || known.has(entry.muxId) || (file && known.has(file))) {
        known.add(entry.muxId);
        if (file) known.add(file);
      }
    }
    const parents = parentsByTarget(entries);
    this.agents = entries.map((entry) => {
      const before = this.memory.get(entry.muxId);
      // A shown agent's finish is seen; showing it clears an earlier one.
      const finished = entry.status === 'idle' && (before?.status === 'working' || before?.status === 'blocked');
      const done = !viewed.has(entry.muxId) && entry.status === 'idle' && (finished || !!before?.done);
      this.memory.set(entry.muxId, { status: entry.status, done });
      const parent = entry.parent ? parents.get(targetKey(entry.parent)) : null;
      return {
        muxId: entry.muxId, name: pimuxDisplayName(entry), cwd: entry.cwd,
        status: done ? 'done' : entry.status, isNew: entry.placement === 'root' && !known.has(entry.muxId),
        detail: detail(entry), placement: entry.placement,
        host: entry.orchestration?.host ?? null, sessionFile: entry.session?.file ?? null,
        model: entry.model ? `${entry.model.provider}/${entry.model.id}` : null, startedAt: entry.startedAt, updatedAt: entry.updatedAt,
        parentId: parent === entry.muxId ? null : parent ?? null,
      };
    });
    if (entries.length) {
      for (const panel of registeredEmacsPanels()) {
        const parent = entries.find(entry => entry.piIdentity && sameProcessIdentity(entry.piIdentity, panel.creator));
        if (!parent) continue;
        // A native panel has no Pi session or mux socket of its own.
        this.agents.push({ muxId: `panel:${panel.id}`, name: panel.name, cwd: parent.cwd,
          status: panel.status, isNew: false, detail: panel.error || 'Panel', placement: 'panel', host: 'emacs',
          sessionFile: null, model: null, startedAt: parent.startedAt, updatedAt: parent.updatedAt, parentId: parent.muxId });
      }
    }
    const signature = JSON.stringify(this.agents.map(({ updatedAt: _updatedAt, ...agent }) => agent));
    if (signature === this.signature) return;
    this.signature = signature;
    this.onChange(this.agents);
  }
}
