import assert from 'node:assert/strict';
import test from 'node:test';
import { agentFromHash, agentHash } from '../src/public/agent-link.ts';

test('the URL names the shown agent by its exact mux id', () => {
  const id = 'mux/a+b & #';
  assert.equal(agentHash(id), `#agent=${encodeURIComponent(id)}`);
  assert.equal(agentFromHash(agentHash(id)), id);
  assert.equal(agentHash(null), '');
});

test('other or malformed fragments name no agent', () => {
  for (const hash of ['', '#', '#settings', '#session=one', '#agent=', '#agent=%', '#agent=%FF', '#agent=%00', `#agent=${'a'.repeat(257)}`]) {
    assert.equal(agentFromHash(hash), null, hash);
  }
});
