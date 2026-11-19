/**
 * Agent sidebar, modelled on pi-deck's: every Pi shared through pimux, one
 * block per project directory, agents in creation order with workers and
 * panels under their parent and finished workers folded. The header counts
 * what needs attention; clicking it opens the next such agent. New root
 * agents (started elsewhere since Tau started, not yet shown) are marked.
 */

import { isImeComposition, moveListFocus } from './keyboard.js';
import { arrangeSpaceGroups, parseSpaceGroups, putSpaceGroup, SPACE_GROUPS_KEY, type SpaceGroup } from './space-groups.js';

export type AgentStatus = 'starting' | 'blocked' | 'working' | 'done' | 'idle';
export type OverviewAgent = {
  muxId: string;
  name: string;
  cwd: string;
  status: AgentStatus;
  isNew: boolean;
  detail: string | null;
  placement: string;
  host: string | null;
  sessionFile: string | null;
  model: string | null;
  startedAt: string;
  updatedAt: string;
  parentId: string | null;
};

export type AgentNode = { agent: OverviewAgent; children: AgentNode[] };
export type AgentGroup = { cwd: string; nodes: AgentNode[] };

const ICON: Record<AgentStatus, string> = { blocked: '◉', working: '◐', done: '●', idle: '○', starting: '·' };
const NEW_ICON = '✦';
const BADGE_KINDS = ['blocked', 'done', 'new', 'working'] as const;
type BadgeKind = typeof BADGE_KINDS[number];

function matches(agent: OverviewAgent, kind: BadgeKind) {
  return kind === 'new' ? agent.isNew : agent.status === kind;
}

function flatten(node: AgentNode): OverviewAgent[] {
  return [node.agent, ...node.children.flatMap(flatten)];
}

/** Summarize the live agents under a band, with their newest status target. */
export function spaceBadges(directories: AgentGroup[]) {
  const agents = directories.flatMap(dir => dir.nodes.flatMap(flatten)).filter(agent => agent.placement !== 'panel');
  return BADGE_KINDS.flatMap(kind => {
    const matching = agents.filter(agent => matches(agent, kind));
    const newest = matching.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) ||
      b.startedAt.localeCompare(a.startedAt) || b.muxId.localeCompare(a.muxId))[0];
    return newest ? [{ kind, count: matching.length, newest }] : [];
  });
}

/** A worker whose work is over; pi-deck folds these under their parent. */
export function finishedWorker(agent: OverviewAgent) {
  return agent.placement === 'worker' && (agent.status === 'done' || agent.status === 'idle');
}

const byCreation = (a: AgentNode, b: AgentNode) =>
  a.agent.startedAt.localeCompare(b.agent.startedAt) || a.agent.muxId.localeCompare(b.agent.muxId);

/** Groups by directory in creation order; workers nest under their parent, never reordered by status. */
export function buildAgentGroups(agents: OverviewAgent[]): AgentGroup[] {
  const nodes = new Map(agents.map(agent => [agent.muxId, { agent, children: [] as AgentNode[] }]));
  const roots: AgentNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.agent.parentId ? nodes.get(node.agent.parentId) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  const sort = (list: AgentNode[]) => { list.sort(byCreation); for (const node of list) sort(node.children); };
  sort(roots);
  const groups = new Map<string, AgentNode[]>();
  for (const root of roots) groups.set(root.agent.cwd, [...(groups.get(root.agent.cwd) ?? []), root]);
  return [...groups].map(([cwd, list]) => ({ cwd, nodes: list }));
}

/** The next blocked, else finished, else new agent after the current one, as pi-deck's next attention. */
export function nextAttention(agents: OverviewAgent[], currentMuxId: string | null): OverviewAgent | null {
  const order = buildAgentGroups(agents).flatMap(group => group.nodes.flatMap(flatten));
  for (const kind of ['blocked', 'done', 'new'] as const) {
    const candidates = order.filter(agent => matches(agent, kind));
    if (!candidates.length) continue;
    const index = candidates.findIndex(agent => agent.muxId === currentMuxId);
    return candidates[(index + 1) % candidates.length];
  }
  return null;
}

function basename(dir: string) {
  return dir.split('/').filter(Boolean).pop() || dir || '/';
}

/** Discovery files hold arbitrary text, so everything here is built as nodes, never as markup. */
function element(tag: string, className: string, text?: string) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className: string, text: string, label: string) {
  const node = element('button', className, text) as HTMLButtonElement;
  node.type = 'button';
  node.title = label;
  node.setAttribute('aria-label', label);
  return node;
}

export function setupAgentSidebar(options: {
  summary: HTMLElement;
  list: HTMLElement;
  /** Resolves once the agent is shown or refused. */
  open: (agent: OverviewAgent) => Promise<unknown>;
  newAgent: (cwd: string) => void;
  newAgentElsewhere: () => void;
  close: (agent: OverviewAgent) => void;
  currentMuxId: () => string | null;
  /** Agents being closed, or closed before discovery catches up. */
  hidden: (muxId: string) => boolean;
  reportError: (message: string) => void;
}) {
  let agents: OverviewAgent[] = [];
  let opening: string | null = null;
  let spaceGroups: SpaceGroup[] = [];
  try { spaceGroups = parseSpaceGroups(localStorage.getItem(SPACE_GROUPS_KEY)); } catch { /* Storage can be unavailable. */ }
  let spaceMenu: string | null = null;
  const foldedSpaces = new Set<string>();
  const foldedGroups = new Set<string>();
  /** Parents whose finished workers are shown. */
  const unfoldedFinished = new Set<string>();
  const listed = () => agents.filter(agent => !options.hidden(agent.muxId));
  const editor = document.createElement('dialog');
  editor.className = 'agent-space-editor';
  editor.setAttribute('aria-labelledby', 'agent-space-editor-title');
  // Keep Escape and app-wide shortcuts in the modal, not the chat behind it.
  editor.addEventListener('keydown', event => event.stopPropagation());
  document.body.append(editor);

  window.addEventListener('storage', event => {
    if (event.key !== SPACE_GROUPS_KEY && event.key !== null) return;
    spaceGroups = parseSpaceGroups(event.newValue);
    render();
  });
  document.addEventListener('click', event => {
    if (spaceMenu === null || (event.target as Element).closest('.agent-space-menu, .agent-space-menu-items')) return;
    spaceMenu = null;
    render();
  });
  options.list.addEventListener('keydown', event => {
    if (isImeComposition(event)) return;
    if (event.key === 'Escape' && spaceMenu !== null && (event.target as Element).closest('.agent-space-band')) {
      event.preventDefault();
      event.stopPropagation();
      const id = spaceMenu;
      spaceMenu = null;
      render(`space-menu:${id}`);
    } else if ((event.target as Element).classList.contains('agent-row')) {
      moveListFocus(event, Array.from(options.list.querySelectorAll<HTMLElement>('.agent-row[role="button"]:not([hidden] *)')));
    }
  });
  options.summary.addEventListener('click', () => {
    const next = nextAttention(listed(), options.currentMuxId());
    if (next) void open(next);
  });

  /** A newer choice supersedes a slow open; the view selection discards the older one's result. */
  async function open(agent: OverviewAgent) {
    opening = agent.muxId;
    render();
    try { await options.open(agent); }
    finally {
      if (opening === agent.muxId) opening = null;
      render();
    }
  }

  function row(agent: OverviewAgent, depth: number) {
    const current = agent.muxId === options.currentMuxId();
    const node = element('div', `agent-row agent-${agent.status}${agent.isNew ? ' agent-is-new' : ''}${agent.placement === 'worker' ? ' agent-worker' : ''}${current ? ' active' : ''}${opening === agent.muxId ? ' agent-opening' : ''}`);
    if (agent.placement === 'panel') {
      node.classList.add('agent-panel');
    } else {
      node.tabIndex = 0;
      node.setAttribute('role', 'button');
    }
    node.style.setProperty('--depth', String(depth));
    node.dataset.muxId = agent.muxId;
    node.dataset.focusKey = `agent:${agent.muxId}`;
    if (current) node.setAttribute('aria-current', 'true');
    const icon = element('span', 'agent-icon', ICON[agent.status] ?? '·');
    icon.setAttribute('aria-hidden', 'true');
    const text = element('span', 'agent-text');
    const status = agent.isNew ? `new · ${agent.status}` : agent.status;
    text.append(element('span', 'agent-name', agent.name), element('span', 'agent-detail', agent.detail ? `${status} · ${agent.detail}` : status));
    const close = button('agent-close', '✕', `Close ${agent.name}`);
    close.dataset.focusKey = `agent-close:${agent.muxId}`;
    close.addEventListener('click', event => { event.stopPropagation(); options.close(agent); });
    node.append(icon, text, close);
    if (agent.placement === 'panel') return node;
    node.addEventListener('click', () => { void open(agent); });
    node.addEventListener('keydown', event => {
      if (event.target === node && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); void open(agent); }
    });
    return node;
  }

  function rows(node: AgentNode, depth: number): HTMLElement[] {
    const active = node.children.filter(child => !finishedWorker(child.agent));
    const finished = node.children.filter(child => finishedWorker(child.agent));
    const result = [row(node.agent, depth), ...active.flatMap(child => rows(child, depth + 1))];
    if (!finished.length) return result;
    const shown = unfoldedFinished.has(node.agent.muxId) || finished.some(child => child.agent.muxId === options.currentMuxId());
    const toggle = button('agent-finished', `${shown ? '▾' : '▸'} ${finished.length} finished`, shown ? 'Hide finished workers' : 'Show finished workers');
    toggle.style.setProperty('--depth', String(depth + 1));
    toggle.dataset.focusKey = `finished:${node.agent.muxId}`;
    toggle.addEventListener('click', () => {
      if (shown) unfoldedFinished.delete(node.agent.muxId);
      else unfoldedFinished.add(node.agent.muxId);
      render();
    });
    return [...result, toggle, ...(shown ? finished.flatMap(child => rows(child, depth + 1)) : [])];
  }

  function groupElement(group: AgentGroup) {
    const folded = foldedGroups.has(group.cwd);
    const count = group.nodes.reduce(function total(sum: number, node: AgentNode): number { return node.children.reduce(total, sum + 1); }, 0);
    const header = element('div', 'agent-group-header');
    const fold = button('agent-group-fold', '', `${folded ? 'Show' : 'Hide'} ${group.cwd}`);
    fold.setAttribute('aria-expanded', String(!folded));
    fold.dataset.focusKey = `directory:${group.cwd}`;
    fold.append(element('span', 'agent-group-arrow', folded ? '▸' : '▾'), element('span', 'agent-group-name', basename(group.cwd)), element('span', 'agent-group-count', String(count)));
    fold.addEventListener('click', () => {
      if (folded) foldedGroups.delete(group.cwd);
      else foldedGroups.add(group.cwd);
      render();
    });
    const add = button('agent-group-add', '+', `New agent in ${group.cwd}`);
    add.dataset.focusKey = `directory-new:${group.cwd}`;
    add.addEventListener('click', () => options.newAgent(group.cwd));
    header.append(fold, add);
    const node = element('div', 'agent-group');
    node.append(header, ...(folded ? [] : group.nodes.flatMap(item => rows(item, 0))));
    return node;
  }

  function saveGroups(next: SpaceGroup[]) {
    try { localStorage.setItem(SPACE_GROUPS_KEY, JSON.stringify(next)); }
    catch { return false; }
    spaceGroups = next;
    return true;
  }

  function openEditor(mode: 'create' | 'rename' | 'members', group?: SpaceGroup) {
    spaceMenu = null;
    const form = document.createElement('form');
    const title = element('h2', '', mode === 'create' ? 'New group' : mode === 'rename' ? 'Rename group' : 'Edit group members');
    title.id = 'agent-space-editor-title';
    form.append(title);
    const name = document.createElement('input');
    name.required = true;
    name.value = group?.name ?? '';
    if (mode !== 'members') {
      const label = element('label', 'agent-space-name', 'Group name');
      label.append(name);
      form.append(label);
    }
    const selected = new Set(group?.directories);
    if (mode !== 'rename') {
      const choices = element('fieldset', 'agent-space-choices');
      choices.append(element('legend', '', 'Choose project directories'));
      const dirs = new Set([...buildAgentGroups(listed()).map(dir => dir.cwd), ...spaceGroups.flatMap(item => item.directories)]);
      for (const dir of [...dirs].filter(dir => dir.startsWith('/')).sort()) {
        const label = element('label', 'agent-space-choice');
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.checked = selected.has(dir);
        check.addEventListener('change', () => {
          if (check.checked) selected.add(dir);
          else selected.delete(dir);
          updateSubmit();
        });
        label.append(check, element('span', '', dir));
        choices.append(label);
      }
      form.append(choices);
    }
    const error = element('p', 'agent-space-error');
    error.setAttribute('role', 'alert');
    const actions = element('div', 'agent-space-editor-actions');
    const cancel = button('', 'Cancel', 'Cancel');
    const submit = button('', mode === 'create' ? 'Create group' : 'Save', mode === 'create' ? 'Create group' : 'Save');
    submit.type = 'submit';
    actions.append(cancel, submit);
    form.append(error, actions);
    const updateSubmit = () => { submit.disabled = !name.value.trim() || selected.size === 0; error.textContent = ''; };
    name.addEventListener('input', updateSubmit);
    updateSubmit();
    let returnFocus = group ? `space-menu:${group.id}` : 'space-new';
    editor.addEventListener('close', () => {
      editor.replaceChildren();
      render(returnFocus);
    }, { once: true });
    cancel.addEventListener('click', () => editor.close());
    form.addEventListener('submit', event => {
      event.preventDefault();
      const current = group && spaceGroups.find(item => item.id === group.id);
      if (group && !current) { error.textContent = 'This group no longer exists.'; return; }
      const nextName = mode === 'members' ? current!.name : name.value.trim();
      if (spaceGroups.some(item => item.id !== group?.id && item.name === nextName)) {
        error.textContent = 'A group already has that name.';
        return;
      }
      const id = group?.id ?? crypto.randomUUID();
      const directories = mode === 'rename' ? current!.directories : [...selected];
      if (!nextName || !directories.length) return;
      if (!saveGroups(putSpaceGroup(spaceGroups, { id, name: nextName, directories }))) {
        error.textContent = 'Could not save groups in this browser.';
        return;
      }
      returnFocus = `space-fold:${id}`;
      editor.close();
    });
    editor.replaceChildren(form);
    render();
    editor.showModal();
    if (mode !== 'members') name.focus();
  }

  function spaceElement(group: SpaceGroup, directories: AgentGroup[]) {
    const { id, name } = group;
    const folded = foldedSpaces.has(id);
    const node = element('div', 'agent-space-group');
    node.dataset.spaceId = id;
    const band = element('div', 'agent-space-band');
    if (directories.some(dir => dir.nodes.flatMap(flatten).some(agent => agent.muxId === options.currentMuxId()))) {
      band.classList.add('contains-active');
    }
    const fold = button('agent-space-fold', name, `${folded ? 'Show' : 'Hide'} ${name}`);
    fold.dataset.focusKey = `space-fold:${id}`;
    fold.setAttribute('aria-expanded', String(!folded));
    fold.setAttribute('aria-controls', `agent-space-members-${id}`);
    fold.addEventListener('click', () => {
      if (folded) foldedSpaces.delete(id);
      else foldedSpaces.add(id);
      render();
    });
    band.append(fold);
    for (const { kind, count, newest } of spaceBadges(directories)) {
      const icon = kind === 'new' ? NEW_ICON : ICON[kind];
      const badge = button(`agent-space-badge agent-${kind === 'new' ? 'is-new' : kind}`, `${icon}${count > 1 ? ` ${count}` : ''}`, `${name}: ${count} ${kind}`);
      badge.title += ` — Open ${newest.name}`;
      badge.dataset.status = kind;
      badge.dataset.focusKey = `space-badge:${id}:${kind}`;
      badge.addEventListener('click', () => { void open(newest); });
      band.append(badge);
    }
    const menu = button('agent-space-menu', '⋯', `Actions for ${name}`);
    menu.dataset.focusKey = `space-menu:${id}`;
    menu.setAttribute('aria-expanded', String(spaceMenu === id));
    menu.addEventListener('click', () => {
      spaceMenu = spaceMenu === id ? null : id;
      render();
    });
    band.append(menu);
    if (spaceMenu === id) {
      const actions = element('div', 'agent-space-menu-items');
      for (const [label, invoke] of [
        ['Rename', () => openEditor('rename', group)],
        ['Edit members', () => openEditor('members', group)],
        ['Dissolve', () => {
          if (!saveGroups(spaceGroups.filter(item => item.id !== id))) {
            options.reportError('Could not save groups in this browser.');
            return;
          }
          spaceMenu = null;
          foldedSpaces.delete(id);
          render(directories.length ? `directory:${directories[0].cwd}` : 'space-new');
        }],
      ] as const) {
        const action = button('', label, label);
        action.dataset.focusKey = `space-action:${id}:${label}`;
        action.addEventListener('click', invoke);
        actions.append(action);
      }
      band.append(actions);
    }
    const members = element('div', 'agent-space-members');
    members.id = `agent-space-members-${id}`;
    members.hidden = folded;
    if (!folded) members.append(...directories.map(groupElement));
    node.append(band, members);
    return node;
  }

  function renderSummary(shown: OverviewAgent[]) {
    const counts = { blocked: 0, done: 0, new: 0, working: 0 };
    for (const agent of shown) {
      if (agent.placement === 'panel') continue;
      if (agent.status === 'blocked' || agent.status === 'done' || agent.status === 'working') counts[agent.status]++;
      if (agent.isNew) counts.new++;
    }
    const parts = (['blocked', 'done', 'new', 'working'] as const).filter(kind => counts[kind])
      .map(kind => element('span', `agents-summary-part agent-${kind === 'new' ? 'is-new' : kind}`, `${kind === 'new' ? NEW_ICON : ICON[kind]} ${counts[kind]} ${kind}`));
    options.summary.replaceChildren(...(parts.length ? parts : [element('span', 'agents-summary-part', shown.length ? `${shown.length} idle` : 'No agents')]));
    const attention = counts.blocked || counts.done || counts.new;
    options.summary.title = attention ? 'Open the next agent that needs attention' : 'Nothing needs attention';
    (options.summary as HTMLButtonElement).disabled = !attention;
  }

  function render(moveFocusTo?: string) {
    const shown = listed();
    renderSummary(shown);
    const active = document.activeElement as HTMLElement | null;
    const focused = moveFocusTo ?? active?.dataset.focusKey;
    const focusedBand = active?.closest<HTMLElement>('.agent-space-group')?.dataset.spaceId;
    const newAgent = button('agent-new', '+ New agent…', 'Start an agent in another directory');
    newAgent.dataset.focusKey = 'new-agent';
    newAgent.addEventListener('click', options.newAgentElsewhere);
    const newSpace = button('agent-space-new', '+ New Group', 'New group');
    newSpace.disabled = !shown.length && !spaceGroups.length;
    newSpace.dataset.focusKey = 'space-new';
    newSpace.addEventListener('click', () => openEditor('create'));
    const actions = element('div', 'agent-space-actions');
    actions.append(newAgent, newSpace);
    const { bands, ungrouped } = arrangeSpaceGroups(spaceGroups, buildAgentGroups(shown));
    options.list.replaceChildren(...bands.map(({ group, directories }) => spaceElement(group, directories)), ...ungrouped.map(groupElement), actions);
    const focusTarget = (key: string) => options.list.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(key)}"]`);
    if (focused) (focusTarget(focused) ?? (focusedBand ? focusTarget(`space-fold:${focusedBand}`) : null) ??
      (moveFocusTo ? newSpace : null))?.focus({ preventScroll: true });
  }

  return {
    update(next: OverviewAgent[]) { agents = next || []; render(); },
    render,
    open,
    find: (muxId: string | null) => agents.find(agent => agent.muxId === muxId) ?? null,
  };
}
