import { test } from 'node:test';
import assert from 'node:assert/strict';

const { limitSessions, SESSION_LIMIT } = (await import('../public/session-limit.js')) as any;

const make = (n: number) => Array.from({ length: n }, (_, i) => ({ filePath: `/s/${i}.jsonl` }));

test('the limit is 10', () => {
  assert.equal(SESSION_LIMIT, 10);
});

test('a project with 10 or fewer sessions shows all of them and is not limited', () => {
  for (const n of [0, 3, 10]) {
    const result = limitSessions({ sessions: make(n), expanded: false });
    assert.equal(result.visible.length, n);
    assert.equal(result.hiddenCount, 0);
    assert.equal(result.limited, false);
  }
});

test('a project with more than 10 sessions shows the 10 newest', () => {
  const sessions = make(23);
  const result = limitSessions({ sessions, expanded: false });
  assert.deepEqual(result.visible, sessions.slice(0, 10));
  assert.equal(result.hiddenCount, 13);
  assert.equal(result.limited, true);
});

test('an expanded project shows every session', () => {
  const sessions = make(23);
  const result = limitSessions({ sessions, expanded: true });
  assert.deepEqual(result.visible, sessions);
  assert.equal(result.hiddenCount, 0);
  assert.equal(result.limited, true);
});
