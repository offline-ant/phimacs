import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { parseOptions, inspectEnvironment, childEnvironment } from '../scripts/emacs-environment.mjs';
import { ensureDaemon } from '../scripts/emacs-launch.mjs';

/** What a Phimacs daemon of `root` prints for the launcher's identity probe. */
const identity = root => ({ status: 0, stdout: `"[4242,\\"${root}/\\"]"\n` });
import { selectedEmacs, installEmacsPackages } from '../scripts/emacs-packages.mjs';
import { VERSION } from '@earendil-works/pi-coding-agent';

const root = path.resolve(import.meta.dirname, '..');
const config = path.join(root, 'emacs/config');
const lisp = value => JSON.stringify(value);

async function fixture(action) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'phimacs-reference-'));
  const inheritedPi = process.env.PHIMACS_PI;
  try {
    const checkout = path.join(temp, 'checkout');
    const state = path.join(temp, 'state');
    const write = async (file, value, mode = 0o600) => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value), { mode });
    };
    const host = 'node_modules/@earendil-works/pi-coding-agent';
    const cli = '#!/usr/bin/env node\n';
    await write(path.join(checkout, 'package.json'), { dependencies: { '@earendil-works/pi-coding-agent': VERSION } });
    await write(path.join(checkout, host, 'package.json'), { name: '@earendil-works/pi-coding-agent', version: VERSION });
    await write(path.join(checkout, host, 'dist/cli.js'), cli, 0o700);
    // The synthetic host stands in for the global pi through the explicit override.
    process.env.PHIMACS_PI = path.join(checkout, host, 'dist/cli.js');
    await write(path.join(checkout, 'packages/pimux/bin/pimux'), cli, 0o700);
    await write(path.join(checkout, 'packages/orchestration/dist/worker-task-cli.js'), cli, 0o700);
    const options = parseOptions(['--root', checkout, '--state', state], {});
    const calls = [];
    const run = (command, args) => {
      calls.push({ command, args });
      return { status: 0, stdout: '32.0.50' };
    };
    await action({ temp, options, write, run, calls });
  } finally {
    if (inheritedPi === undefined) delete process.env.PHIMACS_PI; else process.env.PHIMACS_PI = inheritedPi;
    await fs.rm(temp, { recursive: true, force: true });
  }
}

/** Run FORMS in a fresh batch Emacs after the reference early-init, with an isolated home and state. */
async function batch(temp, forms, env = {}) {
  const home = path.join(temp, 'home');
  await fs.mkdir(home, { recursive: true });
  const result = spawnSync('emacs', ['-Q', '--batch', '-l', path.join(config, 'early-init.el'), '--eval', forms], {
    env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'),
      PHIMACS_STATE_DIR: path.join(temp, 'emacs-state'), GIT_TERMINAL_PROMPT: '0', ...env },
    encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
}

test('preflight checks the runtime and Emacs capabilities without creating state', () => fixture(async ({ options, run, calls }) => {
  const report = await inspectEnvironment(options, { run });
  assert.equal(report.ok, true, JSON.stringify(report.issues));
  assert.equal(report.checks.find(item => item.component === 'runtime').version, VERSION);
  assert.equal(report.checks.find(item => item.component === 'emacs').version, '32.0.50');
  assert.deepEqual(calls.map(call => call.command), ['emacs']);
  assert.deepEqual(calls[0].args.slice(0, 2), ['-Q', '--batch']);
  assert.match(calls[0].args.at(-1), /"31\.1".*module-load.*treesit-available-p/s);
  await assert.rejects(fs.stat(options.state), { code: 'ENOENT' });
}));

test('preflight accepts the real Emacs', () => fixture(async ({ options }) => {
  const report = await inspectEnvironment(options);
  assert.equal(report.ok, true, JSON.stringify(report.issues));
  assert.match(report.checks.find(item => item.component === 'emacs').version, /^\d+\.\d+/);
}));

test('preflight warns on a host minor mismatch and rejects a missing host, incapable Emacs or open state', () => fixture(async ({ options, run, write }) => {
  await write(path.join(options.root, 'package.json'), { dependencies: { '@earendil-works/pi-coding-agent': '0.0.0' } });
  const mismatched = await inspectEnvironment(options, { run });
  assert.equal(mismatched.ok, true, JSON.stringify(mismatched.issues));
  assert.match(mismatched.warnings.join('\n'), /differs from the checkout's SDK 0\.0\.0/);
  await write(path.join(options.root, 'package.json'), { dependencies: { '@earendil-works/pi-coding-agent': VERSION } });
  assert.deepEqual((await inspectEnvironment(options, { run })).warnings, []);
  const host = process.env.PHIMACS_PI;
  process.env.PHIMACS_PI = path.join(options.root, 'missing-pi');
  assert.match((await inspectEnvironment(options, { run })).issues.join('\n'), /missing-pi/);
  process.env.PHIMACS_PI = host;
  await fs.unlink(path.join(options.root, 'packages/orchestration/dist/worker-task-cli.js'));
  assert.equal((await inspectEnvironment(options, { run })).ok, true, 'task-status is conditional in profile Lisp');
  const incapable = await inspectEnvironment(options, { run: () => ({ status: 255, stderr: 'Emacs 31.1+ with native modules and tree-sitter required' }) });
  assert.match(incapable.issues.join('\n'), /^Emacs: .*tree-sitter required/m);
  await fs.mkdir(options.state, { mode: 0o755 });
  await fs.chmod(options.state, 0o755);
  assert.match((await inspectEnvironment(options, { run })).issues.join('\n'),
    new RegExp(`${options.state} .*mode 0700; create it with mkdir -m 700 \\(or umask 077\\) or run chmod 700`));
}));

test('profile state refusal names the directory and how to create it privately', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'phimacs-state-mode-'));
  try {
    const state = path.join(temp, 'state');
    await fs.mkdir(state, { mode: 0o755 });
    await fs.chmod(state, 0o755);
    const result = spawnSync(selectedEmacs().emacs, ['-Q', '--batch', '-l', path.join(config, 'early-init.el')], {
      env: { PATH: '/usr/bin:/bin', HOME: temp, PHIMACS_STATE_DIR: state }, encoding: 'utf8', timeout: 10_000,
    });
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(`Phimacs state directory ${state} must be your own non-symlink directory with mode 0700; create it with mkdir -m 700 (or umask 077) or run chmod 700 on it`),
      result.stderr);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

const gnupg = spawnSync('gpg-connect-agent', ['--version'], { encoding: 'utf8' }).status === 0;

test('preparation stops the GnuPG daemons of its own keyring on success and failure', {
  skip: gnupg ? false : 'GnuPG 2 is not installed', timeout: 20_000,
}, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'phimacs-prepare-gnupg-'));
  const homedirs = [];
  const env = { PATH: '/usr/bin:/bin', HOME: path.join(temp, 'home'), LANG: 'C.UTF-8' };
  // An exact process scan: gpg-connect-agent --no-autostart succeeds without an agent.
  const agentRunning = async homedir => {
    for (const pid of (await fs.readdir('/proc')).filter(name => /^\d+$/.test(name))) {
      const argv = (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')).split('\0');
      if (path.basename(argv[0]) === 'gpg-agent' && argv[argv.indexOf('--homedir') + 1] === homedir) return true;
    }
    return false;
  };
  try {
    await fs.mkdir(env.HOME, { mode: 0o700 });
    // Stands in for package.el signature checking: start a real agent for the
    // preparation keyring and record that it actually runs.
    const emacs = path.join(temp, 'emacs');
    await fs.writeFile(emacs, `#!/bin/sh
set -e
homedir="$PHIMACS_STATE_DIR/emacs/elpa/gnupg"
mkdir -p -m 700 "$homedir"
if [ -n "$FAKE_AGENT" ]; then
  gpg-connect-agent --homedir "$homedir" /bye >/dev/null 2>&1
  test -S "$(gpgconf --homedir "$homedir" --list-dirs agent-socket)" && touch "$PHIMACS_STATE_DIR/agent-started"
fi
exit "$FAKE_EMACS_STATUS"
`, { mode: 0o700 });
    for (const status of ['0', '3']) {
      const state = path.join(temp, `state-${status}`);
      const homedir = path.join(state, 'emacs/elpa/gnupg');
      homedirs.push(homedir);
      await fs.mkdir(state, { mode: 0o700 });
      const prepare = () => installEmacsPackages({ state, emacs, env: { ...env, FAKE_AGENT: '1', FAKE_EMACS_STATUS: status } });
      if (status === '0') assert.equal(prepare(), path.join(state, 'emacs'));
      else assert.throws(prepare, { message: `Emacs package preparation failed: exit 3; its output is in ${path.join(state, 'emacs/prepare.log')}` });
      await fs.access(path.join(state, 'agent-started'));
      assert.equal(await agentRunning(homedir), false, `agent for ${homedir} was left running`);
    }
    // A failed cleanup is reported together with the original failure.
    const bin = path.join(temp, 'bin');
    await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, 'gpgconf'), '#!/bin/sh\necho "agent control refused" >&2\nexit 7\n', { mode: 0o700 });
    const state = path.join(temp, 'state-cleanup');
    await fs.mkdir(state, { mode: 0o700 });
    assert.throws(() => installEmacsPackages({ state, emacs,
      env: { ...env, PATH: `${bin}:/usr/bin:/bin`, FAKE_EMACS_STATUS: '3' } }), {
      message: `Emacs package preparation failed: exit 3; its output is in ${path.join(state, 'emacs/prepare.log')}; Stopping GnuPG daemons for ${path.join(state, 'emacs/elpa/gnupg')} failed: agent control refused`,
    });
  } finally {
    for (const homedir of homedirs) spawnSync('gpgconf', ['--homedir', homedir, '--kill', 'all'], { env, timeout: 5_000 });
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('preparation keeps Emacs output in its log and reports the last lines of a failure', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'phimacs-prepare-log-'));
  try {
    const emacs = path.join(temp, 'emacs');
    await fs.writeFile(emacs, '#!/bin/sh\ni=1; while [ $i -le 40 ]; do echo "noise $i"; echo "warning $i" >&2; i=$((i+1)); done\nexit "$FAKE_EMACS_STATUS"\n', { mode: 0o700 });
    const env = { PATH: '/usr/bin:/bin', HOME: temp, LANG: 'C.UTF-8' };
    for (const status of ['0', '4']) {
      const state = path.join(temp, `state-${status}`);
      await fs.mkdir(state, { mode: 0o700 });
      const log = path.join(state, 'emacs/prepare.log');
      const prepare = () => installEmacsPackages({ state, emacs, env: { ...env, FAKE_EMACS_STATUS: status } });
      if (status === '0') assert.equal(prepare(), path.join(state, 'emacs'));
      else {
        assert.throws(prepare, error => {
          const lines = error.message.split('\n');
          assert.equal(lines[0], `Emacs package preparation failed: exit 4; its output is in ${log}`);
          assert.equal(lines[1], 'Last lines of prepare.log:');
          assert.deepEqual(lines.slice(2), Array.from({ length: 10 }, (_, index) => [`noise ${31 + index}`, `warning ${31 + index}`]).flat());
          return true;
        });
      }
      const text = await fs.readFile(log, 'utf8');
      assert.match(text, /^noise 1\nwarning 1\n[^]*noise 40\nwarning 40\n$/);
      assert.equal((await fs.stat(log)).mode & 0o777, 0o600);
    }
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('Lisp environment resolves programs on PATH or as absolute options and keeps state private', () => fixture(async ({ temp, write }) => {
  const bin = path.join(temp, 'bin');
  await write(path.join(bin, 'synthetic-pimux'), '#!/bin/sh\n', 0o700);
  await write(path.join(temp, 'tools/task-status'), '#!/bin/sh\n', 0o700);
  const state = path.join(temp, 'emacs-state');
  const output = await batch(temp, `(progn (require 'phimacs-environment)
    (setq phimacs-pimux-program "synthetic-pimux"
          phimacs-task-status-program ${lisp(path.join(temp, 'tools/task-status'))})
    (princ (json-serialize (list
      :pimux (phimacs-program phimacs-pimux-program)
      :task (phimacs-program phimacs-task-status-program)
      :missing (condition-case error (phimacs-program "phimacs-missing-program")
                 (error (error-message-string error)))
      :defaults (vconcat (mapcar (lambda (option) (eval (car (get option 'standard-value)) t))
                                 '(phimacs-pi-program phimacs-pimux-program phimacs-task-status-program)))
      :emacs user-emacs-directory :packages package-user-dir :module ghostel-module-directory
      :saves auto-save-list-file-prefix :user phimacs-user-file
      :archives (if package-archives t :false) :startup (if package-enable-at-startup t :false)))))`,
  { PATH: `${bin}:${process.env.PATH}` });
  const result = JSON.parse(output);
  assert.equal(result.pimux, await fs.realpath(path.join(bin, 'synthetic-pimux')));
  assert.equal(result.task, await fs.realpath(path.join(temp, 'tools/task-status')));
  assert.match(result.missing, /Cannot find executable phimacs-missing-program; install it or customize its phimacs-\*-program option/);
  assert.deepEqual(result.defaults, ['pi', path.join(root, 'packages/pimux/bin/pimux'),
    path.join(root, 'packages/orchestration/dist/worker-task-cli.js')]);
  assert.equal(result.emacs, path.join(state, 'emacs/'));
  assert.equal(result.packages, path.join(state, 'emacs/elpa'));
  assert.equal(result.module, path.join(state, 'emacs/ghostel/'));
  assert.ok(result.saves.startsWith(state + '/'));
  assert.equal(result.user, path.join(temp, 'home/config/phimacs/user.el'));
  assert.equal(result.archives, false);
  assert.equal(result.startup, false);
  assert.equal(((await fs.stat(state)).mode & 0o777), 0o700);
}));

test('direct profile starts one stable private server before persistence ownership', () => fixture(async ({ temp }) => {
  const result = JSON.parse(await batch(temp, `(progn (require 'phimacs-environment)
    (let* ((first (phimacs-start-server)) (second (phimacs-start-server)))
      (princ (json-serialize (list :live (if (process-live-p first) t :false)
        :second (if second t :false) :socket server-name
        :contact (process-contact first :service))))))`));
  assert.equal(result.live, true);
  assert.equal(result.second, false);
  assert.equal(result.socket, path.join(temp, 'emacs-state/sockets/phimacs'));
  assert.equal(result.contact, result.socket);
  assert.equal((await fs.stat(path.dirname(result.socket))).mode & 0o777, 0o700);
}));

test('direct profile refuses an existing endpoint without deleting or replacing it', () => fixture(async ({ temp, write }) => {
  const socket = path.join(temp, 'emacs-state/sockets/phimacs');
  await write(socket, 'unavailable-owner');
  await fs.chmod(path.join(temp, 'emacs-state'), 0o700);
  await fs.chmod(path.dirname(socket), 0o700);
  const message = await batch(temp, `(progn (require 'phimacs-environment)
    (princ (condition-case condition (phimacs-start-server)
             (error (error-message-string condition)))))`);
  assert.match(message, /already owned or unavailable/);
  assert.equal(await fs.readFile(socket, 'utf8'), 'unavailable-owner');
}));

/** Activate own-source paths with synthetic installed-package evidence, never an installer. */
const recordPackages = selected => `(progn (require 'phimacs-environment)
  (require 'phimacs-packages)
  (advice-add 'package-vc-install :override (lambda (&rest _) (error "Unexpected installation")))
  (setq phimacs-enable-orchestration ${selected ? 't' : 'nil'}
        phimacs-enable-sound ${selected ? 't' : 'nil'})
  (cl-letf (((symbol-function 'package-installed-p) #'always)) (phimacs-load-packages))
  (princ (json-serialize (list
    :names (vconcat (mapcar (lambda (entry) (symbol-name (car entry))) (phimacs-selected-package-specifications)))
    :load-list (format "%S" package-load-list) :load-path (vconcat load-path)))))`;

test('all own-source packages come from this checkout and optional paths require selection', () => fixture(async ({ temp }) => {
  const core = ['emacs/pilish', 'emacs/pi-deck'].map(relative => path.join(root, relative));
  const optional = ['packages/orchestration/emacs', 'packages/sound/emacs'].map(relative => path.join(root, relative));
  for (const selected of [false, true]) {
    const result = JSON.parse(await batch(temp, recordPackages(selected)));
    for (const source of core) assert.ok(result['load-path'].includes(source), source);
    for (const source of optional) assert.equal(result['load-path'].includes(source), selected, source);
    for (const name of ['pilish', 'pi-deck', 'pi-orchestration', 'pi-sound']) {
      assert.equal(result.names.includes(name), false, `${name} is own source, not downloaded`);
    }
    assert.match(result['load-list'], /\(pilish nil\)/, 'archive Pilish cannot override own source');
    assert.ok(result.names.includes('ghostel') && result.names.includes('dash'));
  }
}));

test('normal package activation refuses missing preparation without using the installer', () => fixture(async ({ temp }) => {
  const output = await batch(temp, `(progn (require 'phimacs-packages)
    (advice-add 'package-vc-install :override (lambda (&rest _) (error "Unexpected installation")))
    (princ (condition-case condition (phimacs-load-packages)
             (error (error-message-string condition)))))`);
  assert.match(output, /Missing profile package dash; run node scripts\/emacs-packages.mjs --state/);
}));

test('explicit preparation installs declared pins through the shared package list', () => fixture(async ({ temp }) => {
  const result = JSON.parse(await batch(temp, `(progn (require 'phimacs-packages)
    (let (installed calls)
      (cl-letf (((symbol-function 'package-installed-p) (lambda (name &rest _) (memq name installed)))
                ((symbol-function 'package-vc-install)
                 (lambda (spec revision &rest _)
                   (push (car spec) installed)
                   (push (list :name (symbol-name (car spec)) :revision revision
                               :url (plist-get (cdr spec) :url)) calls))))
        (phimacs-install-packages))
      (princ (json-encode (vconcat (nreverse calls))))))`));
  assert.equal(result[0].name, 'dash');
  assert.ok(result.some(item => item.name === 'ghostel'));
  assert.ok(!result.some(item => item.name === 'pilish'));
  for (const item of result) assert.match(item.revision, /^[0-9a-f]{40}$/);
}));

test('reference source has no personal infrastructure and pins every package to a full revision', async () => {
  const files = ['init.el', 'early-init.el', ...(await fs.readdir(path.join(config, 'lisp')))
    .filter(file => file.endsWith('.el')).map(file => `lisp/${file}`)];
  for (const file of files) {
    const source = await fs.readFile(path.join(config, file), 'utf8');
    // Package hosts are restricted to public GitHub below; home paths and
    // service-supervisor directories identify a personal deployment.
    assert.doesNotMatch(source, /package-refresh-contents|\(package-install |git clone|\/home\/[^/\s"]+\/|runit\//, file);
  }
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'phimacs-package-pins-'));
  let packages;
  try {
    packages = JSON.parse(await batch(temp, `(progn (require 'phimacs-packages)
      (dolist (file (list ${files.map(file => lisp(path.join(config, file))).join(' ')}))
        (with-temp-buffer (insert-file-contents file) (emacs-lisp-mode) (check-parens)))
      (princ (json-encode
        (mapcar (lambda (entry)
                  (list (cons 'name (symbol-name (car entry)))
                        (cons 'url (plist-get (cddr entry) :url)) (cons 'rev (cadr entry))))
                (append phimacs-package-specifications phimacs-evil-package-specifications)))))`));
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
  const names = packages.map(item => item.name);
  assert.equal(new Set(names).size, names.length, 'each package is declared once');
  assert.ok(names.includes('ghostel'));
  assert.equal(names.includes('pilish'), false, 'own-source Pilish is not a third-party pin');
  for (const item of packages) {
    assert.match(item.url ?? '', /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/, `${item.name} has a credential-free HTTPS repository`);
    assert.match(item.rev ?? '', /^[0-9a-f]{40}$/, `${item.name} is pinned to a full revision`);
  }
});

test('launcher environment removes inherited worker/frontend identity', () => fixture(async ({ options }) => {
  const env = childEnvironment(options, { HOME: '/synthetic', PI_ORCHESTRATION_TARGET: 'foreign',
    PIMUX_DISCOVERY: 'foreign', HERDR_SOCKET_PATH: 'foreign', DISPLAY: ':bad', WAYLAND_DISPLAY: 'bad',
    PHIMACS_PARENT_TASK: 'foreign', PHIMACS_PARENT_TASK_FILE: '/foreign-parent-task',
    PHIMACS_PARENT_TASK_TOKEN: 'foreign', PHIMACS_MANAGED_CLAIM: 'foreign',
    PI_CODING_AGENT_DIR: '/explicit-agent', PHIMACS_USER_FILE: '/explicit-user.el',
    PHIMACS_PI: process.env.PHIMACS_PI });
  for (const name of ['PHIMACS_PARENT_TASK', 'PHIMACS_PARENT_TASK_FILE', 'PHIMACS_PARENT_TASK_TOKEN', 'PHIMACS_MANAGED_CLAIM']) {
    assert.equal(env[name], undefined, `${name} must not grant authority to an independent frontend`);
  }
  assert.equal(env.PI_ORCHESTRATION_TARGET, undefined);
  assert.equal(env.PIMUX_DISCOVERY, undefined);
  assert.equal(env.DISPLAY, undefined);
  assert.equal(env.PI_CODING_AGENT_DIR, '/explicit-agent', "Pi's own agent directory convention passes through");
  assert.equal(env.PHIMACS_USER_FILE, '/explicit-user.el');
  assert.equal(env.PHIMACS_ROOT, options.root);
  assert.equal(env.PHIMACS_PI, await fs.realpath(process.env.PHIMACS_PI));
  assert.equal(env.PHIMACS_STATE_DIR, options.state);
  assert.equal(env.PHIMACS_SERVER_SOCKET, options.socket);
  assert.equal(env.PHIMACS_EMACS_LAUNCHER, path.join(options.root, 'scripts/emacs-launch.mjs'));
  assert.deepEqual(Object.keys(env).filter(name => /^PHIMACS_(PILISH_DIR|EMACS_ASSETS)$/.test(name)), []);
}));

test('failed supervised replacement never launches an unmanaged daemon', () => fixture(async ({ options }) => {
  options.mode = 'supervised';
  options.supervisor = '/synthetic/supervisor';
  let spawns = 0;
  await assert.rejects(ensureDaemon(options, { inspect: async () => ({ ok: true }),
    run: command => command === options.client ? { status: 1 } : { status: 42 },
    spawnProcess: () => { spawns++; throw new Error('must not spawn'); } }), /supervisor start command failed/);
  assert.equal(spawns, 0);
  assert.deepEqual(await fs.readdir(options.state), ['emacs-start.lock', 'sockets']);
}));

test('unresponsive existing daemon never triggers a replacement', () => fixture(async ({ options }) => {
  await assert.rejects(ensureDaemon(options, { inspect: async () => ({ ok: true }),
    run: () => ({ error: { code: 'ETIMEDOUT' } }),
    spawnProcess: () => { throw new Error('must not spawn'); } }), /unresponsive/);
}));

test('successful supervised start delegates exactly once', () => fixture(async ({ options }) => {
  options.mode = 'supervised';
  options.supervisor = '/synthetic/supervisor';
  let started = false;
  let delegated = 0;
  const result = await ensureDaemon(options, { inspect: async () => ({ ok: true }),
    run: command => {
      if (command === options.client) return started ? identity(options.root) : { status: 1 };
      assert.equal(command, options.supervisor);
      started = true; delegated++; return { status: 0 };
    }, spawnProcess: () => { throw new Error('must not spawn'); } });
  assert.equal(result.outcome, 'supervisor-started');
  assert.equal(delegated, 1);
}));

test('manual daemon launch commits an owned detached child and does not stop it', () => fixture(async ({ options }) => {
  let started = false;
  let child;
  try {
    const result = await ensureDaemon(options, { inspect: async () => ({ ok: true }),
      run: () => (started ? identity(options.root) : { status: 1 }),
      spawnProcess: () => {
        child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
        child.once('spawn', () => { started = true; });
        return child;
      } });
    assert.equal(result.outcome, 'started');
    assert.equal(child.exitCode, null);
  } finally {
    if (child?.pid && child.exitCode === null) {
      child.ref();
      const exited = new Promise(resolve => child.once('exit', resolve));
      process.kill(-child.pid, 'SIGTERM');
      await exited;
    }
  }
}));

test('missing manual executable fails without leaving a startup lock', () => fixture(async ({ options }) => {
  options.emacs = '/nonexistent-phimacs-emacs';
  await assert.rejects(ensureDaemon(options, { inspect: async () => ({ ok: true }), run: () => ({ status: 1 }) }), /Cannot launch Emacs/);
  assert.equal((await fs.readdir(options.state)).includes('emacs-start.lock'), false);
}));

for (const evil of [false, true]) {
  test(`reference UI loads the prepared packages with isolated state${evil ? ' and Evil' : ''}`, { skip: !process.env.PHIMACS_TEST_EMACS_DIR }, async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'phimacs-reference-ert-'));
    try {
      const env = { ...process.env, HOME: home, PHIMACS_STATE_DIR: path.join(home, 'state'), EMACSLOADPATH: '',
        PHIMACS_TEST_EVIL: evil ? '1' : '0', GIT_TERMINAL_PROMPT: '0' };
      delete env.PHIMACS_USER_FILE;
      const result = spawnSync('emacs', ['-Q', '--batch', '-l', path.join(root, 'test/reference-ui.el')], {
        env, encoding: 'utf8', timeout: 60_000,
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
    } finally { await fs.rm(home, { recursive: true, force: true }); }
  });
}

test('harnesses select one Emacs build and carry its directory into restricted PATHs', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'phimacs-emacs-selection-'));
  try {
    const bin = path.join(temp, 'bin');
    await fs.mkdir(bin);
    for (const name of ['emacs', 'emacs-31.1', 'emacsclient']) {
      await fs.writeFile(path.join(bin, name), '#!/bin/sh\n', { mode: 0o700 });
    }
    const expected = { emacs: path.join(bin, 'emacs'), client: path.join(bin, 'emacsclient'), path: `${bin}:/usr/bin:/bin` };
    assert.deepEqual(selectedEmacs({ PATH: `${bin}:/usr/bin` }), expected);
    assert.deepEqual(selectedEmacs({ PATH: '/nonexistent', EMACS: path.join(bin, 'emacs') }), expected);
    assert.deepEqual(selectedEmacs({ PATH: bin, EMACS: 'emacs-31.1', EMACSCLIENT: '/explicit/client' }),
      { ...expected, emacs: path.join(bin, 'emacs-31.1'), client: '/explicit/client' });
    assert.throws(() => selectedEmacs({ PATH: temp }), /No executable Emacs selected: emacs/);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});
