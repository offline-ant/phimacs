import { runtimeEnvironment, cwd } from './runtime-environment.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FakeRuntimeLauncher } from './runtime-launcher.ts';
import { LiveSessionManager, parseSpawnOverrides, SESSIONS_DIR, PI_COMMAND, _setCredentialsForTest } from '../bin/tau.js';
import { RUNTIME_FILE, publishBrowserUrls, unpublishBrowserUrls, buildBrowserUrls } from '../bin/orchestration.js';
import { TAU_SETTINGS } from '../bin/config.js';

before(() => {
  _setCredentialsForTest('test-user', 'synthetic-password');
  TAU_SETTINGS.hostnames = ['tau-test.invalid'];
});
after(() => fs.rmSync(runtimeEnvironment.root, { recursive: true, force: true }));

function sessionFileFixture(name: string): string {
  const directory = path.join(SESSIONS_DIR, '--synthetic--orchestration');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, name);
  fs.writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id: name, cwd }) + '\n');
  return file;
}

test('launch overrides are validated before a managed runtime is started', () => {
  assert.deepEqual(parseSpawnOverrides({}), {});
  assert.deepEqual(parseSpawnOverrides({ args: ['--model', 'fx/one'], env: { PI_NESTED: '1' } }),
    { args: ['--model', 'fx/one'], env: { PI_NESTED: '1' } });
  assert.throws(() => parseSpawnOverrides({ args: '--model' }), /args must be an array of strings/);
  assert.throws(() => parseSpawnOverrides({ args: [1] }), /args must be an array of strings/);
  assert.throws(() => parseSpawnOverrides({ env: ['PI_NESTED=1'] }), /env must be an object of string values/);
  assert.throws(() => parseSpawnOverrides({ env: { PI_NESTED: 1 } }), /env.PI_NESTED must be a string/);
  assert.throws(() => parseSpawnOverrides({ env: { 'BAD NAME': 'x' } }), /Invalid environment variable name/);
  assert.throws(() => parseSpawnOverrides({ sessionFile: '/etc/passwd' }), /Invalid session file/);
  const file = sessionFileFixture('overrides.jsonl');
  assert.deepEqual(parseSpawnOverrides({ sessionFile: file }), { sessionFile: file });
});

test('a created shared runtime receives the caller arguments, environment, exact file and runtime host', async t => {
  const launcher = new FakeRuntimeLauncher();
  const manager = new LiveSessionManager({ start: launcher.start });
  t.after(async () => { await manager.shutdown(); await launcher.close(); });
  const socket = path.join(runtimeEnvironment.root, 'emacs.sock');
  process.env.PHIMACS_SERVER_SOCKET = socket;
  process.env.TAU_PASS = 'synthetic-frontend-only';
  process.env.TAU_COOKIE_SECRET = 'synthetic-cookie-secret';
  t.after(() => {
    delete process.env.PHIMACS_SERVER_SOCKET;
    delete process.env.TAU_PASS;
    delete process.env.TAU_COOKIE_SECRET;
  });
  const file = sessionFileFixture('created.jsonl');
  const session = await manager.create({ cwd, sessionFile: file, model: undefined,
    args: ['--provider', 'fx', '--model', 'one'], env: { FX_SETTING: 'on' } });
  assert.equal(launcher.calls.length, 1);
  const call = launcher.calls[0];
  assert.equal(call.command, PI_COMMAND);
  assert.equal(path.isAbsolute(call.command), true);
  assert.deepEqual(call.args.slice(0, 2), ['--mode', 'rpc']);
  assert.deepEqual(call.args.slice(-6), ['--session', file, '--provider', 'fx', '--model', 'one']);
  assert.equal(call.env?.FX_SETTING, 'on');
  assert.equal(call.env?.PI_ORCHESTRATION_HOST, 'emacs');
  assert.equal(call.env?.PI_ORCHESTRATION_ENDPOINT, socket);
  assert.equal(call.env?.PI_ORCHESTRATION_TARGET, session.id);
  assert.equal(call.env?.TAU_PASS, undefined);
  assert.equal(call.env?.TAU_COOKIE_SECRET, undefined);
  assert.equal(call.parent, undefined);
  assert.equal(session.transport?.kind, 'pimux');
  assert.equal(session.attachment?.ready, true);
});

test('Tau requests roots only; its client cannot supply a worker or a host identity', async () => {
  const launcher = new FakeRuntimeLauncher();
  const manager = new LiveSessionManager({ start: launcher.start });
  for (const key of ['PHIMACS_PARENT_TASK', 'PI_ORCHESTRATION_PLACEMENT', 'PI_ORCHESTRATION_HOST', 'PHIMACS_SERVER_SOCKET']) {
    await assert.rejects(manager.create({ cwd, sessionFile: undefined, model: undefined, args: undefined, env: { [key]: 'foreign' } }), new RegExp(`A Tau root cannot override ${key}`));
  }
  assert.equal(launcher.calls.length, 0);
});

test('browser URLs are HTTPS origins for the bound address/family without credentials or scoped IPv6', () => {
  const entry = (address: string, internal = false): os.NetworkInterfaceInfo => ({
    address, internal, family: address.includes(':') ? 'IPv6' : 'IPv4',
    netmask: '', mac: '', cidr: null, ...(address.includes(':') ? { scopeid: 0 } : {}),
  } as os.NetworkInterfaceInfo);
  const interfaces = {
    lo: [entry('127.0.0.1', true), entry('::1', true)],
    eth0: [entry('192.0.2.1'), entry('2001:db8::1'), entry('fe80::1'), entry('fe80::2%eth0')],
    wg0: [entry('192.0.2.2')], duplicate: [entry('192.0.2.2')],
  };
  assert.deepEqual(buildBrowserUrls(3443, '0.0.0.0', ['tau-test.invalid'], interfaces), [
    'https://tau-test.invalid:3443', 'https://192.0.2.1:3443', 'https://192.0.2.2:3443', 'https://127.0.0.1:3443',
  ]);
  assert.deepEqual(buildBrowserUrls(3443, '::', [], interfaces), ['https://[2001:db8::1]:3443', 'https://[::1]:3443']);
  assert.deepEqual(buildBrowserUrls(3443, '127.0.0.1', ['tau-test.invalid'], interfaces), ['https://127.0.0.1:3443']);
  assert.deepEqual(buildBrowserUrls(3443, '192.0.2.2', [], interfaces), ['https://192.0.2.2:3443']);
  assert.deepEqual(buildBrowserUrls(3443, '::1', [], interfaces), ['https://[::1]:3443']);
  assert.deepEqual(buildBrowserUrls(3443, '2001:db8::1', [], interfaces), ['https://[2001:db8::1]:3443']);
  assert.deepEqual(buildBrowserUrls(3443, 'fe80::1%eth0', [], interfaces), []);
  assert.deepEqual(buildBrowserUrls(3443, 'localhost', [], interfaces), []);
});

test('discovery advertises only browser origins, not API credentials', t => {
  publishBrowserUrls(4443, '::1');
  t.after(unpublishBrowserUrls);
  const published = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'));
  assert.deepEqual(Object.keys(published).sort(), ['browserUrls', 'pid', 'startedAt']);
  assert.equal(published.pid, process.pid);
  assert.deepEqual(published.browserUrls, ['https://[::1]:4443']);
  assert.equal(fs.statSync(RUNTIME_FILE).mode & 0o777, 0o600);
});

test('only the owning server removes its browser URLs; a stale record can be replaced', t => {
  publishBrowserUrls(3443, '0.0.0.0');
  t.after(unpublishBrowserUrls);
  const published = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'));
  assert.deepEqual(published.browserUrls, buildBrowserUrls(3443, '0.0.0.0'));
  assert.equal(published.browserUrls[0], 'https://tau-test.invalid:3443');
  fs.writeFileSync(RUNTIME_FILE, JSON.stringify({ ...published, pid: process.ppid }));
  publishBrowserUrls(3444);
  unpublishBrowserUrls();
  assert.equal(JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8')).pid, process.ppid);
  fs.writeFileSync(RUNTIME_FILE, JSON.stringify({ ...published, pid: 0x7fffffff }));
  publishBrowserUrls(3445, '127.0.0.1');
  assert.deepEqual(JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8')).browserUrls, ['https://127.0.0.1:3445']);
  unpublishBrowserUrls();
  assert.equal(fs.existsSync(RUNTIME_FILE), false);
});
