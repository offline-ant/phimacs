import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolveHost } from '@phimacs/pimux/host-identity';
import { acquireClaim, createClaimTestEnvironment, releaseClaim } from '@phimacs/pimux/ownership';
import { readProcessIdentity } from '@phimacs/pimux/process-identity';
import { hostVersionWarning } from '../scripts/pi-packages.mjs';
import { runtimePaths, runtimeEnvironment, sourceRoot } from '../scripts/runtime.mjs';
import { updatePi } from '../scripts/update-pi.mjs';

test('checkout launch resolves the global or overriding host and administrative commands allocate no runtime', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phimacs-source-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = runtimePaths();
  assert.deepEqual({ executable: runtime.pi, version: runtime.version }, resolveHost(process.env));
  assert.equal(runtime.root, sourceRoot);
  const env = runtimeEnvironment(runtime, { PATH: process.env.PATH, HOME: root, PHIMACS_PI: runtime.pi,
    PI_CODING_AGENT_DIR: path.join(root, 'agent'), PIMUX_DIR: path.join(root, 'mux') });
  const result = spawnSync(path.join(sourceRoot, 'bin/phimacs'), ['pi', '--version'], {
    env, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), runtime.version);
  assert.equal(fs.existsSync(env.PIMUX_DIR), false);
  assert.equal(fs.existsSync(env.PI_CODING_AGENT_DIR), false);
});

test('phimacs pi runs Pi under the managed writer claim and starts no service', { timeout: 20_000 }, t => {
  const namespace = createClaimTestEnvironment();
  t.after(() => fs.rmSync(namespace.root, { recursive: true, force: true }));
  const home = path.join(namespace.root, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  const session = path.join(namespace.sessions, 'session.jsonl');
  fs.writeFileSync(session, `${JSON.stringify({ type: 'session', version: 3, id: randomUUID(),
    timestamp: new Date().toISOString(), cwd: namespace.root })}\n`, { mode: 0o600 });
  const env = { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', TMPDIR: namespace.root, ...namespace.env,
    PHIMACS_PI: runtimePaths().pi, PHIMACS_STATE_DIR: path.join(namespace.root, 'state'),
    PI_CODING_AGENT_DIR: path.join(namespace.root, 'agent') };
  const exportSession = output => spawnSync(path.join(sourceRoot, 'bin/phimacs'), ['pi', '--export', session, output],
    { cwd: namespace.root, env, encoding: 'utf8', timeout: 15_000 });
  // Another writer's claim on the conversation shows that `phimacs pi` takes the claim itself.
  const held = acquireClaim(session, { id: 'other-writer', kind: 'tui', wrapper: readProcessIdentity(process.pid), pi: null },
    namespace.options);
  const refused = exportSession(path.join(namespace.root, 'refused.html'));
  releaseClaim(held);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Session is owned by tui other-writer/);
  const output = path.join(namespace.root, 'export.html');
  const exported = exportSession(output);
  assert.equal(exported.status, 0, exported.stderr);
  assert.ok(fs.statSync(output).size > 0);
  assert.equal(fs.existsSync(path.join(namespace.root, 'refused.html')), false);
  // Neither the service's state and journal nor its runtime directory was created.
  assert.equal(fs.existsSync(env.PHIMACS_STATE_DIR), false);
  assert.equal(fs.existsSync(env.PIMUX_DIR), false);
});

test('only a major.minor difference between the global host and the checkout SDK warns', () => {
  assert.equal(hostVersionWarning({ version: '1.5.2', library: '1.5.0' }), undefined);
  assert.match(hostVersionWarning({ version: '1.6.0', library: '1.5.0' }), /Global Pi 1\.6\.0 differs from the checkout's SDK 1\.5\.0/);
});

test('Pi updater changes root host requirements together without changing unrelated dependencies', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phimacs-pins-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = { dependencies: { '@earendil-works/pi-coding-agent': '1.0.0', ws: '8.22.1' },
    devDependencies: Object.fromEntries(['ai', 'agent-core', 'tui'].map(name => ['@earendil-works/pi-' + name, '1.0.0'])) };
  const file = path.join(root, 'package.json');
  fs.writeFileSync(file, JSON.stringify(original));
  assert.throws(() => updatePi('latest', root), /EXACT_VERSION/);
  updatePi('1.5.0', root);
  const next = JSON.parse(fs.readFileSync(file));
  assert.equal(next.dependencies.ws, '8.22.1');
  assert.equal(next.dependencies['@earendil-works/pi-coding-agent'], '1.5.0');
  assert.deepEqual(Object.values(next.devDependencies), ['1.5.0', '1.5.0', '1.5.0']);
  assert.deepEqual(fs.readdirSync(root), ['package.json']);
});

test('one checkout supplies the frontend and preserves explicit trial namespaces with its selected host', () => {
  const runtime = runtimePaths();
  assert.equal(runtime.pimux, path.join(sourceRoot, 'packages/pimux/bin/pimux'));
  assert.equal(runtime.deck, path.join(sourceRoot, 'emacs/pi-deck'));
  assert.ok(fs.statSync(path.join(sourceRoot, 'emacs/pilish/pilish.el')).isFile());
  const trial = {
    HOME: '/tmp/phimacs-synthetic/home', PHIMACS_STATE_DIR: '/tmp/phimacs-synthetic/state',
    PIMUX_DIR: '/tmp/phimacs-synthetic/mux', PI_CODING_AGENT_DIR: '/tmp/phimacs-synthetic/agent',
    PI_CODING_AGENT_SESSION_DIR: '/tmp/phimacs-synthetic/sessions', PHIMACS_PI: '/unselected/pi',
  };
  const env = runtimeEnvironment(runtime, trial);
  assert.deepEqual(env, { ...trial, PHIMACS_ROOT: sourceRoot, PHIMACS_PI: runtime.pi });
});

test('entry scripts reached through a symlinked directory run instead of silently exiting', t => {
  const link = fs.mkdtempSync(path.join(os.tmpdir(), 'phimacs-linked-scripts-'));
  t.after(() => fs.rmSync(link, { recursive: true, force: true }));
  fs.symlinkSync(path.join(sourceRoot, 'scripts'), path.join(link, 'scripts'));
  fs.symlinkSync(path.join(sourceRoot, 'emacs/pilish/scripts'), path.join(link, 'pilish'));
  const share = path.join(link, 'share');
  // The selected host, so the check does not depend on a global pi on PATH.
  const env = { PATH: process.env.PATH, HOME: link, PHIMACS_SHARE_DIR: share, PHIMACS_PI: runtimePaths().pi };
  const run = (script, args) => spawnSync(process.execPath, [path.join(link, script), ...args],
    { env, encoding: 'utf8', timeout: 10_000 });
  // A real command: the host side of device sharing prepares its private directory.
  const prepared = run('scripts/run.mjs', ['share-host', 'prepare']);
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.equal(prepared.stdout.trim(), share);
  assert.equal(fs.statSync(share).mode & 0o777, 0o700);
  const version = run('scripts/pi.mjs', ['--version']);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), runtimePaths().version);
  // The others reach their own argument validation, which touches no state.
  for (const [script, args, status, message] of [
    ['scripts/emacs-packages.mjs', [], 2, /Usage: emacs-packages\.mjs --state/],
    ['scripts/emacs-launch.mjs', ['--no-such-option'], 1, /Unknown option: --no-such-option/],
    ['scripts/update-pi.mjs', [], 1, /Usage: npm run update:pi -- EXACT_VERSION/],
  ]) {
    const result = run(script, args);
    assert.equal(result.status, status, `${script}: ${result.stderr}`);
    assert.match(result.stderr, message, script);
  }
  const storage = run('pilish/pilish-storage.mjs', []);
  assert.equal(storage.status, 1, storage.stderr);
  assert.deepEqual(JSON.parse(storage.stdout), { ok: false, error: 'Usage: node pilish-storage.mjs /absolute/pimux' });
});
