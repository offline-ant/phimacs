// Launcher boundaries: selected checkout/host, absent optional workers and private namespaces.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { parseOptions, inspectEnvironment, childEnvironment } from '../scripts/emacs-environment.mjs';
import { checkDaemonStop, ensureDaemon, IDENTITY, stopDaemon } from '../scripts/emacs-launch.mjs';
import { runtimePaths } from '../scripts/runtime.mjs';
import { orchestrationInstalled, orchestrationSelected, preparedState, setup } from '../scripts/setup.mjs';
import { formatStatus } from '../scripts/status.mjs';

/** The identity probe's printed answer from a daemon with PID and checkout ROOT. */
const answer = (pid, root) => ({ status: 0, stdout: `"[${pid},${root === null ? 'null' : `\\"${root}/\\"`}]"\n` });

const root = path.resolve(import.meta.dirname, '..');
const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
  .dependencies['@earendil-works/pi-coding-agent'];

async function fixture(action) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'phimacs-launcher-'));
  try {
    const checkout = path.join(temporary, 'checkout');
    const hostRoot = path.join(temporary, 'host');
    const host = path.join(hostRoot, 'dist/cli.js');
    const write = async (file, value, mode = 0o600) => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value), { mode });
    };
    await write(path.join(checkout, 'package.json'), { dependencies: { '@earendil-works/pi-coding-agent': version } });
    await write(path.join(hostRoot, 'package.json'), { name: '@earendil-works/pi-coding-agent', version });
    await write(host, '#!/usr/bin/env node\n', 0o700);
    await write(path.join(checkout, 'packages/pimux/bin/pimux'), '#!/usr/bin/env node\n', 0o700);
    const options = parseOptions(['--root', checkout, '--state', path.join(temporary, 'state'), '--server', 'trial'], {});
    const env = { PATH: process.env.PATH, HOME: path.join(temporary, 'home'), PHIMACS_PI: host };
    await action({ temporary, options, env, host, write });
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

test('the Emacs supervisor is selected by environment and its argument lists must be JSON string arrays', () => {
  const state = path.join(os.tmpdir(), 'phimacs-supervisor-selection');
  const options = parseOptions(['--state', state, '--daemon-mode', 'supervised'], {
    PHIMACS_SUPERVISOR_COMMAND: 'sv',
    PHIMACS_SUPERVISOR_ARGS: '["-w","30","start","emacs"]',
    PHIMACS_SUPERVISOR_STOP_ARGS: '["-w","30","stop","emacs"]' });
  assert.equal(options.mode, 'supervised');
  assert.equal(options.supervisor, 'sv');
  assert.deepEqual(options.supervisorArgs, ['-w', '30', 'start', 'emacs']);
  assert.deepEqual(options.supervisorStopArgs, ['-w', '30', 'stop', 'emacs']);
  assert.throws(() => parseOptions(['--state', state], { PHIMACS_SUPERVISOR_ARGS: '["start",1]' }),
    /PHIMACS_SUPERVISOR_ARGS must be a JSON string array/);
});

test('preflight accepts a detached checkout with the orchestration package physically absent', () => fixture(async ({ options, env }) => {
  await assert.rejects(fs.stat(path.join(options.root, 'packages/orchestration')), { code: 'ENOENT' });
  const calls = [];
  const report = await inspectEnvironment(options, { env, run(command, args, settings) {
    calls.push({ command, args, settings });
    return { status: 0, stdout: '32.0.50' };
  } });
  assert.equal(report.ok, true, report.issues.join('\n'));
  assert.equal(report.checks.find(check => check.component === 'runtime').version, version);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, options.emacs);
  assert.equal(calls[0].settings.env.PHIMACS_PI, env.PHIMACS_PI);
  assert.equal(calls[0].settings.env.EMACSLOADPATH, '');
  assert.equal(report.socket, path.join(options.state, 'sockets/trial'));
  await assert.rejects(fs.stat(options.state), { code: 'ENOENT' });
}));

test('an explicit absolute endpoint replaces the state socket for launcher and daemon alike', () => fixture(async ({ temporary, options, env }) => {
  const socket = path.join(temporary, 'deployment/emacs');
  const selected = parseOptions(['--root', options.root, '--state', options.state, '--server', 'trial'],
    { PHIMACS_SERVER_SOCKET: socket });
  assert.equal(selected.socket, socket);
  assert.equal(childEnvironment(selected, env).PHIMACS_SERVER_SOCKET, socket);
  assert.equal(parseOptions(['--root', options.root, '--state', options.state], { PHIMACS_SERVER_SOCKET: '' }).socket,
    path.join(options.state, 'sockets/phimacs'));
  assert.throws(() => parseOptions([], { PHIMACS_SERVER_SOCKET: 'relative/emacs' }), /must be absolute/);
}));

test('preflight still rejects an absent required runtime executable', () => fixture(async ({ options, env }) => {
  await fs.unlink(path.join(options.root, 'packages/pimux/bin/pimux'));
  const report = await inspectEnvironment(options, { env, run: () => ({ status: 0, stdout: '32.0.50' }) });
  assert.equal(report.ok, false);
  assert.match(report.issues.join('\n'), /packages\/pimux\/bin\/pimux/);
}));

test('child environment pins the physical host and keeps the explicit trial namespaces', () => fixture(async ({ temporary, options, env, host }) => {
  const alias = path.join(temporary, 'selected-pi');
  await fs.symlink(host, alias);
  Object.assign(env, {
    PHIMACS_PI: alias, PHIMACS_ROOT: '/foreign-checkout', PHIMACS_STATE_DIR: '/foreign-journal',
    PIMUX_DIR: path.join(temporary, 'discovery'), PI_CODING_AGENT_DIR: path.join(temporary, 'agent'),
    PI_CODING_AGENT_SESSION_DIR: path.join(temporary, 'sessions'), PHIMACS_USER_FILE: path.join(temporary, 'user.el'),
    PI_ORCHESTRATION_TARGET: 'foreign', PI_WORKER_FRAME: 'foreign', PIMUX_DISCOVERY: 'foreign',
    PHIMACS_PARENT_TASK: 'foreign', PHIMACS_PARENT_TASK_FILE: '/foreign-task', PHIMACS_PARENT_TASK_TOKEN: 'foreign',
    PHIMACS_MANAGED_CLAIM: 'foreign', HERDR_SOCKET_PATH: 'foreign', TMUX: 'foreign',
    PILISH_SESSION: 'foreign', DISPLAY: ':foreign', WAYLAND_DISPLAY: 'foreign', PI_REMOTE: 'foreign',
  });
  const child = childEnvironment(options, env);
  assert.equal(child.PHIMACS_PI, await fs.realpath(host));
  assert.equal(child.PHIMACS_ROOT, await fs.realpath(options.root));
  assert.equal(child.PHIMACS_STATE_DIR, options.state, 'journal and frontend share the selected state root');
  assert.equal(child.PHIMACS_SERVER_NAME, 'trial');
  assert.equal(child.PHIMACS_SERVER_SOCKET, path.join(options.state, 'sockets/trial'));
  assert.equal(child.PHIMACS_EMACS_LAUNCHER, path.join(options.root, 'scripts/emacs-launch.mjs'));
  assert.equal(child.PATH, env.PATH, 'no checkout .bin directory is prepended');
  for (const name of ['PIMUX_DIR', 'PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR', 'PHIMACS_USER_FILE']) {
    assert.equal(child[name], env[name], name);
  }
  for (const name of ['PI_ORCHESTRATION_TARGET', 'PI_WORKER_FRAME', 'PIMUX_DISCOVERY', 'PHIMACS_PARENT_TASK',
    'PHIMACS_PARENT_TASK_FILE', 'PHIMACS_PARENT_TASK_TOKEN', 'PHIMACS_MANAGED_CLAIM', 'HERDR_SOCKET_PATH',
    'TMUX', 'PILISH_SESSION', 'DISPLAY', 'WAYLAND_DISPLAY', 'PI_REMOTE']) {
    assert.equal(child[name], undefined, `${name} must not grant authority to the trial frontend`);
  }
  assert.equal(env.PHIMACS_PI, alias, 'the caller environment is unchanged');
}));

test('a host selected through PATH is made absolute for child startup', () => fixture(async ({ temporary, options, env, host }) => {
  const bin = path.join(temporary, 'selected-bin');
  await fs.mkdir(bin);
  await fs.symlink(host, path.join(bin, 'pi'));
  delete env.PHIMACS_PI;
  env.PATH = `${bin}${path.delimiter}${env.PATH}`;
  const child = childEnvironment(options, env);
  assert.equal(child.PHIMACS_PI, await fs.realpath(host));
  assert.equal(child.PATH, env.PATH);
}));

test('manual daemon startup uses the selected checkout and retains its committed process', () => fixture(async ({ options }) => {
  const host = runtimePaths(options.root).pi;
  let started = false;
  let child;
  try {
    const receipt = await ensureDaemon(options, {
      inspect: async () => ({ ok: true }),
      run: () => (started ? { status: 0, stdout: `"[${child.pid},\\"${options.root}/\\"]"` } : { status: 1 }),
      spawnProcess(command, args, settings) {
        assert.equal(command, options.emacs);
        assert.deepEqual(args, [`--init-directory=${path.join(options.root, 'emacs/config')}`, `--fg-daemon=${options.socket}`]);
        assert.equal(settings.env.PHIMACS_PI, host);
        assert.equal(settings.env.PHIMACS_EMACS_LAUNCHER, path.join(options.root, 'scripts/emacs-launch.mjs'));
        child = spawn(process.execPath, ['-e', 'process.on("message", () => {})'], {
          detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });
        child.once('spawn', () => { started = true; });
        return child;
      },
    });
    assert.equal(receipt.outcome, 'started');
    assert.equal(receipt.socket, options.socket);
    assert.equal(child.exitCode, null, 'committed child is not stopped by launcher cleanup');
    await assert.rejects(fs.stat(path.join(options.state, 'emacs-start.lock')), { code: 'ENOENT' });
  } finally {
    if (child?.pid && child.exitCode === null) {
      child.ref();
      const exited = once(child, 'exit');
      process.kill(-child.pid, 'SIGTERM');
      await exited;
    }
  }
}));

test('an existing unavailable endpoint never starts or takes over a daemon', () => fixture(async ({ options, write }) => {
  await write(options.socket, 'not an available server');
  await fs.chmod(options.state, 0o700);
  await fs.chmod(path.dirname(options.socket), 0o700);
  await assert.rejects(ensureDaemon(options, {
    inspect: async () => ({ ok: true }), run: () => ({ status: 1 }),
    spawnProcess: () => { throw new Error('must not start a replacement'); },
  }), /Existing Emacs socket is unavailable/);
  assert.equal(await fs.readFile(options.socket, 'utf8'), 'not an available server');
}));

test('attaching to this checkout\'s daemon skips the full preflight; other daemons are refused', () => fixture(async ({ options }) => {
  const attach = run => ensureDaemon(options, { run,
    inspect: async () => { throw new Error('a running daemon needs no startup preflight'); },
    spawnProcess: () => { throw new Error('must not start a replacement'); } });
  const calls = [];
  assert.deepEqual(await attach((command, args) => { calls.push([command, args]); return answer(4242, options.root); }),
    { outcome: 'connected', socket: options.socket, pid: 4242 });
  assert.deepEqual(calls, [[options.client, ['--alternate-editor=false', '--socket-name', options.socket, '--eval', IDENTITY]]]);
  assert.equal((await fs.stat(options.state)).mode & 0o777, 0o700);
  await assert.rejects(attach(() => answer(4242, '/elsewhere')), /runs the profile of \/elsewhere\/, not /);
  await assert.rejects(attach(() => answer(4242, null)), /is not a Phimacs profile daemon/);
  await assert.rejects(attach(() => ({ status: 0, stdout: 't\n' })), /answered without a Phimacs identity/);
}));

test('stop saves the deck, then quits or asks the supervisor, and waits for that exact process', () => fixture(async ({ options }) => {
  for (const supervised of [false, true]) {
    const daemon = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    await once(daemon, 'spawn');
    const exited = once(daemon, 'exit');
    Object.assign(options, supervised
      ? { mode: 'supervised', supervisor: '/synthetic/sv', supervisorStopArgs: ['-w', '30', 'down', 'emacs'] }
      : { mode: 'manual' });
    const calls = [];
    const receipt = await stopDaemon(options, { run(command, args) {
      calls.push(command === options.client ? args.at(-1) : [command, ...args]);
      if (command === options.client && args.at(-1) === IDENTITY) return answer(daemon.pid, options.root);
      if (command === options.supervisor || args.at(-1).includes('kill-emacs')) daemon.kill('SIGTERM');
      return { status: 0, stdout: 't' };
    } });
    await exited;
    assert.deepEqual(receipt, { outcome: 'stopped', pid: daemon.pid });
    assert.equal(calls[0], IDENTITY);
    assert.match(calls[1], /pi-deck-save-state/);
    if (supervised) assert.deepEqual(calls.slice(2), [['/synthetic/sv', '-w', '30', 'down', 'emacs']]);
    else assert.deepEqual(calls.slice(2).map(form => /\(kill-emacs\)/.test(form)), [true]);
  }
  options.supervisorStopArgs = [];
  await assert.rejects(stopDaemon(options, { run: () => { throw new Error('nothing may be asked'); } }),
    /needs PHIMACS_SUPERVISOR_COMMAND and PHIMACS_SUPERVISOR_STOP_ARGS; it was not stopped/);
  Object.assign(options, { mode: 'manual' });
  assert.deepEqual(await stopDaemon(options, { run: () => ({ status: 1 }) }), { outcome: 'absent' });
}));

test('a live concurrent startup is awaited and attached; a stale or ownerless lock is refused and kept', () => fixture(async ({ options }) => {
  const lock = path.join(options.state, 'emacs-start.lock');
  const start = async pid => (await fs.readFile(`/proc/${pid}/stat`, 'utf8')).split(') ')[1].split(' ')[19];
  const launch = run => ensureDaemon(options, { run, inspect: async () => ({ ok: true }), timeoutMs: 5000,
    spawnProcess: () => { throw new Error('a concurrent startup is never duplicated'); } });
  await fs.mkdir(options.state, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(options.state, 'sockets'), { mode: 0o700 });
  await fs.mkdir(lock, { mode: 0o700 });
  await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, start: await start(process.pid) }));
  let probes = 0;
  assert.deepEqual(await launch(() => (++probes > 3 ? answer(4242, options.root) : { status: 1 })),
    { outcome: 'connected', socket: options.socket, pid: 4242 });
  assert.ok(probes > 3, 'the endpoint was awaited');
  const gone = spawn(process.execPath, ['-e', '']);
  await once(gone, 'exit');
  await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: gone.pid, start: '1' }));
  await assert.rejects(launch(() => ({ status: 1 })), /An interrupted Emacs startup \(process \d+\) left .*emacs-start\.lock; verify no Emacs/);
  await fs.rm(path.join(lock, 'owner.json'));
  const old = new Date(Date.now() - 10_000);
  await fs.utimes(lock, old, old);
  await assert.rejects(launch(() => ({ status: 1 })), /Emacs startup lock .* has no readable owner/);
  assert.ok((await fs.stat(lock)).isDirectory(), 'refused locks are kept for inspection');
  await fs.rm(lock, { recursive: true });
  options.mode = 'supervised';
  options.supervisor = undefined;
  await assert.rejects(launch(() => ({ status: 1 })), /Supervised mode requires PHIMACS_SUPERVISOR_COMMAND \(with PHIMACS_SUPERVISOR_ARGS\)/);
}));

test('stop refuses unsaved file buffers before saving, quitting or asking the supervisor', () => fixture(async ({ options }) => {
  const daemon = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await once(daemon, 'spawn');
  try {
    for (const supervised of [false, true]) {
      Object.assign(options, supervised ? { mode: 'supervised', supervisor: '/synthetic/sv', supervisorStopArgs: ['down', 'emacs'] } : { mode: 'manual' });
      const calls = [];
      const run = (command, args) => {
        calls.push(command === options.client ? args.at(-1) : command);
        if (args.at(-1) === IDENTITY) return answer(daemon.pid, options.root);
        if (args.at(-1).includes('buffer-modified-p')) return { status: 1, stderr: '*ERROR*: Unsaved changes in /work/draft.txt; save or revert them before stopping Emacs' };
        throw new Error(`nothing else may run: ${command}`);
      };
      assert.throws(() => checkDaemonStop(options, { run }), /Emacs refused to stop: \*ERROR\*: Unsaved changes in \/work\/draft\.txt/);
      await assert.rejects(stopDaemon(options, { run }), /Unsaved changes in \/work\/draft\.txt/);
      assert.ok(calls.every(call => call !== '/synthetic/sv' && !String(call).includes('kill-emacs')), 'neither quit nor supervisor ran');
      assert.match(calls.filter(call => call !== IDENTITY).at(-1), /buffer-modified-p[^]*pi-deck-save-state/, 'the unsaved check precedes the deck save');
    }
    assert.equal(daemon.exitCode, null, 'the daemon was never asked to quit');
  } finally { daemon.kill(); }
}));

test('a supervisor-run daemon keeps its chosen display; detached starts drop the caller display', () => fixture(async ({ options, env }) => {
  Object.assign(env, { DISPLAY: ':7', WAYLAND_DISPLAY: 'wayland-7', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/caller' });
  const detached = childEnvironment(options, env);
  const supervised = childEnvironment(options, env, { display: true });
  assert.deepEqual([detached.DISPLAY, detached.WAYLAND_DISPLAY], [undefined, undefined]);
  assert.deepEqual([supervised.DISPLAY, supervised.WAYLAND_DISPLAY], [':7', 'wayland-7']);
  assert.equal(supervised.DBUS_SESSION_BUS_ADDRESS, undefined, 'only the display is the supervisor\'s selection');
}));

test('setup prepares private state, then registers orchestration only when the overrides select it', () => fixture(async ({ options, env, write }) => {
  for (const selected of [true, false]) {
    const steps = [];
    await setup(options, { env, log: line => steps.push(line),
      install: input => steps.push(['install', input.state, input.emacs]),
      run(command, args) {
        if (command === options.emacs) return { status: 0, stdout: `phimacs-orchestration:${selected ? 'on' : 'off'}` };
        steps.push([command, ...args]);
        return { status: 0 };
      } }).catch(error => steps.push(error.message));
    assert.equal((await fs.stat(options.state)).mode & 0o777, 0o700);
    assert.match(steps[0], /^Preparing Emacs packages, Ghostel's module, the markdown grammar, the markdown-inline grammar in .*: this downloads and builds them/);
    assert.equal(steps[1], `Emacs's output goes to ${path.join(options.state, 'emacs/prepare.log')}.`);
    assert.deepEqual(steps[2], ['install', options.state, options.emacs]);
    if (selected) assert.match(steps.at(-1), /Compile the checkout first \(npm run compile\): missing .*worker-task-cli\.js/);
    else assert.match(steps.slice(2).join('\n'), /disabled by your overrides[^]*Setup is complete\. Start Phimacs with: phimacs/);
  }
  await write(path.join(options.root, 'packages/orchestration/dist/worker-task-cli.js'), '', 0o700);
  const steps = [];
  await setup(options, { env, log: line => steps.push(line), install: () => {},
    run: (command, args) => command === options.emacs ? { status: 0, stdout: 'phimacs-orchestration:on' }
      : (steps.push([command, ...args]), { status: 0 }) });
  const extension = path.join(await fs.realpath(options.root), 'packages/orchestration');
  assert.deepEqual(steps.find(Array.isArray), [process.execPath, runtimePaths(options.root, env).pi, 'install', extension]);
  // A rerun neither re-registers the extension nor claims to download what is prepared.
  await write(path.join(env.HOME, '.pi/agent/settings.json'), { packages: [path.relative(path.join(env.HOME, '.pi/agent'), extension)] });
  for (const [file, value] of [['elpa/dash/dash.el', ''], ['ghostel/ghostel-module.so', ''],
    ['tree-sitter/libtree-sitter-markdown.so', ''], ['tree-sitter/libtree-sitter-markdown-inline.so', '']]) {
    await write(path.join(options.state, 'emacs', file), value);
  }
  const rerun = [];
  await setup(options, { env, log: line => rerun.push(line), install: () => {},
    run: (command, args) => command === options.emacs ? { status: 0, stdout: 'phimacs-orchestration:on' }
      : (rerun.push([command, ...args]), { status: 0 }) });
  assert.deepEqual(rerun.slice(2), ['Emacs packages, native module, grammars and checkout bytecode are ready.',
    'The orchestration Pi extension is already registered.', 'Setup is complete. Start Phimacs with: phimacs']);
  assert.match(rerun[0], /^Checking the prepared packages in .* and compiling this checkout's Lisp\.$/);
  await fs.chmod(options.state, 0o755);
  await assert.rejects(setup(options, { env, install: () => { throw new Error('must not prepare'); } }),
    /must be your own non-symlink directory with mode 0700; create it with mkdir -m 700/);
}));

test('setup facts: the real override choice, Pi registration and prepared assets', { skip: !process.env.PHIMACS_TEST_EMACS_DIR }, async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'phimacs-setup-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const options = parseOptions(['--state', path.join(temporary, 'state')], { EMACS: process.env.EMACS });
  options.emacs = process.env.EMACS || 'emacs';
  await fs.mkdir(options.state, { mode: 0o700 });
  const user = path.join(temporary, 'user.el');
  const env = { PATH: process.env.PATH, HOME: path.join(temporary, 'home'), PHIMACS_USER_FILE: user };
  assert.equal(orchestrationSelected(options, env), true, 'the profile default selects orchestration');
  await fs.writeFile(user, ';;; -*- lexical-binding: t; -*-\n(setq phimacs-enable-orchestration nil)\n');
  assert.equal(orchestrationSelected(options, env), false);
  assert.deepEqual(preparedState(options.state), ['Emacs packages', "Ghostel's module", 'the markdown grammar', 'the markdown-inline grammar']);
  await fs.cp(process.env.PHIMACS_TEST_EMACS_DIR, path.join(options.state, 'emacs'), { recursive: true });
  assert.deepEqual(preparedState(options.state), []);
  const agent = path.join(temporary, 'agent');
  await fs.mkdir(agent);
  assert.equal(orchestrationInstalled(root, { PI_CODING_AGENT_DIR: agent }), false);
  await fs.writeFile(path.join(agent, 'settings.json'), JSON.stringify({ packages: [path.relative(agent, path.join(root, 'packages/orchestration'))] }));
  assert.equal(orchestrationInstalled(root, { PI_CODING_AGENT_DIR: agent }), true, 'Pi records local packages relative to its agent directory');
});

test('status shows failed restorations, agent counts and newest device first', () => {
  const text = formatStatus({ root: '/checkout', state: '/state', host: { pi: '/pi', version: '1.5.2' },
    service: { state: 'ready', pid: 7, root: '/checkout', pending: 0, counts: { idle: 2, working: 1 },
      roots: [{}, {}], failed: [{ muxId: 'm1', cwd: '/project', error: 'Root restoration failed: gone' }] },
    emacs: { state: 'running', pid: 8, socket: '/state/sockets/phimacs' },
    setup: { missing: ["Ghostel's module"], orchestration: false },
    share: { directory: '/share', connections: [{ id: 'laptop-01', kinds: ['mic', 'notify'] }, { id: 'pc-02', kinds: ['speaker'] }] } });
  assert.match(text, /pimux {5}ready, pid 7, from \/checkout\n {10}agents: 2 idle, 1 working\n {10}journaled roots: 2; restoration failures: 1\n {12}m1 \(\/project\): Root restoration failed: gone/);
  assert.match(text, /setup {5}missing Ghostel's module; run phimacs setup/);
  assert.match(text, /share {5}2 device connection\(s\) in \/share, newest first:\n {12}laptop-01: mic notify\n {12}pc-02: speaker/);
  const stopped = formatStatus({ root: '/checkout', state: '/state', host: { pi: '/pi', version: '1.5.2' },
    service: { state: 'absent', socket: '/mux/service.sock' }, emacs: { state: 'unanswered', socket: '/state/sockets/phimacs' },
    setup: { missing: [], orchestration: true }, share: { directory: '/share', connections: [] } });
  assert.match(stopped, /pimux {5}not running \(\/mux\/service\.sock\)\nemacs {5}not answering \(\/state\/sockets\/phimacs\)\n/);
});
