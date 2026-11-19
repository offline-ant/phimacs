/**
 * History: saved sessions no pimux agent is running, at the foot of the
 * sidebar. Projects start collapsed and load their sessions on demand, so the
 * page costs one directory listing rather than a parse of every transcript.
 * Opening a session resumes it as an agent.
 */

import { limitSessions } from './session-limit.js';

export type SidebarSession = {
  filePath: string;
  file: string;
  dir: string;
  id?: string;
  name?: string | null;
  firstMessage?: string | null;
  timestamp?: string;
  mtime?: number;
  live?: boolean;
  owner?: unknown;
  /** Mux id while a pimux agent runs it: the agent list shows it instead. */
  shared?: string | null;
};

type Project = { path: string; dirName: string; count: number; lastActive: number };

const titleOf = (session: SidebarSession) => session.name || session.firstMessage || 'Empty session';

function element(tag: string, className: string, text?: string) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function formatTime(isoTimestamp?: string) {
  const date = new Date(isoTimestamp || '');
  if (Number.isNaN(date.getTime())) return '';
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.floor(diffMs / 60000), hours = Math.floor(diffMs / 3600000), days = Math.floor(diffMs / 86400000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days === 1) return 'Yesterday';
  if (days < 7) return date.toLocaleDateString([], { weekday: 'long' });
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export class SessionHistory {
  private projects: Project[] = [];
  private sessions = new Map<string, SidebarSession[]>();
  private errors = new Map<string, string>();
  private loading = new Set<string>();
  private expanded = new Set<string>();
  private showAll = new Set<string>();
  private open = localStorage.getItem('tau-history') === 'open';
  private query = '';
  private projectsError: string | null = null;
  private generation = 0;
  private readonly body: HTMLElement;
  private readonly list: HTMLElement;
  private readonly toggle: HTMLButtonElement;

  constructor(container: HTMLElement, private readonly onSelect: (session: SidebarSession) => void) {
    this.toggle = element('button', 'history-toggle') as HTMLButtonElement;
    this.toggle.type = 'button';
    this.toggle.addEventListener('click', () => this.setOpen(!this.open));
    const filter = element('input', 'history-filter') as HTMLInputElement;
    filter.type = 'search';
    filter.placeholder = 'Filter titles…';
    filter.setAttribute('aria-label', 'Filter saved sessions by title');
    filter.autocomplete = 'off';
    filter.addEventListener('input', () => this.setQuery(filter.value));
    this.list = element('div', 'history-list');
    this.body = element('div', 'history-body');
    this.body.append(filter, this.list);
    container.replaceChildren(this.toggle, this.body);
    this.render();
    if (this.open) void this.refresh();
  }

  private setOpen(open: boolean) {
    this.open = open;
    localStorage.setItem('tau-history', open ? 'open' : 'closed');
    this.render();
    if (open) void this.refresh();
  }

  private setQuery(query: string) {
    this.query = query.toLowerCase().trim();
    // Filtering needs every project's titles; ordinary browsing stays lazy.
    if (this.query) for (const project of this.projects) void this.loadSessions(project.dirName);
    this.render();
  }

  /** Rereads the project list and every list already shown; a closed History reads nothing. */
  async refresh() {
    if (!this.open) return;
    const generation = ++this.generation;
    try {
      const res = await fetch('/api/sessions');
      const data = await res.json();
      if (generation !== this.generation) return;
      if (!res.ok || !Array.isArray(data.projects)) throw new Error('Could not load projects.');
      this.projects = data.projects;
      this.projectsError = null;
      const dirs = new Set(this.projects.map(project => project.dirName));
      for (const dir of this.sessions.keys()) if (!dirs.has(dir)) this.sessions.delete(dir);
      this.render();
      await Promise.all(this.projects.filter(project => this.query || this.expanded.has(project.dirName))
        .map(project => this.loadSessions(project.dirName, true)));
    } catch {
      if (generation !== this.generation) return;
      this.projectsError = 'Could not load projects.';
      this.render();
    }
  }

  private async loadSessions(dirName: string, reload = false) {
    if (this.loading.has(dirName) || (!reload && this.sessions.has(dirName))) return;
    const generation = this.generation;
    this.loading.add(dirName);
    this.errors.delete(dirName);
    this.render();
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(dirName)}`);
      const data = await res.json();
      if (generation !== this.generation) return;
      if (!res.ok || !Array.isArray(data.sessions)) throw new Error('Could not load sessions.');
      this.sessions.set(dirName, data.sessions);
    } catch {
      if (generation === this.generation) this.errors.set(dirName, 'Could not load sessions.');
    } finally {
      this.loading.delete(dirName);
      if (generation === this.generation) this.render();
    }
  }

  /** Sessions an agent runs are in the agent list, not here. */
  private saved(dirName: string) {
    const sessions = (this.sessions.get(dirName) ?? []).filter(session => !session.shared && !session.live);
    return this.query ? sessions.filter(session => titleOf(session).toLowerCase().includes(this.query)) : sessions;
  }

  private retry(message: string, retry: () => void) {
    const status = element('div', 'history-status', `${message} `);
    status.setAttribute('role', 'status');
    const button = element('button', 'history-retry', 'Retry') as HTMLButtonElement;
    button.type = 'button';
    button.addEventListener('click', retry);
    status.append(button);
    return status;
  }

  private sessionRow(session: SidebarSession) {
    const row = element('button', 'history-session') as HTMLButtonElement;
    row.type = 'button';
    row.dataset.filePath = session.filePath;
    const title = element('span', 'history-session-title', titleOf(session));
    title.title = titleOf(session);
    row.append(title, element('span', 'history-session-time', formatTime(session.timestamp)));
    row.addEventListener('click', () => this.onSelect(session));
    return row;
  }

  private projectGroup(project: Project) {
    const expanded = this.expanded.has(project.dirName) || !!this.query;
    const sessions = this.saved(project.dirName);
    const loaded = this.sessions.has(project.dirName);
    if (this.query && loaded && !sessions.length) return null;
    const header = element('button', 'history-project') as HTMLButtonElement;
    header.type = 'button';
    header.title = project.path;
    header.setAttribute('aria-expanded', String(expanded));
    header.append(element('span', 'history-arrow', expanded ? '▾' : '▸'),
      element('span', 'history-project-name', project.path.split('/').filter(Boolean).pop() || project.path || project.dirName));
    header.addEventListener('click', () => {
      if (this.expanded.has(project.dirName)) this.expanded.delete(project.dirName);
      else { this.expanded.add(project.dirName); void this.loadSessions(project.dirName); }
      this.render();
    });
    const group = element('div', 'history-group');
    group.append(header);
    if (!expanded) return group;
    const { visible, limited } = limitSessions({ sessions, expanded: this.showAll.has(project.dirName) || !!this.query });
    group.append(...visible.map(session => this.sessionRow(session)));
    if (limited && !this.query) {
      const all = this.showAll.has(project.dirName);
      const more = element('button', 'history-more', all ? 'Show fewer' : `Show all ${sessions.length}`) as HTMLButtonElement;
      more.type = 'button';
      more.addEventListener('click', () => {
        if (all) this.showAll.delete(project.dirName);
        else this.showAll.add(project.dirName);
        this.render();
      });
      group.append(more);
    }
    const error = this.errors.get(project.dirName);
    if (error) group.append(this.retry(error, () => void this.loadSessions(project.dirName, true)));
    else if (this.loading.has(project.dirName) && !loaded) group.append(element('div', 'history-status', 'Loading…'));
    else if (loaded && !sessions.length) group.append(element('div', 'history-status', 'No saved sessions'));
    return group;
  }

  render() {
    this.toggle.replaceChildren(element('span', 'history-arrow', this.open ? '▾' : '▸'), element('span', '', 'History'));
    this.toggle.setAttribute('aria-expanded', String(this.open));
    this.body.hidden = !this.open;
    if (!this.open) return;
    const groups = this.projects.map(project => this.projectGroup(project)).filter((group): group is HTMLElement => !!group);
    const status = this.projectsError ? [this.retry(this.projectsError, () => void this.refresh())]
      : !groups.length ? [element('div', 'history-status', this.query ? 'No matching sessions' : 'No saved sessions')] : [];
    this.list.replaceChildren(...status, ...groups);
  }
}
