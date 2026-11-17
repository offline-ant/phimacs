#!/usr/bin/env node
/** Start a dedicated Emacs endpoint, never a provider/runtime or user service by default. */
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { childEnvironment, inspectEnvironment, parseOptions } from './emacs-environment.mjs';

async function processStart(pid) {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  } catch (error) {
    // A process that exits while its /proc entry is read reports ESRCH: it is gone.
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
    throw error;
  }
}

/** The answering daemon's process and checkout, as JSON inside the printed Lisp string. */
export const IDENTITY = `(json-serialize (vector (emacs-pid) (if (boundp 'phimacs-source-directory) phimacs-source-directory :null)))`;

const real = file => { try { return realpathSync(file); } catch { return path.resolve(file); } };

/**
 * Ask the endpoint who it is: null when nothing answers, otherwise its PID and
 * checkout. A hung endpoint or an Emacs that is not this checkout's profile is
 * an error, never a reason to start another daemon.
 */
export function probe(options, run = spawnSync) {
  const result = run(options.client, ['--alternate-editor=false', '--socket-name', options.socket, '--eval', IDENTITY], {
    encoding: 'utf8', timeout: 2000,
  });
  if (result.error?.code === 'ETIMEDOUT' || result.signal) throw new Error('Emacs endpoint is unresponsive; refusing to start a replacement');
  if (result.status !== 0) return null;
  let identity;
  try {
    const printed = (result.stdout ?? '').trim();
    if (!printed.startsWith('"') || !printed.endsWith('"')) throw new Error('not a string');
    identity = JSON.parse(printed.slice(1, -1).replace(/\\(.)/gs, '$1'));
  } catch { throw new Error(`Emacs at ${options.socket} answered without a Phimacs identity; it is not this profile's daemon`); }
  const [pid, root] = identity;
  if (typeof root !== 'string') throw new Error(`Emacs at ${options.socket} is not a Phimacs profile daemon; select another server name or state`);
  if (real(root) !== real(options.root)) throw new Error(`Emacs at ${options.socket} runs the profile of ${root}, not ${options.root}; stop it from that checkout or select another state`);
  return { pid, root };
}

export async function privateDirectory(directory) {
  try { await fs.mkdir(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
    throw new Error(`Emacs state/socket directory ${directory} must be your own non-symlink directory with mode 0700; create it with mkdir -m 700 (or umask 077) or run chmod 700 on it`);
  }
}

export async function ensureDaemon(options, { inspect = inspectEnvironment, run = spawnSync,
  spawnProcess = spawn, timeoutMs = 60_000, pause = delay } = {}) {
  // Attaching checks permissions and the daemon's identity; the full preflight
  // runs only when a daemon must start.
  const attach = async () => {
    await fs.mkdir(path.dirname(options.state), { recursive: true });
    await privateDirectory(options.state);
    await privateDirectory(path.dirname(options.socket));
    const identity = probe(options, run);
    return identity && { outcome: 'connected', socket: options.socket, pid: identity.pid };
  };
  if (!options.restartAfter) {
    const attached = await attach();
    if (attached) return attached;
  }
  const report = await inspect(options);
  if (!report.ok) throw new Error(report.issues.join('\n'));
  for (const warning of report.warnings ?? []) console.error(`warning: ${warning}`);
  if (options.restartAfter) {
    if (!/^\d+$/.test(options.restartAfter) || !options.restartStart) throw new Error('Restart requires PID and its recorded --restart-start identity');
    const deadline = Date.now() + timeoutMs;
    while (await processStart(options.restartAfter) === options.restartStart) {
      if (Date.now() >= deadline) throw new Error('Old Emacs still lives; restart refused without signalling it');
      await pause(50);
    }
    const attached = await attach();
    if (attached) return attached;
  }
  const lock = path.join(options.state, 'emacs-start.lock');
  for (const deadline = Date.now() + timeoutMs; ;) {
    try { await fs.mkdir(lock, { mode: 0o700 }); break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    // A live concurrent startup is waited for and attached; a stale or uncertain lock is refused.
    const attached = await awaitStartup(options, lock, { run, pause, timeoutMs });
    if (attached) return attached;
    if (Date.now() >= deadline) throw new Error('Emacs startup locks kept changing owner; inspect concurrent launchers');
  }
  const lockIdentity = await fs.lstat(lock);
  let child;
  let identity;
  let log;
  let committed = false;
  let supervisorAttempted = false;
  try {
    await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, start: await processStart(process.pid) }), { flag: 'wx', mode: 0o600 });
    // A concurrent startup may have committed just before this lock was taken.
    const current = probe(options, run);
    if (current) {
      committed = true;
      return { outcome: 'connected', socket: options.socket, pid: current.pid };
    }
    if (await fs.lstat(options.socket).catch(() => null)) throw new Error(`Existing Emacs socket is unavailable (${options.socket}); inspect its owner before cleanup (see the profile README on stale endpoints)`);
    if (options.mode === 'supervised') {
      if (!options.supervisor) throw new Error('Supervised mode requires PHIMACS_SUPERVISOR_COMMAND (with PHIMACS_SUPERVISOR_ARGS); no service is installed automatically');
      supervisorAttempted = true;
      const result = run(options.supervisor, options.supervisorArgs, { encoding: 'utf8', timeout: 10_000, env: childEnvironment(options) });
      if (result.error || result.status !== 0) throw new Error('Configured supervisor start command failed; no unmanaged daemon was launched. Inspect the startup lock before retrying');
    } else {
      log = await fs.open(path.join(options.state, 'emacs-start.log'), 'w', 0o600);
      child = spawnProcess(options.emacs, [`--init-directory=${path.join(options.root, 'emacs/config')}`, `--fg-daemon=${options.socket}`], {
        detached: true, stdio: ['ignore', log.fd, log.fd], env: childEnvironment(options),
      });
      let spawnError;
      child.once('error', error => { spawnError = error; });
      await new Promise(resolve => { child.once('spawn', resolve); child.once('error', resolve); });
      if (spawnError || !child.pid) throw new Error(`Cannot launch Emacs: ${spawnError?.message ?? 'no process identity'}`);
      identity = await processStart(child.pid);
      if (!identity) throw new Error('Emacs exited before publishing its process identity; inspect emacs-start.log');
    }
    const deadline = Date.now() + timeoutMs;
    let answered;
    for (;;) {
      let failure;
      try { answered = probe(options, run); } catch (error) { failure = error; }
      if (answered) break;
      // A dying daemon can leave its endpoint hanging: report the exit, not the endpoint.
      if (child && await processStart(child.pid) !== identity) throw new Error(`Emacs exited before readiness; inspect ${path.join(options.state, 'emacs-start.log')}`);
      if (failure) throw failure;
      if (Date.now() >= deadline) throw new Error('Emacs startup not ready before deadline; no replacement retry was attempted');
      await pause(50);
    }
    committed = true;
    child?.unref();
    return { outcome: options.mode === 'manual' ? 'started' : 'supervisor-started', socket: options.socket, pid: answered.pid };
  } finally {
    if (!committed && child?.pid && identity && await processStart(child.pid) === identity) {
      // Only this uncommitted child/group is ours. Never signal a discovered peer.
      try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      const deadline = Date.now() + 5000;
      while (await processStart(child.pid) === identity && Date.now() < deadline) await pause(50);
      if (await processStart(child.pid) === identity) throw new Error('Owned startup child is still exiting; retain the startup lock and inspect it');
    }
    await log?.close();
    // An external supervisor may still be acting after command failure/timeout.
    // Preserve uncertainty rather than treating it as proof no owner can appear.
    if (committed || !supervisorAttempted) {
      const current = await fs.lstat(lock).catch(() => null);
      if (current?.ino === lockIdentity.ino && current?.dev === lockIdentity.dev) await fs.rm(lock, { recursive: true });
    }
  }
}

/** Wait for a live concurrent startup's endpoint and attach; null once its lock is released without one. */
async function awaitStartup(options, lock, { run, pause, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const answered = probe(options, run);
    if (answered) return { outcome: 'connected', socket: options.socket, pid: answered.pid };
    const info = await fs.lstat(lock).catch(() => null);
    if (!info) return null;
    let owner;
    try { owner = JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8')); }
    catch (error) {
      // The owner record follows the lock immediately; only a lasting absence is uncertain.
      if (error.code !== 'ENOENT' || Date.now() - info.mtimeMs > 2000) {
        throw new Error(`Emacs startup lock ${lock} has no readable owner; verify no Emacs for this state is starting, then remove that lock`);
      }
    }
    if (owner && await processStart(owner.pid) !== owner.start) {
      throw new Error(`An interrupted Emacs startup (process ${owner.pid}) left ${lock}; verify no Emacs for this state is starting, then remove that lock`);
    }
    if (Date.now() >= deadline) throw new Error('A concurrent Emacs startup did not become ready before the deadline; it was not replaced');
    await pause(50);
  }
}

/** Refuse while a file buffer has unsaved changes: stopping never discards edits, forced or not. */
const UNSAVED = `(let ((files (delq nil (mapcar (lambda (buffer) (and (buffer-file-name buffer) (buffer-modified-p buffer) (buffer-file-name buffer))) (buffer-list)))))
  (when files (error "Unsaved changes in %s; save or revert them before stopping Emacs" (mapconcat #'identity files ", "))))`;
const READY = `(progn ${UNSAVED} (when (bound-and-true-p pi-deck--restoring) (error "Finish or cancel the deck restore before stopping Emacs")) t)`;
/** Save the deck as an explicit restart does; errors propagate instead of being demoted. */
const SAVE = `(progn ${UNSAVED} (when (bound-and-true-p pi-deck--restoring) (error "Finish or cancel the deck restore before stopping Emacs"))
  (when (bound-and-true-p pi-deck--state-owner) (pi-deck-save-state)) t)`;

function evaluateForStop(options, run, form) {
  const result = run(options.client, ['--alternate-editor=false', '--socket-name', options.socket, '--eval', form],
    { encoding: 'utf8', timeout: 30_000 });
  if (result.error || result.status !== 0) throw new Error(`Emacs refused to stop: ${(result.stderr || result.error?.message || `exit ${result.status}`).trim()}`);
}

/** Before anything else stops: refuse early on unsaved edits, a running restore or missing supervisor configuration. */
export function checkDaemonStop(options, { run = spawnSync } = {}) {
  if (options.mode === 'supervised' && (!options.supervisor || !options.supervisorStopArgs.length)) {
    throw new Error('Stopping a supervised Emacs needs PHIMACS_SUPERVISOR_COMMAND and PHIMACS_SUPERVISOR_STOP_ARGS; it was not stopped');
  }
  if (probe(options, run)) evaluateForStop(options, run, READY);
}
const QUIT = `(progn (run-at-time 0 nil (lambda () (let ((confirm-kill-processes nil) (kill-emacs-query-functions nil)) (kill-emacs)))) t)`;

/**
 * Save and quit this checkout's daemon, then wait until that exact process has
 * exited. A supervised daemon is stopped through its supervisor so that it is
 * not restarted. Agents only lose this frontend.
 */
export async function stopDaemon(options, { run = spawnSync, pause = delay, timeoutMs = 30_000 } = {}) {
  if (options.mode === 'supervised' && (!options.supervisor || !options.supervisorStopArgs.length)) {
    throw new Error('Stopping a supervised Emacs needs PHIMACS_SUPERVISOR_COMMAND and PHIMACS_SUPERVISOR_STOP_ARGS; it was not stopped');
  }
  const identity = probe(options, run);
  if (!identity) {
    if (await fs.lstat(options.socket).catch(() => null)) throw new Error(`Emacs socket ${options.socket} exists but nothing answers; inspect it before cleanup`);
    return { outcome: 'absent' };
  }
  const start = await processStart(identity.pid);
  const evaluate = form => evaluateForStop(options, run, form);
  evaluate(SAVE);
  if (options.mode === 'supervised') {
    const result = run(options.supervisor, options.supervisorStopArgs, { encoding: 'utf8', timeout: 60_000 });
    if (result.error || result.status !== 0) throw new Error(`Configured Emacs supervisor stop command failed: ${(result.stderr || result.error?.message || `exit ${result.status}`).trim()}`);
  } else evaluate(QUIT);
  const deadline = Date.now() + timeoutMs;
  while (start && await processStart(identity.pid) === start) {
    if (Date.now() >= deadline) throw new Error(`Emacs ${identity.pid} is still exiting; it was not signalled`);
    await pause(50);
  }
  return { outcome: 'stopped', pid: identity.pid };
}

/** Open a client frame; the client keeps the caller's display/terminal, not the daemon's cleaned env. */
export function openFrame(options) {
  const result = spawnSync(options.client, ['--alternate-editor=false', '--socket-name', options.socket,
    ...(options.gui ? ['--create-frame'] : ['--tty']), ...options.clientArgs], { stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

/** Internal entry for deck restarts: start or attach a daemon, optionally with a frame. */
export async function launch(argv) {
  const options = parseOptions(argv);
  const receipt = await ensureDaemon(options);
  if (options.noFrame) {
    if (options.json) console.log(JSON.stringify(receipt));
    return 0;
  }
  return openFrame(options);
}
if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  launch(process.argv.slice(2)).then(code => { process.exitCode = code; })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
