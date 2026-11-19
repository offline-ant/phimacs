import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildAgentGroups, finishedWorker, nextAttention, spaceBadges } from '../public/agent-sidebar.js';
import type { AgentNode, OverviewAgent } from '../src/public/agent-sidebar.ts';

let clock = 0;
function agent(muxId: string, cwd: string, extra: Partial<OverviewAgent> = {}): OverviewAgent {
  const time = new Date(Date.UTC(2026, 10, 6, 10, 0, clock++)).toISOString();
  return { muxId, name: muxId, cwd, status: 'idle', isNew: false, detail: null, placement: 'root', host: null, sessionFile: null,
    model: null, startedAt: time, updatedAt: time, parentId: null, ...extra };
}

const names = (groups: ReturnType<typeof buildAgentGroups>) =>
  groups.map(group => [group.cwd, group.nodes.map(function flat(node: AgentNode): unknown { return node.children.length ? [node.agent.muxId, node.children.map(flat)] : node.agent.muxId; })]);

test('agents group by directory in creation order, never reordered by status, with workers under their parent', () => {
  clock = 0;
  const first = agent('first', '/p/alpha');
  const beta = agent('beta', '/p/beta', { status: 'blocked' });
  const second = agent('second', '/p/alpha', { status: 'working' });
  const worker = agent('worker', '/p/alpha', { placement: 'worker', parentId: 'first', status: 'blocked' });
  const nested = agent('nested', '/elsewhere', { placement: 'worker', parentId: 'worker' });
  // Discovery order is arbitrary; creation order decides.
  assert.deepEqual(names(buildAgentGroups([nested, worker, second, beta, first])), [
    ['/p/alpha', [['first', [['worker', ['nested']]]], 'second']],
    ['/p/beta', ['beta']],
  ]);
});

test('a worker whose parent is gone is listed in its own directory', () => {
  clock = 0;
  assert.deepEqual(names(buildAgentGroups([agent('orphan', '/p', { placement: 'worker', parentId: 'gone' })])), [['/p', ['orphan']]]);
});

test('only workers whose work is over fold away', () => {
  assert.equal(finishedWorker(agent('w', '/p', { placement: 'worker', status: 'done' })), true);
  assert.equal(finishedWorker(agent('w', '/p', { placement: 'worker', status: 'idle' })), true);
  assert.equal(finishedWorker(agent('w', '/p', { placement: 'worker', status: 'working' })), false);
  assert.equal(finishedWorker(agent('r', '/p', { status: 'done' })), false);
});

test('next attention cycles blocked agents first, then finished ones, in sidebar order', () => {
  clock = 0;
  const agents = [agent('a', '/p', { status: 'done' }), agent('b', '/p', { status: 'blocked' }), agent('c', '/q', { status: 'blocked' }), agent('d', '/p')];
  assert.equal(nextAttention(agents, null)?.muxId, 'b');
  assert.equal(nextAttention(agents, 'b')?.muxId, 'c');
  assert.equal(nextAttention(agents, 'c')?.muxId, 'b');
  assert.equal(nextAttention(agents.filter(item => item.status !== 'blocked'), 'd')?.muxId, 'a');
  assert.equal(nextAttention([agent('e', '/p')], null), null);
});

test('new agents need attention after blocked and finished ones', () => {
  clock = 0;
  const agents = [agent('n1', '/p', { isNew: true, status: 'working' }), agent('d', '/p', { status: 'done' }), agent('n2', '/q', { isNew: true })];
  assert.equal(nextAttention(agents, null)?.muxId, 'd');
  const fresh = agents.filter(item => item.status !== 'done');
  assert.equal(nextAttention(fresh, null)?.muxId, 'n1');
  assert.equal(nextAttention(fresh, 'n1')?.muxId, 'n2');
  assert.equal(nextAttention(fresh, 'n2')?.muxId, 'n1');
});

test('group badges count nested workers once and visit the latest matching status, not the newest root', () => {
  const older = agent('older', '/p', { status: 'done', updatedAt: '2026-11-07T00:00:10Z' });
  const newer = agent('newer', '/p', { status: 'done', updatedAt: '2026-11-07T00:00:00Z' });
  const worker = agent('worker', '/elsewhere', { placement: 'worker', parentId: older.muxId, status: 'blocked' });
  const fresh = agent('fresh', '/p', { isNew: true, status: 'working' });
  assert.deepEqual(spaceBadges(buildAgentGroups([newer, older, worker, fresh])).map(({ kind, count, newest }) => [kind, count, newest.muxId]), [
    ['blocked', 1, 'worker'], ['done', 2, 'older'], ['new', 1, 'fresh'], ['working', 1, 'fresh'],
  ]);
});
