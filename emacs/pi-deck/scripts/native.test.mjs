import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { resolveHost } from '@phimacs/pimux/host-identity';
import { fixtureEnvironment, ownedChild, waitForChild, stopChild, cleanupDeckFixture } from './native-fixture.mjs';
import { selectedEmacs } from '../../../scripts/emacs-packages.mjs';

const authority = ['PHIMACS_PARENT_TASK', 'PHIMACS_PARENT_TASK_FILE', 'PHIMACS_MANAGED_CLAIM',
  'PI_ORCHESTRATION_HOST', 'PI_ORCHESTRATION_ENDPOINT', 'PI_ORCHESTRATION_TARGET',
  'PI_ORCHESTRATION_PLACEMENT', 'PI_WORKER_PARENT_PI_PID', 'PI_WORKER_ARTIFACT_DIR', 'PIMUX_DISCOVERY',
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'PI_REMOTE', 'PHIMACS_USER_FILE'];

test('native fixture selects all private state and strips provider/parent authority', () => {
  const root = '/tmp/phimacs-test-synthetic';
  const env = fixtureEnvironment({ root, sessions: root + '/sessions', env: { PHIMACS_TEST_ROOT: root } }, '/synthetic/pi',
    { ...Object.fromEntries(authority.map(key => [key, 'must-not-leak'])), PHIMACS_STATE_DIR: '/operational', PIMUX_DIR: '/operational', LANG: 'C.UTF-8' });
  for (const key of authority) assert.equal(env[key], undefined, key);
  assert.equal(env.PHIMACS_STATE_DIR, root + '/state');
  assert.equal(env.PIMUX_DIR, root + '/mux');
  assert.equal(env.PI_CODING_AGENT_DIR, root + '/agent');
  assert.equal(env.PI_CODING_AGENT_SESSION_DIR, root + '/sessions');
  assert.equal(env.PHIMACS_PI, '/synthetic/pi');
  assert.equal(env.PATH, '/usr/bin:/bin');
  assert.equal(env.HOME, root + '/home');
  assert.equal(env.LANG, 'C.UTF-8');
});

test('a child asked to quit is not signalled during its own shutdown; missing the grace is reported', { timeout: 10_000 }, async () => {
  // Exits by itself shortly after starting, like Emacs finishing a requested kill-emacs.
  const quitting = ownedChild(process.execPath, ['-e', 'process.stdout.write("up\\n"); setTimeout(() => process.exit(0), 300)'], process.env, os.tmpdir());
  await waitForChild(quitting, () => quitting.log.includes('up'), 'quitting child');
  await stopChild(quitting, 'quitting child', 5000);
  assert.equal(quitting.exitCode, 0);
  assert.equal(quitting.signalCode, null, 'no signal interrupted its own exit');
  const stuck = ownedChild(process.execPath, ['-e', 'process.stdout.write("up\\n"); setInterval(() => {}, 1000)'], process.env, os.tmpdir());
  await waitForChild(stuck, () => stuck.log.includes('up'), 'stuck child');
  await assert.rejects(stopChild(stuck, 'stuck child', 200), /stuck child did not exit within 0.2 s of its quit request/);
  assert.equal(stuck.signalCode, 'SIGTERM', 'a child past its grace is still stopped');
});

const xvfb = process.env.PHIMACS_TEST_XVFB;
test('a fixture frontend on its owned display starts no session bus or accessibility services', {
  skip: xvfb && path.isAbsolute(xvfb) ? false : 'Set absolute PHIMACS_TEST_XVFB for an owned display', timeout: 20_000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-native-bus-'));
  for (const directory of ['home', 'tmp', 'run']) fs.mkdirSync(path.join(root, directory), { mode: 0o700 });
  const selected = selectedEmacs();
  const env = { ...fixtureEnvironment({ root, sessions: path.join(root, 'sessions'), env: {} }, '/synthetic/pi'), PATH: selected.path };
  const children = [];
  t.after(async () => {
    spawnSync(selected.client, ['--alternate-editor=false', '-s', path.join(root, 'emacs'), '--eval', '(kill-emacs)'], { env, timeout: 5000 });
    for (const child of children.reverse()) await stopChild(child, 'bus probe child');
    fs.rmSync(root, { recursive: true, force: true });
  });
  const display = ownedChild(xvfb, ['-displayfd', '1', '-screen', '0', '640x480x24', '-nolisten', 'tcp'], env, root);
  children.push(display);
  await waitForChild(display, () => /(?:^|\n)\d+\r?\n/.test(display.log), 'owned Xvfb readiness');
  env.DISPLAY = `:${/(?:^|\n)(\d+)\r?\n/.exec(display.log)[1]}`;
  // Like the smoke's init file, open the owned display frame during startup; GTK
  // initializes that display, and would autolaunch a bus, while making it. The
  // startup hook runs after the daemon's server exists.
  const frontend = ownedChild(selected.emacs, ['-Q', `--fg-daemon=${path.join(root, 'emacs')}`, '--eval',
    '(progn (make-frame-on-display (getenv "DISPLAY")) (add-hook (quote emacs-startup-hook) (lambda () (message "BUS-PROBE-READY"))))'], env, root);
  children.push(frontend);
  await waitForChild(frontend, () => frontend.log.includes('BUS-PROBE-READY'), 'owned frontend readiness');
  const framed = spawnSync(selected.client, ['--alternate-editor=false', '-s', path.join(root, 'emacs'), '--eval',
    '(progn (redisplay t) (length (frame-list)))'], { env, encoding: 'utf8', timeout: 15_000 });
  assert.equal(framed.status, 0, framed.stderr);
  assert.ok(Number(framed.stdout) >= 2, 'the owned display has a real frame');
  const started = fs.readdirSync('/proc').filter(entry => /^\d+$/.test(entry)).flatMap(pid => {
    try {
      const environment = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
      if (!environment.includes(`HOME=${env.HOME}`)) return [];
      return [fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim()];
    } catch (error) { if (['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) return []; throw error; }
  });
  assert.ok(started.some(command => command.startsWith(selected.emacs)), 'the probe sees the fixture frontend');
  assert.deepEqual(started.filter(command => /dbus|at-spi/.test(command)), [], 'no unowned bus or accessibility processes');
});

test('cleanup refuses foreign-first discovery, attempts every owned runtime and preserves all failures', { timeout: 10_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-native-cleanup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const records = [
    { muxId: 'foreign', socket: '/foreign/runtime.sock' },
    { muxId: 'owned-failing', socket: path.join(root, 'mux/failing.sock') },
    { muxId: 'owned-settled', socket: path.join(root, 'mux/settled.sock') },
  ];
  const discovery = path.join(root, 'discovery.json');
  const attempts = path.join(root, 'attempts.jsonl');
  fs.writeFileSync(discovery, JSON.stringify(records));
  fs.writeFileSync(path.join(root, 'deck-panels-pending'), 'unacknowledged panel');
  const cli = path.join(root, 'cli');
  fs.writeFileSync(cli, `#!${process.execPath}
const fs = require('node:fs');
const discovery = ${JSON.stringify(discovery)};
const records = JSON.parse(fs.readFileSync(discovery, 'utf8'));
if (process.argv[2] === 'stop') {
  const id = process.argv[process.argv.indexOf('--id') + 1];
  fs.appendFileSync(${JSON.stringify(attempts)}, JSON.stringify(id) + '\\n');
  if (id === 'owned-failing') {
    process.stderr.write('simulated owned stop failure');
    process.exit(1);
  }
  fs.writeFileSync(discovery, JSON.stringify(records.filter(record => record.muxId !== id)));
  process.stdout.write('{}');
} else process.stdout.write(JSON.stringify(records));
`, { mode: 0o700 });
  const service = ownedChild(process.execPath, ['-e', 'process.stdout.write("pimux service ready\\n"); setInterval(() => {}, 1000);'], process.env, root);
  t.after(() => { if (service.exitCode === null && service.signalCode === null) service.kill('SIGTERM'); });
  await waitForChild(service, () => service.log.includes('pimux service ready'), 'synthetic service');
  const original = new Error('original assertion failure');
  const unsettled = new Error('owned writer has not settled');
  await assert.rejects(cleanupDeckFixture({ root, env: process.env, pimux: cli, service }, original, () => {
    assert.notEqual(service.signalCode, null, 'writer verification runs after service settlement');
    assert.ok(fs.existsSync(root), 'writer verification runs before evidence removal');
    throw unsettled;
  }), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0], original);
    assert.equal(error.errors.length, 6);
    assert.match(String(error.errors[1]), /foreign runtime/);
    assert.match(String(error.errors[2]), /simulated owned stop failure/);
    assert.match(String(error.errors[3]), /discovery still has live runtimes/);
    assert.match(String(error.errors[4]), /panel cleanup is unacknowledged/);
    assert.equal(error.errors[5], unsettled);
    assert.match(error.message, /evidence retained/);
    return true;
  });
  assert.deepEqual(fs.readFileSync(attempts, 'utf8').trim().split('\n').map(line => JSON.parse(line)),
    ['owned-failing', 'owned-settled'], 'foreign runtimes are not mutated and owned cleanup continues after failure');
  assert.deepEqual(JSON.parse(fs.readFileSync(discovery, 'utf8')), records.slice(0, 2), 'later owned runtime settled');
  assert.notEqual(service.signalCode, null, 'owned service exited even when reconciliation failed');
  assert.ok(fs.existsSync(root), 'failed cleanup retains evidence');
});

for (const harness of ['native', 'smoke']) {
  test(`${harness} subprocess clears authority and cleans owned children at its frontend boundary`, { timeout: 20_000 }, t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-native-env-'));
    const receipt = path.join(directory, 'child.json');
    const xvfb = path.join(directory, 'xvfb');
    const displayPid = path.join(directory, 'display.pid');
    t.after(() => {
      if (fs.existsSync(displayPid)) {
        const pid = Number(fs.readFileSync(displayPid, 'utf8'));
        try {
          const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
          if (args.includes(xvfb)) process.kill(pid, 'SIGTERM');
        } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
      }
      if (fs.existsSync(receipt)) {
        const child = JSON.parse(fs.readFileSync(receipt, 'utf8'));
        assert.ok(child.root.startsWith('/tmp/phimacs-test-'));
        fs.rmSync(child.root, { recursive: true, force: true });
      }
      fs.rmSync(directory, { recursive: true, force: true });
    });
    const packages = path.join(directory, 'prepared');
    fs.mkdirSync(packages);
    const emacs = path.join(directory, 'frontend');
    // This probes the process boundary only. The separate explicit native lanes
    // load real modules/grammars and execute ERT; this stub certifies no assets.
    fs.writeFileSync(emacs, `#!${process.execPath}
const assert = require('node:assert/strict');
const fs = require('node:fs');
for (const key of ${JSON.stringify(authority)}) assert.equal(process.env[key], undefined, key);
const root = process.env.PHIMACS_TEST_ROOT;
assert.ok(root.startsWith('/tmp/phimacs-test-'));
assert.equal(process.env.PHIMACS_STATE_DIR, root + '/state');
assert.equal(process.env.PI_CODING_AGENT_SESSION_DIR, root + '/sessions');
assert.equal(process.env.PHIMACS_TASK_STATUS_EXECUTABLE, undefined);
assert.ok(process.env.PHIMACS_NATIVE_PILISH.startsWith(root + '/product/'));
assert.equal(fs.existsSync(root + '/product/packages/orchestration'), false);
assert.equal(fs.existsSync(root + '/product/packages/sound'), false);
assert.equal(fs.existsSync(root + '/product/emacs/config'), false);
if (process.argv.includes('pi-deck-native-test') || process.argv.some(value => value.startsWith('--fg-daemon='))) {
  fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ root }));
  ${harness === 'smoke' ? "process.stderr.write('ISOLATION_PROBE_COMPLETE\\n'); process.exit(73);" : ''}
}
`, { mode: 0o700 });
    fs.writeFileSync(xvfb, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(displayPid)}, String(process.pid));\nprocess.stdout.write('199\\n');\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
    const client = path.join(directory, 'client');
    fs.writeFileSync(client, `#!${process.execPath}\nrequire('node:assert/strict').ok(process.argv.includes('--alternate-editor=false')); process.exit(1);\n`, { mode: 0o700 });
    const script = harness === 'native' ? './native.mjs' : '../test/smoke.mjs';
    const result = spawnSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url))], {
      encoding: 'utf8', timeout: 18_000,
      env: { ...process.env, ...Object.fromEntries(authority.map(key => [key, 'synthetic-authority'])),
        EMACS: emacs, EMACSCLIENT: client, PHIMACS_TEST_XVFB: xvfb,
        PHIMACS_TEST_EMACS_DIR: packages, PHIMACS_PI: resolveHost().executable,
        PHIMACS_NATIVE_ORCHESTRATION: '', PHIMACS_SMOKE_ORCHESTRATION: '' },
    });
    assert.equal(result.error, undefined, result.stderr);
    assert.equal(result.status, harness === 'smoke' ? 1 : 0, result.stdout + result.stderr);
    const child = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    if (harness === 'smoke') {
      assert.match(result.stderr, /ISOLATION_PROBE_COMPLETE/);
      const pid = Number(fs.readFileSync(displayPid, 'utf8'));
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'owned display exits after frontend startup failure');
      assert.ok(fs.existsSync(child.root), 'failure evidence remains');
    } else assert.equal(fs.existsSync(child.root), false, 'acknowledged cleanup removes its namespace');
  });
}
