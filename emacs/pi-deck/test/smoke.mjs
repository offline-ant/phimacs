#!/usr/bin/env node
// Real deck/Pilish smoke with owned service, display and frontend; faux inference only.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { emacsPackageArguments } from '../../../scripts/emacs-packages.mjs';
import { readProcessIdentity, processIdentityStatus } from '@phimacs/pimux/process-identity';
import { prepareDeckFixture, startFixtureService, cleanupDeckFixture,
  ownedChild, waitForChild, stopChild } from '../scripts/native-fixture.mjs';

const withOrchestration = process.env.PHIMACS_SMOKE_ORCHESTRATION === '1';
const xvfb = process.env.PHIMACS_TEST_XVFB;
if (!xvfb || !path.isAbsolute(xvfb)) throw new Error('Provide absolute PHIMACS_TEST_XVFB for the owned display');
const fixture = await prepareDeckFixture({ orchestration: withOrchestration });
const { env, root, pi, pimux, taskStatus, emacs, client } = fixture;
const project = path.join(root, 'project');
const server = path.join(root, 'emacs');
const init = path.join(root, 'init.el');
const tmuxSocket = path.join(root, 'tmux');
env.FX_HOLD_DIR = path.join(root, 'holds');
await fs.mkdir(env.FX_HOLD_DIR, { mode: 0o700 });
const lisp = value => JSON.stringify(value);
const list = values => `(${values.map(lisp).join(' ')})`;
const loads = [fixture.pilish, fixture.deck, path.join(fixture.deck, 'test'), ...(fixture.orchestration ? [fixture.orchestration] : [])];
const args = ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files',
  '-e', env.PHIMACS_FAUX_EXTENSION,
  ...(withOrchestration ? ['-e', path.join(fixture.product, 'packages/extensions/extensions/error-prompt.ts'),
    '-e', path.join(fixture.product, 'packages/orchestration')] : []), '--provider', 'fx', '--model', 'one'];
if (withOrchestration) env.PHIMACS_SMOKE_ORCHESTRATION = '1';
// Worker launches discover their provider independently of the parent's explicit
// --extension arguments. Keep that discovery synthetic in this private agent dir.
await fs.writeFile(path.join(env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({
  packages: withOrchestration ? [path.join(fixture.product, 'packages/orchestration')] : [],
  extensions: [env.PHIMACS_FAUX_EXTENSION,
    ...(withOrchestration ? [path.join(fixture.product, 'packages/extensions/extensions/error-prompt.ts')] : [])],
  defaultProvider: 'fx', defaultModel: 'one', compaction: { enabled: false }, retry: { enabled: false },
}), { mode: 0o600 });
await fs.mkdir(project, { mode: 0o700 });
await fs.writeFile(init, `;;; -*- lexical-binding: t; -*-\n
${emacsPackageArguments(fixture.assets)[1]}
(setq load-prefer-newer t native-comp-jit-compilation nil ghostel-module-auto-install nil
      pilish-essential-grammar-action 'warn)
(dolist (directory '${list(loads)}) (add-to-list 'load-path directory))
${withOrchestration ? '' : `(dolist (library '("pi-orchestration" "pi-sound" "phimacs-packages"))
  (when (locate-library library) (error "Unexpected optional library: %s" library)))
(when (executable-find "phimacs-task-status") (error "Unexpected task-status executable"))`}
(require 'pilish)
(pilish-configure-runtime :pi-executable ${lisp(pi)} :pimux-executable ${lisp(pimux)}
 :task-status-executable ${taskStatus ? lisp(taskStatus) : 'nil'})
(setq pilish-extra-args '${list(args)} pilish-chat-style 'pi pilish-input-window-height 'fit
      pilish-notify-in-chat t
      pi-deck-new-space-action 'dired
      pi-deck-state-file ${lisp(path.join(root, 'desktop.eld'))}
      pi-deck-preferences-file ${lisp(path.join(root, 'preferences.eld'))}
      pi-deck-restart-command '${list([emacs, '-Q', '--daemon=%s', '-l', init])})
${withOrchestration ? "(require 'pi-orchestration)" : ''}
(require 'smoke)
(dolist (entry '(("pilish" . ${lisp(fixture.pilish)}) ("pi-deck" . ${lisp(fixture.deck)})))
  (unless (string-prefix-p (file-name-as-directory (cdr entry)) (locate-library (car entry)))
    (error "Unexpected source origin: %s" (car entry))))
(make-frame-on-display (getenv "DISPLAY"))
(pi-deck-mode 1)
`, { mode: 0o600 });

function run(command, arguments_, { allowFailure = false, timeout = 60_000 } = {}) {
  const result = spawnSync(command, arguments_, { env, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
  if (!allowFailure && (result.error || result.status !== 0)) throw new Error(`${command}: ${result.error?.message ?? result.stderr ?? result.stdout}`);
  return result;
}
function evaluate(expression, options) { return run(client, ['--alternate-editor=false', '-s', server, '--eval', expression], options).stdout.trim(); }
async function until(description, predicate, seconds = 60) {
  const deadline = performance.now() + seconds * 1000;
  while (performance.now() < deadline) { if (await predicate()) return; await delay(25); }
  throw new Error(`Timed out waiting for ${description}`);
}
function daemonPid() {
  const result = run(client, ['--alternate-editor=false', '-s', server, '--eval', '(emacs-pid)'], { allowFailure: true, timeout: 1000 });
  return result.status === 0 ? Number(result.stdout.trim()) : null;
}
function identity() { return JSON.parse(JSON.parse(evaluate('(json-serialize (pi-deck-smoke-runtime))'))); }
function assertIdentity(before, after) {
  for (const key of ['mux-id', 'pid', 'pi-pid', 'pi-start-time', 'pi-boot-id']) {
    if (!before[key] || before[key] !== after[key]) throw new Error(`Frontend restart replaced runtime ${key}`);
  }
}
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const QUIT_GRACE_MS = 20_000;
let display, failure, frontendIdentity;
const frontends = new Set();
async function startFrontend() {
  const child = ownedChild(emacs, ['-Q', `--fg-daemon=${server}`, '-l', init], env, root);
  frontends.add(child);
  await until('owned frontend readiness', () => {
    if (child.failure || child.exitCode !== null || child.signalCode !== null) throw new Error(`Owned frontend startup failed: ${child.log}`);
    const pid = daemonPid();
    if (pid) frontendIdentity = readProcessIdentity(pid);
    return pid;
  });
}
try {
  await startFixtureService(fixture);
  display = ownedChild(xvfb, ['-displayfd', '1', '-screen', '0', '1280x900x24', '-nolisten', 'tcp'], env, root);
  await waitForChild(display, () => /(?:^|\n)\d+\r?\n/.test(display.log), 'owned Xvfb readiness');
  env.DISPLAY = `:${/(?:^|\n)(\d+)\r?\n/.exec(display.log)[1]}`;
  await startFrontend();
  run('tmux', ['-S', tmuxSocket, '-f', '/dev/null', 'new-session', '-d', '-x', '160', '-y', '50',
    `${shellQuote(client)} --alternate-editor=false -s ${shellQuote(server)} -t`]);
  await until('test client frame', () => evaluate('(length (pi-deck--client-frames))') !== '0');
  const first = JSON.parse(evaluate(`(pi-deck-smoke-phase1 ${lisp(`${project}/`)})`));
  if (!first.startsWith('PASS1 ')) throw new Error(first);
  const session = first.slice(6);
  const original = identity();
  if (original.protocol !== 2) throw new Error('Native smoke requires detached protocol 2');
  if (withOrchestration) {
    evaluate(`(pi-deck-smoke-start-panels ${lisp(path.basename(root).toLowerCase())})`);
    await until('panels/workers', () => evaluate('pi-deck-smoke-panels-result') !== 'nil', 180);
    const result = JSON.parse(evaluate('(substring-no-properties pi-deck-smoke-panels-result)'));
    if (result !== 'PASS-PANELS') throw new Error(`Panel/worker integration failed: ${result}`);
  }
  const old = daemonPid();
  evaluate('(run-at-time 0 nil (lambda () (pi-deck-restart-daemon t)))');
  await until('manual successor', () => {
    const pid = daemonPid();
    if (pid && pid !== old) { frontendIdentity = readProcessIdentity(pid); return true; }
    return false;
  });
  const second = JSON.parse(evaluate(`(pi-deck-smoke-phase2 ${lisp(session)})`));
  if (!second.startsWith('PASS2 ')) throw new Error(second);
  assertIdentity(original, identity());
  const successor = daemonPid();
  evaluate('(run-at-time 0 nil (function kill-emacs))');
  await until('frontend exit', () => !daemonPid());
  await startFrontend();
  if (frontendIdentity.pid === successor) throw new Error('Frontend did not restart');
  const third = JSON.parse(evaluate(`(pi-deck-smoke-phase3 ${lisp(session)})`));
  if (!third.startsWith('PASS3 ')) throw new Error(third);
  assertIdentity(original, identity());
  const closed = JSON.parse(evaluate('(pi-deck-smoke-close)'));
  if (closed !== 'PASS-CLOSE') throw new Error(`Close failed: ${closed}`);
} catch (error) {
  failure = error;
  try {
    const messages = run(client, ['--alternate-editor=false', '-s', server, '--eval', '(with-current-buffer "*Messages*" (buffer-string))'], { allowFailure: true, timeout: 5000 });
    await fs.writeFile(path.join(root, 'frontend-messages.log'), messages.stdout ?? '', { mode: 0o600 });
    if (messages.stdout) console.error(messages.stdout);
  } catch (diagnostic) { failure = new AggregateError([error, diagnostic], 'Smoke failure and diagnostic failure'); }
} finally {
  const cleanup = [];
  run('tmux', ['-S', tmuxSocket, 'kill-server'], { allowFailure: true, timeout: 5000 });
  const frontend = daemonPid();
  run(client, ['--alternate-editor=false', '-s', server, '--eval', '(kill-emacs)'], { allowFailure: true, timeout: 5000 });
  // Let the requested kill-emacs finish; never signal Emacs during its own shutdown.
  for (const child of frontends) {
    try { await stopChild(child, 'owned foreground Emacs', QUIT_GRACE_MS); } catch (error) { cleanup.push(error); }
  }
  if (frontendIdentity) {
    try {
      const dead = () => {
        const status = processIdentityStatus(frontendIdentity);
        if (status === 'unknown') throw new Error('Owned frontend identity is uncertain');
        return status === 'dead';
      };
      try { await until('owned frontend exit after its quit request', dead, QUIT_GRACE_MS / 1000); }
      catch (late) {
        cleanup.push(late);
        if (!dead()) process.kill(frontendIdentity.pid, 'SIGTERM');
        await until('owned frontend shutdown', dead, 15);
      }
    } catch (error) { cleanup.push(error); }
  } else if (frontend) cleanup.push(new Error('Frontend appeared without an admitted owned identity'));
  try { await stopChild(display, 'owned Xvfb'); } catch (error) { cleanup.push(error); }
  if (cleanup.length) failure = new AggregateError([...(failure ? [failure] : []), ...cleanup], 'Smoke and frontend cleanup errors');
}
await cleanupDeckFixture(fixture, failure);
console.log(`PASS: ${withOrchestration ? 'managed' : 'orchestration-absent'} deck smoke; same-runtime restart/reconnect, real prompt and acknowledged Close; owned resources cleaned`);
