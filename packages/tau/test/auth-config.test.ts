import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createClaimTestEnvironment } from '@phimacs/pimux/ownership';
import type { TauSettingsFile } from '../src/server/types.ts';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const VALIDATE = `
import { TAU_SETTINGS, AUTH_CONFIGURED, requireTauCredentials } from './bin/config.js';
if (TAU_SETTINGS.authEnabled) requireTauCredentials(TAU_SETTINGS);
console.log(JSON.stringify({ configured: AUTH_CONFIGURED, enabled: TAU_SETTINGS.authEnabled }));`;
const PROBE_LOCAL = `
import assert from 'node:assert/strict';
import { listen, server } from './bin/tau.js';
await listen();
assert.equal(server.address().address, '127.0.0.1');
const response = await fetch(\`http://127.0.0.1:\${server.address().port}/api/live-sessions\`);
assert.equal(response.status, 200);
process.exit(0);`;
const PROBE_AUTH_LOCK = `
import assert from 'node:assert/strict';
import { handleRpcCommand } from './bin/tau.js';
const auth = () => handleRpcCommand({ type: 'get_auth' });
assert.equal((await auth()).data.enabled, true);
assert.equal((await handleRpcCommand({ type: 'set_auth' })).success, false);
assert.equal((await handleRpcCommand({ type: 'set_auth', enabled: false })).success, false);
assert.equal((await auth()).data.enabled, true);`;

function run(settings?: TauSettingsFile['tau'] | 'malformed', overrides: Record<string, string> = {}, entry: 'config' | 'cli' | 'probe' | 'auth-lock' = 'config') {
  const runtime = createClaimTestEnvironment();
  const agentDir = path.join(runtime.root, 'agent');
  const env: NodeJS.ProcessEnv = {
    ...runtime.env, HOME: runtime.root, PATH: process.env.PATH,
    PHIMACS_PI: fileURLToPath(new URL('./cli.js', import.meta.resolve('@earendil-works/pi-coding-agent'))),
    PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: runtime.sessions,
    TAU_PORT: '0', TAU_HTTP_PORT: '0', ...overrides,
  };
  try {
    if (settings !== undefined) {
      fs.mkdirSync(agentDir);
      fs.writeFileSync(path.join(agentDir, 'settings.json'), settings === 'malformed' ? '{' : JSON.stringify({ tau: settings }));
    }
    const args = entry === 'cli' ? ['bin/tau.js'] : ['--input-type=module', '-'];
    const result = spawnSync(process.execPath, args, {
      cwd: PROJECT_ROOT, env, input: entry === 'probe' ? PROBE_LOCAL : entry === 'auth-lock' ? PROBE_AUTH_LOCK : VALIDATE, encoding: 'utf8', timeout: 10_000,
    });
    return {
      ...result,
      tlsCreated: fs.existsSync(path.join(agentDir, 'tau', 'tls')),
      endpointPublished: fs.existsSync(path.join(agentDir, 'tau', 'server.json')),
    };
  } finally {
    fs.rmSync(runtime.root, { recursive: true, force: true });
  }
}

const credentials = { user: 'test-user', pass: 'test-secret' };

for (const [name, settings, env] of [
  ['missing password', { user: 'test-user' }, {}],
  ['missing username', { pass: 'test-secret' }, {}],
  ['empty explicit credentials', { user: '', pass: '' }, {}],
  ['empty environment overrides valid settings', credentials, { TAU_PASS: '' }],
  ['explicit enabled mode', { authEnabled: true }, {}],
  ['non-loopback bind without credentials', undefined, { TAU_HOST: '0.0.0.0' }],
  ['forced authentication with no credentials', { authEnabled: false }, { TAU_AUTH_ENABLED: 'true' }],
] satisfies Array<[string, TauSettingsFile['tau'], Record<string, string>]>) {
  test(`${name}: CLI refuses to listen without a username and password`, () => {
    const result = run(settings, env, 'cli');
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /TAU_USER and TAU_PASS/);
    assert.equal(result.stderr.includes('test-secret'), false);
    assert.equal(result.tlsCreated, false);
    assert.equal(result.endpointPublished, false);
  });
}

test('default startup needs no password and publishes a loopback endpoint', () => {
  const result = run(undefined, {}, 'probe');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Server running on https:\/\/127\.0\.0\.1:/);
  assert.equal(result.tlsCreated, true);
  assert.equal(result.endpointPublished, true);
});

test('explicit settings credentials enable authentication on loopback by default', () => {
  const result = run(credentials);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { configured: true, enabled: true });
});

test('TAU_AUTH_ENABLED=true and environment credentials override explicit auth-off settings', () => {
  const result = run({ user: '', pass: '', authEnabled: false }, {
    TAU_AUTH_ENABLED: 'true', TAU_HOST: '0.0.0.0', TAU_USER: credentials.user, TAU_PASS: credentials.pass,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { configured: true, enabled: true });
});

test('explicit auth-off mode still works with loopback and configured credentials', () => {
  const result = run({ ...credentials, authEnabled: false }, { TAU_HOST: 'localhost' }, 'probe');
  assert.equal(result.status, 0, result.stderr);
});

for (const [settings, env] of [
  [{ ...credentials, authEnabled: false }, { TAU_HOST: '0.0.0.0' }],
  [credentials, { TAU_AUTH_ENABLED: 'false', TAU_HOST: '::' }],
] satisfies Array<[TauSettingsFile['tau'], Record<string, string>]>) {
  test(`auth-off startup on ${env.TAU_HOST} is refused before TLS provisioning`, () => {
    const result = run(settings, env, 'cli');
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Authentication is required outside loopback/);
    assert.equal(result.tlsCreated, false);
    assert.equal(result.endpointPublished, false);
  });
}

test('the authentication command cannot downgrade a network bind or an environment-locked loopback bind', () => {
  const variants: Array<Record<string, string>> = [{ TAU_HOST: '0.0.0.0' }, { TAU_AUTH_ENABLED: 'true' }];
  for (const env of variants) {
    const result = run(credentials, env, 'auth-lock');
    assert.equal(result.status, 0, result.stderr);
  }
});

test('the CLI refuses either occupied fixed port without publishing discovery', async t => {
  const reservation = createServer().listen(0, '127.0.0.1');
  t.after(() => reservation.close());
  await once(reservation, 'listening');
  const address = reservation.address();
  assert.ok(address && typeof address !== 'string');
  for (const name of ['TAU_PORT', 'TAU_HTTP_PORT']) {
    const result = run(undefined, { [name]: String(address.port) }, 'cli');
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /EADDRINUSE/);
    assert.equal(result.endpointPublished, false);
    assert.doesNotMatch(result.stdout, /Server running|trying/);
  }
});

test('malformed settings and invalid overrides fail closed', () => {
  for (const result of [run('malformed', {}, 'cli'), run(credentials, { TAU_AUTH_ENABLED: 'typo' }, 'cli')]) {
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.tlsCreated, false);
    assert.equal(result.endpointPublished, false);
  }
});
