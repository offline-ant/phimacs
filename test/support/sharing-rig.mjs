// Native equal-client journeys over an explicitly owned, minimal installation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { runtimePaths, sourceRoot } from '../../scripts/runtime.mjs';
import { selectedEmacs } from '../../scripts/emacs-packages.mjs';
import { prepareDeckFixture, cleanupDeckFixture, ownedChild, waitForChild, stopChild }
  from '../../emacs/pi-deck/scripts/native-fixture.mjs';

const execute = promisify(execFile);
const support = fileURLToPath(new URL('./', import.meta.url));

export async function until(predicate, label, timeout = 30_000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await delay(25);
  }
  throw new Error(`Timed out: ${label}`);
}

/** Own source comes from this monorepo; only acquired dependency assets are external. */
export function sharingPaths(root = sourceRoot, env = process.env) {
  if (!path.isAbsolute(env.PHIMACS_TEST_EMACS_DIR ?? '')) {
    throw new Error('Set absolute PHIMACS_TEST_EMACS_DIR; no home or sibling fallback is used');
  }
  const runtime = { ...runtimePaths(root, env), pilish: path.join(root, 'emacs/pilish'),
    emacsDirectory: env.PHIMACS_TEST_EMACS_DIR };
  for (const file of [runtime.pi, runtime.pimux, path.join(runtime.pilish, 'pilish.el'),
    path.join(runtime.emacsDirectory, 'elpa'), path.join(runtime.deck, 'pi-deck.el')]) {
    if (!fs.existsSync(file)) throw new Error(`Missing sharing test input: ${file}`);
  }
  return runtime;
}

/** Isolate durable service state as well as discovery, credentials and desktop state. */
export function cleanEnvironment(namespace, runtime) {
  const env = Object.fromEntries(['LANG', 'LC_ALL', 'TERM'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  return { ...env, ...namespace.env, PATH: selectedEmacs().path, SHELL: '/bin/bash',
    HOME: path.join(namespace.root, 'home'), TMPDIR: path.join(namespace.root, 'tmp'),
    XDG_CONFIG_HOME: path.join(namespace.root, 'xdg-config'), XDG_CACHE_HOME: path.join(namespace.root, 'xdg-cache'),
    XDG_DATA_HOME: path.join(namespace.root, 'xdg-data'), XDG_RUNTIME_DIR: path.join(namespace.root, 'xdg-runtime'),
    PHIMACS_STATE_DIR: path.join(namespace.root, 'state'), PIMUX_DIR: path.join(namespace.root, 'mux'),
    PI_CODING_AGENT_DIR: path.join(namespace.root, 'agent'), PI_CODING_AGENT_SESSION_DIR: namespace.sessions,
    PHIMACS_ROOT: runtime.root, PHIMACS_PI: runtime.pi, PHIMACS_SHARING_PI: runtime.pi,
    PHIMACS_SHARING_PIMUX: runtime.pimux, PHIMACS_SHARING_PILISH: runtime.pilish,
    PHIMACS_SHARING_EMACS_DIR: runtime.emacsDirectory,
    PHIMACS_SHARING_FAUX: path.join(namespace.root, 'faux.ts'),
    PHIMACS_SHARING_PROJECT: path.join(namespace.root, 'project'), FX_HOLD_DIR: path.join(namespace.root, 'hold'),
    GDK_BACKEND: 'x11', EMACSLOADPATH: '', GIT_TERMINAL_PROMPT: '0' };
}

export class SharingRig {
  static async create({ profile = false } = {}) {
    sharingPaths();
    const fixture = await prepareDeckFixture();
    try {
      if (!profile) {
        // Resolve the declared Lisp closure, not the whole profile's installed UI.
        const selected = spawnSync(fixture.emacs, ['-Q', '--batch', '--eval', `(progn
          (require 'package) (require 'cl-lib) (require 'json)
          (setq native-comp-jit-compilation nil package-load-list '((pilish nil) all)
                package-user-dir ${JSON.stringify(path.join(fixture.assets, 'elpa'))})
          (package-initialize)
          (let ((pending '(ghostel magit-section markdown-mode markdown-table-wrap md-ts-mode transient))
                seen directories)
            (while pending
              (let ((name (pop pending)))
                (unless (memq name seen)
                  (push name seen)
                  (let ((descriptor (cadr (assq name package-alist))))
                    (cond (descriptor
                      (push (package-desc-dir descriptor) directories)
                      (dolist (requirement (package-desc-reqs descriptor)) (push (car requirement) pending)))
                      ((not (package-built-in-p name)) (error "Missing declared Lisp dependency: %s" name)))))))
            (princ (json-encode directories))))`],
        { env: fixture.env, encoding: 'utf8', timeout: 15_000 });
        if (selected.error || selected.status !== 0) throw new Error(`Minimal Lisp dependency selection failed: ${selected.error?.message ?? selected.stderr}`);
        const directories = new Set(JSON.parse(selected.stdout).map(directory => path.resolve(directory)));
        for (const entry of fs.readdirSync(path.join(fixture.assets, 'elpa'), { withFileTypes: true })) {
          const directory = path.join(fixture.assets, 'elpa', entry.name);
          if (entry.isDirectory() && !directories.has(directory)) fs.rmSync(directory, { recursive: true });
        }
      }
      const runtime = { root: fixture.product, pi: fixture.pi, pimux: fixture.pimux,
        pilish: fixture.pilish, deck: fixture.deck, emacsDirectory: fixture.assets };
      const require = createRequire(path.join(sourceRoot, 'package.json'));
      const rig = new SharingRig(fixture, runtime, require('@phimacs/pimux/process-identity'));
      for (const key of ['HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
        'XDG_RUNTIME_DIR', 'PHIMACS_STATE_DIR', 'PI_CODING_AGENT_DIR', 'PHIMACS_SHARING_PROJECT', 'FX_HOLD_DIR']) {
        fs.mkdirSync(rig.env[key], { recursive: true, mode: 0o700 });
      }
      fs.mkdirSync(path.join(rig.root, 'sockets'), { mode: 0o700 });
      fs.copyFileSync(path.join(support, 'faux.ts'), rig.env.PHIMACS_SHARING_FAUX);
      fs.copyFileSync(path.join(support, 'sharing-host.el'), path.join(rig.root, 'sharing-host.el'));
      fs.writeFileSync(path.join(rig.env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({
        packages: [], extensions: [rig.env.PHIMACS_SHARING_FAUX], defaultProvider: 'fx', defaultModel: 'one',
        compaction: { enabled: false }, retry: { enabled: false },
      }), { mode: 0o600 });
      for (const absent of ['packages/orchestration', 'packages/extensions', 'packages/sound',
        'packages/browser', 'emacs/config']) {
        assert.equal(fs.existsSync(path.join(runtime.root, absent)), false, `Unexpected installed ${absent}`);
      }
      return rig;
    } catch (error) {
      await cleanupDeckFixture(fixture, error);
      throw error;
    }
  }

  constructor(fixture, runtime, identities) {
    this.fixture = fixture; this.runtime = runtime; this.identities = identities;
    this.root = fixture.root; this.namespace = fixture;
    this.env = cleanEnvironment(fixture, runtime);
    fixture.env = this.env;
    this.children = new Set(); this.clients = new Map(); this.peers = new Set(); this.observed = new Map();
  }

  command(command, args, { env = this.env, timeout = 30_000 } = {}) {
    return execute(command, args, { env, cwd: this.env.PHIMACS_SHARING_PROJECT, timeout, maxBuffer: 32 * 1024 * 1024 });
  }

  child(command, args, env = this.env) {
    const child = ownedChild(command, args, env, this.env.PHIMACS_SHARING_PROJECT);
    this.children.add(child);
    return child;
  }

  async list() {
    const { stdout } = await this.command(this.runtime.pimux, ['list', '--json']);
    const entries = JSON.parse(stdout);
    for (const entry of entries) {
      assert.ok(entry.socket.startsWith(this.env.PIMUX_DIR + path.sep));
      if (entry.session?.file) assert.ok(entry.session.file.startsWith(this.namespace.sessions + path.sep));
      this.observed.set(entry.muxId, entry);
    }
    return entries;
  }

  async startService() {
    this.service = this.child(process.execPath, [this.runtime.pimux, 'serve']);
    this.fixture.service = this.service;
    await waitForChild(this.service, () => this.service.log.includes('pimux service ready'), 'owned runtime service readiness');
    return this.service;
  }

  async startDisplay() {
    if (this.display) return;
    const binary = process.env.PHIMACS_TEST_XVFB;
    assert.ok(path.isAbsolute(binary ?? ''), 'Set PHIMACS_TEST_XVFB for the owned display');
    this.display = this.child(binary, ['-displayfd', '1', '-screen', '0', '1280x900x24', '-nolisten', 'tcp']);
    await waitForChild(this.display, () => /(?:^|\n)\d+\r?\n/.test(this.display.log), 'owned display readiness');
    this.env.DISPLAY = `:${/(?:^|\n)(\d+)\r?\n/.exec(this.display.log)[1]}`;
  }

  async startEmacs(label = 'first') {
    await this.startDisplay();
    const socket = path.join(this.root, 'sockets', `emacs-${label}`);
    const env = { ...this.env, PHIMACS_SHARING_CLIENT: label };
    const child = this.child(this.fixture.emacs, ['-Q', `--fg-daemon=${socket}`,
      '--eval', '(make-frame-on-display (getenv "DISPLAY"))', '--load', path.join(this.root, 'sharing-host.el')], env);
    this.clients.set(label, { socket, child });
    try {
      await until(async () => {
        if (child.failure || child.exitCode !== null || child.signalCode !== null) throw new Error(`Emacs failed: ${child.log}`);
        if (!fs.existsSync(socket)) return false;
        try { return await this.el('(featurep \'sharing-host)', label); } catch { return false; }
      }, `independent ${label} Emacs readiness`);
    } catch (error) { throw new Error(`${error.message}\n${child.log}`, { cause: error }); }
    return child;
  }

  async rawEl(expression, label = 'first') {
    const socket = this.clients.get(label)?.socket;
    assert.ok(socket, `Missing owned Emacs ${label}`);
    const { stdout } = await this.command(this.fixture.client,
      ['--alternate-editor=false', '--socket-name', socket, '--eval', expression]);
    return stdout.trim();
  }

  async el(expression, label = 'first') {
    const wire = `(sharing-host-wire ${JSON.stringify(expression)})`;
    const evaluated = label === 'profile'
      ? `(with-selected-frame (or (seq-find (lambda (frame) (eq (framep frame) t)) (frame-list))
          (error "Profile has no TTY frame")) ${wire})`
      : wire;
    const stdout = await this.rawEl(evaluated, label);
    return JSON.parse(Buffer.from(JSON.parse(stdout), 'base64').toString('utf8'));
  }

  stageProfile(managed) {
    const copy = (source, destination) => fs.cpSync(source, destination, {
      recursive: true, dereference: true, preserveTimestamps: true,
      filter: file => !['.git', '.cache', 'node_modules'].includes(path.basename(file)),
    });
    for (const directory of ['emacs/config', 'scripts', 'bin']) {
      copy(path.join(sourceRoot, directory), path.join(this.runtime.root, directory));
    }
    fs.copyFileSync(path.join(sourceRoot, 'package.json'), path.join(this.runtime.root, 'package.json'));
    if (managed) {
      copy(path.join(sourceRoot, 'packages/orchestration'), path.join(this.runtime.root, 'packages/orchestration'));
      fs.symlinkSync('../../packages/orchestration', path.join(this.runtime.root, 'node_modules/@phimacs/orchestration'));
    }
    copy(this.runtime.emacsDirectory, path.join(this.env.PHIMACS_STATE_DIR, 'emacs'));
    this.env.PHIMACS_SHARING_PROFILE = '1';
    this.env.TERM = 'xterm-256color';
    this.env.PHIMACS_USER_FILE = path.join(this.root, 'profile-user.el');
    fs.writeFileSync(this.env.PHIMACS_USER_FILE, `;;; -*- lexical-binding: t; -*-\n(setq phimacs-enable-orchestration ${managed ? 't' : 'nil'})\n;; This PGTK snapshot needs an owned persistent display for emacsclient probes.\n(add-hook 'after-init-hook\n  (lambda () (make-frame-on-display (getenv \"PHIMACS_TEST_DISPLAY\"))))\n`, { mode: 0o600 });
    if (managed) {
      const settings = path.join(this.env.PI_CODING_AGENT_DIR, 'settings.json');
      const selected = JSON.parse(fs.readFileSync(settings, 'utf8'));
      selected.packages = [path.join(this.runtime.root, 'packages/orchestration')];
      fs.writeFileSync(settings, JSON.stringify(selected), { mode: 0o600 });
    }
    for (const name of ['sound', 'browser', 'extensions']) {
      assert.equal(fs.existsSync(path.join(this.runtime.root, 'packages', name)), false);
    }
  }

  async startProfile(mode) {
    await this.startDisplay();
    const pidFile = path.join(this.root, `profile-${this.profileSequence = (this.profileSequence ?? 0) + 1}.pid`);
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    const recorder = path.join(this.root, 'profile-emacs');
    // Record the owned process before any profile Lisp runs; exec retains its identity.
    // The launcher detaches the daemon from the caller's session bus; reselect the
    // fixture's absent bus so GTK on the owned display autolaunches nothing.
    assert.ok(this.env.DBUS_SESSION_BUS_ADDRESS?.startsWith(`unix:path=${this.root}${path.sep}`), 'Fixture selects a private absent session bus');
    fs.writeFileSync(recorder, `#!/bin/sh\nDBUS_SESSION_BUS_ADDRESS=${quote(this.env.DBUS_SESSION_BUS_ADDRESS)}\nexport DBUS_SESSION_BUS_ADDRESS\ncase "$1" in --init-directory=*)\n  printf '%s' "$$" > "$PHIMACS_TEST_PROFILE_PID" || exit 1\n  if [ -n "$PHIMACS_TEST_PROFILE_GATE" ]; then read -r token < "$PHIMACS_TEST_PROFILE_GATE"; fi\n;; esac\nexec ${quote(this.fixture.emacs)} "$@"\n`, { mode: 0o700 });
    const env = { ...this.env, PHIMACS_TEST_DISPLAY: this.env.DISPLAY,
      PHIMACS_TEST_PROFILE_PID: pidFile, PHIMACS_EMACS: recorder };
    const socket = path.join(env.PHIMACS_STATE_DIR, 'sockets/phimacs');
    const argv = mode === 'direct'
      ? [recorder, `--init-directory=${path.join(this.runtime.root, 'emacs/config')}`, '-nw', '--no-splash']
      : [path.join(this.runtime.root, 'bin/phimacs')];
    const child = this.child('script', ['-q', '-e', '-c', argv.map(quote).join(' '), '/dev/null'], env);
    const client = { socket, child, pidFile };
    this.clients.set('profile', client);
    await until(async () => {
      this.captureProfileIdentity(client);
      if (child.failure || child.exitCode !== null || child.signalCode !== null) throw new Error(`Profile ${mode} failed: ${child.log}`);
      if (!fs.existsSync(socket)) return false;
      try {
        const pid = Number(await this.rawEl('(and (bound-and-true-p phimacs--pi-enabled) (emacs-pid))', 'profile'));
        return Number.isSafeInteger(pid) && pid > 0 && pid === client.identity?.pid;
      } catch { return false; }
    }, `literal ${mode} profile TTY readiness`, 60_000);
    assert.ok(client.identity, 'Owned private profile server has an exact process identity before driver loading');
    // The answering server has exec'd Emacs, so its environment is the daemon's.
    assert.ok(fs.readFileSync(`/proc/${client.identity.pid}/environ`, 'utf8').split('\0')
      .includes(`DBUS_SESSION_BUS_ADDRESS=${this.env.DBUS_SESSION_BUS_ADDRESS}`), 'The profile Emacs selects the absent private session bus');
    await until(async () => JSON.parse(await this.rawEl('(json-encode (if (seq-some (lambda (frame) (eq (framep frame) t)) (frame-list)) t :json-false))', 'profile')), 'literal TTY client frame');
    await this.rawEl(`(let ((debug-on-error nil)) (load ${JSON.stringify(path.join(this.root, 'sharing-host.el'))} nil nil))`, 'profile');
    return client;
  }

  captureProfileIdentity(client) {
    if (client.identity || !client.pidFile || !fs.existsSync(client.pidFile)) return;
    const recorded = fs.readFileSync(client.pidFile, 'utf8').trim();
    if (!recorded) return;
    const pid = Number(recorded);
    assert.ok(Number.isSafeInteger(pid) && pid > 0, 'Private profile startup journal contains a PID');
    const identity = this.identities.readProcessIdentity(pid);
    if (!identity) return;
    assert.ok(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
      .includes(`--init-directory=${path.join(this.runtime.root, 'emacs/config')}`), 'Only the staged profile may register for cleanup');
    assert.equal(this.identities.processIdentityStatus(identity), 'alive');
    client.identity = identity;
  }

  state(name, label = 'first') { return this.el(`(sharing-host-state ${JSON.stringify(name)})`, label); }
  live(name, label = 'first') {
    return until(async () => { const state = await this.state(name, label); return state.runtime?.state === 'live' && state; }, `${label}/${name} live`);
  }
  settled(name, label = 'first') {
    return until(async () => { const state = await this.state(name, label); return !state.busy && state.response?.success && state; }, `${label}/${name} settled`);
  }
  stopChild(child) { return stopChild(child, 'owned test child'); }

  async stopEmacs(label = 'first') {
    const client = this.clients.get(label);
    if (!client) return;
    this.captureProfileIdentity(client);
    const exited = client.child.exitCode !== null || client.child.signalCode !== null;
    if (exited && !client.identity) return;
    if (exited && this.identities.processIdentityStatus(client.identity) === 'dead') return;
    let failure;
    try {
      await this.command(this.fixture.client,
        ['--alternate-editor=false', '--socket-name', client.socket, '--eval', '(progn (run-at-time 0 nil (function kill-emacs)) t)'], { timeout: 10_000 });
    } catch (error) {
      failure = error;
      if (client.identity && this.identities.processIdentityStatus(client.identity) === 'alive') {
        try { process.kill(client.identity.pid, 'SIGTERM'); }
        catch (signalError) { failure = new AggregateError([error, signalError], 'Shutdown RPC and identity-bound signal failed'); }
      }
    }
    try {
      await until(() => client.child.exitCode !== null || client.child.signalCode !== null, 'owned frontend graceful exit', 20_000);
      if (client.identity) await until(() => this.identities.processIdentityStatus(client.identity) === 'dead', 'owned profile process exit');
      if (failure) throw failure;
    } catch (error) { throw new AggregateError([failure, error].filter(Boolean), `Emacs shutdown is uncertain: ${[failure, error].filter(Boolean).map(String).join('; ')}`); }
  }

  async peer(runtime) {
    assert.ok(runtime.socket.startsWith(this.env.PIMUX_DIR + path.sep));
    const require = createRequire(path.join(sourceRoot, 'package.json'));
    const { isReadOnlyCommand } = require('@phimacs/pimux/protocol');
    const peer = await SharingPeer.connect(runtime.socket, isReadOnlyCommand);
    this.peers.add(peer);
    return peer;
  }

  async cleanup() {
    const errors = this.failure ? [this.failure] : [];
    for (const peer of this.peers) peer.close();
    for (const label of this.clients.keys()) {
      try { await this.stopEmacs(label); } catch (error) { errors.push(error); }
    }
    for (const child of this.children) {
      if (child === this.service) continue;
      try { await this.stopChild(child); } catch (error) { errors.push(error); }
    }
    if (errors.length) {
      for (const [index, child] of [...this.children].entries()) {
        try { fs.writeFileSync(path.join(this.root, `child-${index}.log`), child.log, { mode: 0o600 }); }
        catch (error) { errors.push(error); }
      }
    }
    await cleanupDeckFixture(this.fixture,
      errors.length ? new AggregateError(errors, `Native journey or frontend cleanup failed: ${errors.map(String).join('; ')}`) : undefined,
      () => {
        for (const entry of this.observed.values()) {
          for (const identity of [entry.ownerIdentity, entry.piIdentity].filter(Boolean)) {
            assert.equal(this.identities.processIdentityStatus(identity), 'dead', 'All observed owned writers settled');
          }
        }
      });
  }
}

export class SharingPeer {
  constructor(socket, isReadOnlyCommand) {
    this.socket = socket; this.records = []; this.pending = ''; this.nextId = 0; this.closed = false;
    this.isReadOnlyCommand = isReadOnlyCommand;
    this.ready = false; this.snapshot = null;
    socket.on('data', chunk => {
      this.pending += chunk.toString();
      let boundary;
      while ((boundary = this.pending.indexOf('\n')) >= 0) {
        const line = this.pending.slice(0, boundary).replace(/\r$/, '');
        this.pending = this.pending.slice(boundary + 1);
        if (!line) continue;
        let record;
        try {
          record = JSON.parse(line);
          assert.ok(record && typeof record === 'object' && typeof record.type === 'string', 'Malformed protocol record');
        } catch (error) { this.error = error; this.ready = false; socket.destroy(); return; }
        if (['pimux_gap', 'pimux_session_changed', 'pimux_tree_changed', 'pimux_snapshot_failed'].includes(record.type)) this.ready = false;
        if (record.type === 'pimux_snapshot') { this.snapshot = record; this.ready = false; }
        if (record.type === 'pimux_live' && record.generation === this.snapshot?.generation) this.ready = !!this.snapshot.inputContext;
        this.records.push(record);
      }
    });
    socket.on('error', error => { this.error ??= error; });
    socket.on('close', () => { this.closed = true; });
  }

  static async connect(socketPath, isReadOnlyCommand) {
    const peer = new SharingPeer(net.connect(socketPath), isReadOnlyCommand);
    try {
      await peer.wait(record => record.type === 'pimux_live', 'equal peer initial live');
      const hello = peer.records.find(record => record.type === 'pimux_hello');
      assert.equal(hello.protocol, 2);
      assert.ok(hello.capabilities.includes('contextual-input'));
      assert.equal(peer.ready, true);
      assert.equal('role' in hello, false);
      return peer;
    } catch (error) { peer.close(); throw error; }
  }

  send(command) {
    let outbound = command;
    if (!this.isReadOnlyCommand(command.type) && !command.type.startsWith('pimux_')) {
      assert.ok(this.ready && this.snapshot?.inputContext, 'Mutation needs an authoritative snapshot/live boundary');
      outbound = { ...command, pimuxContext: command.pimuxContext ?? { ...this.snapshot.inputContext } };
    }
    this.socket.write(JSON.stringify(outbound) + '\n');
  }

  async request(command, success = true) {
    const id = `runtime-peer-${++this.nextId}`;
    const start = this.records.length;
    this.send({ ...command, id });
    const response = await this.wait(record => record.type === 'response' && record.id === id, command.type, start);
    assert.equal(response.success, success, JSON.stringify(response));
    return response;
  }

  wait(predicate, label, start = 0) {
    return until(() => {
      if (this.error) throw this.error;
      const record = this.records.slice(start).find(predicate);
      if (record) return record;
      if (this.closed) throw new Error(`Peer closed before ${label}`);
      return false;
    }, label);
  }
  close() { this.socket.destroy(); }
}
