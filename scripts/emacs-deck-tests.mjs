#!/usr/bin/env node
/**
 * The checkout's Emacs ERT runner: an explicitly prepared Emacs directory
 * (PHIMACS_TEST_EMACS_DIR, from scripts/emacs-packages.mjs), this checkout's
 * own-source Pilish and an isolated claim namespace/home. No package installation
 * or home-cache fallback.
 *
 *   node scripts/emacs-deck-tests.mjs [--selector S]   desktop contract suites
 *   node scripts/emacs-deck-tests.mjs --ui [--selector S]   imported UI/terminal suite
 *   node scripts/emacs-deck-tests.mjs --reference      reference-config deck lifecycle
 *   node scripts/emacs-deck-tests.mjs --orchestration [--selector S]   orchestration companion suites
 *   node scripts/emacs-deck-tests.mjs --pilish-native [--selector S]   Pilish real Pi/faux lane (PHIMACS_PI)
 *   node scripts/emacs-deck-tests.mjs --compile [--ui]   byte-compile, warnings are errors
 *   node scripts/emacs-deck-tests.mjs --preflight      read-only public API check
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createClaimTestEnvironment } from '@phimacs/pimux/ownership';
import { emacsPackageArguments } from './emacs-packages.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const deck = path.join(root, 'emacs/pi-deck');
const orchestration = path.join(root, 'packages/orchestration/emacs');
const packages = process.env.PHIMACS_TEST_EMACS_DIR;
const pilish = path.join(root, 'emacs/pilish');
if (!packages || !path.isAbsolute(packages)) {
  throw new Error('Set absolute PHIMACS_TEST_EMACS_DIR, prepared by scripts/emacs-packages.mjs; see docs/development.md');
}
const flag = name => process.argv.includes(name);
for (let index = 2; index < process.argv.length; index++) {
  const arg = process.argv[index];
  if (arg === '--selector' && process.argv[index + 1]) index++;
  else if (!['--ui', '--reference', '--orchestration', '--pilish-native', '--compile', '--preflight'].includes(arg)) {
    throw new Error(`Unknown or incomplete option: ${arg}`);
  }
}
const index = process.argv.indexOf('--selector');
const selector = index < 0 ? 't' : JSON.stringify(process.argv[index + 1] ?? '');

/** Batch suites in an isolated claim namespace/home. */
async function ertLane() {
  const environment = createClaimTestEnvironment();
  const home = path.join(environment.root, 'home');
  const temporary = path.join(environment.root, 'tmp');
  await fs.mkdir(home, { mode: 0o700 });
  await fs.mkdir(temporary, { mode: 0o700 });
  const env = { ...process.env, ...environment.env, HOME: home, TMPDIR: temporary,
    XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'), XDG_CACHE_HOME: path.join(home, 'cache'),
    EMACSLOADPATH: '', DISPLAY: '', WAYLAND_DISPLAY: '', GDK_BACKEND: 'x11',
    PI_CODING_AGENT_DIR: path.join(home, 'agent'), PI_CODING_AGENT_SESSION_DIR: environment.sessions,
    PIMUX_DIR: path.join(environment.root, 'mux'), PHIMACS_STATE_DIR: path.join(environment.root, 'state'),
    PHIMACS_TEST_DECK: deck, PHIMACS_TEST_ORCHESTRATION: orchestration };
  for (const key of Object.keys(env)) {
    if (/^(PI_ORCHESTRATION_|PI_WORKER_|PHIMACS_PARENT_TASK(?:_|$)|PHIMACS_MANAGED_CLAIM$|PIMUX_(?!DIR$)|PI_REMOTE$|HERDR_|TMUX)/.test(key)) delete env[key];
  }
  const args = ['-Q', '--batch', ...emacsPackageArguments(packages), '-L', pilish,
    '-L', deck, '-L', path.join(deck, 'test'), '-L', orchestration,
    '--eval', '(setq load-prefer-newer t native-comp-jit-compilation nil pilish-essential-grammar-action (quote warn))'];
  if (flag('--preflight')) {
    args.push('--eval', '(progn (require (quote pi-deck)) (princ "Deck public API preflight passed\\n"))');
  } else if (flag('--compile')) {
    args.push('--eval', '(setq byte-compile-error-on-warn t)', '-f', 'batch-byte-compile',
      ...(await fs.readdir(deck)).filter(file => file.endsWith('.el')).map(file => path.join(deck, file)),
      ...['smoke', 'pi-deck-native-test', 'pi-deck-finished-test', 'pi-deck-clear-immediately-test', 'pi-deck-sidebar-test', 'pi-deck-available-test', 'pi-deck-usage-test', ...(flag('--ui') ? ['pi-deck-disclosure-test'] : [])]
        .map(name => path.join(deck, 'test', `${name}.el`)));
  } else if (flag('--reference')) {
    args.push('-l', path.join(root, 'test/reference-deck-lifecycle.el'));
  } else if (flag('--orchestration')) {
    args.push('-L', path.join(pilish, 'test'), '-l', 'pi-orchestration-test', '-l', 'pi-orchestration-runtime-test',
      '--eval', `(ert-run-tests-batch-and-exit ${index < 0 ? '"^pi-orchestration-"' : selector})`);
  } else {
    const suites = flag('--ui') ? ['pi-deck-test', 'pi-deck-disclosure-test'] : ['pi-deck-detached-test', 'pi-deck-available-test'];
    for (const suite of [...suites, 'pi-deck-finished-test', 'pi-deck-clear-immediately-test', 'pi-deck-sidebar-test', 'pi-deck-usage-test']) args.push('--eval', `(require '${suite})`);
    args.push('--eval', `(ert-run-tests-batch-and-exit ${selector})`);
  }
  try {
    const result = spawnSync(process.env.EMACS ?? 'emacs', args, { encoding: 'utf8', env, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally { await fs.rm(environment.root, { recursive: true, force: true }); }
}

/**
 * Pilish's real Pi/faux lane (emacs/pilish/RUNTIME.md) in the deck native
 * fixture: staged checkout, compiled orchestration and the selected PHIMACS_PI.
 * Batch cases run first; without --selector, the live-companion case then runs
 * in a disposable editor on an owned Xvfb (PHIMACS_TEST_XVFB, else Xvfb).
 * Each case starts and stops its own pimux service.
 */
async function pilishNativeLane() {
  const { prepareDeckFixture, cleanupDeckFixture, ownedChild, waitForChild, stopChild } =
    await import('../emacs/pi-deck/scripts/native-fixture.mjs');
  const fixture = await prepareDeckFixture({ orchestration: true });
  const companion = '"^pilish-runtime-native-test-emacs-companion-"';
  let failure;
  let display;
  try {
    const cache = path.join(fixture.root, 'pilish-cache');
    await fs.mkdir(cache, { mode: 0o700 });
    const env = { ...fixture.env, PHIMACS_NATIVE_PILISH: '1', PHIMACS_ORCHESTRATION_ROOT: fixture.product,
      PILISH_TEST_ASSETS: fixture.assets, PILISH_TEST_GRAMMARS: path.join(fixture.assets, 'tree-sitter'),
      PILISH_TEST_CACHE_DIR: cache };
    const load = [...emacsPackageArguments(fixture.assets), '-L', fixture.pilish, '-L', path.join(fixture.pilish, 'test'),
      '--eval', `(setq load-prefer-newer t native-comp-jit-compilation nil native-comp-enable-subr-trampolines nil
        ghostel-module-auto-install nil pilish-essential-grammar-action (quote warn))`];
    const batch = spawnSync(fixture.emacs, ['-Q', '--batch', ...load, '-l', 'pilish-runtime-native-test', '--eval',
      `(ert-run-tests-batch-and-exit '${index < 0 ? `(and "^pilish-runtime-native-test-" (not ${companion}))` : selector})`],
    { env, encoding: 'utf8', timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
    process.stdout.write(batch.stdout ?? ''); process.stderr.write(batch.stderr ?? '');
    if (batch.error || batch.status !== 0) throw new Error(`Pilish native ERT failed: ${batch.error?.message ?? `exit ${batch.status}`}`);
    if (index < 0) {
      display = ownedChild(process.env.PHIMACS_TEST_XVFB ?? 'Xvfb',
        ['-displayfd', '1', '-screen', '0', '1024x768x24', '-nolisten', 'tcp'], env, fixture.root);
      await waitForChild(display, () => /(?:^|\n)\d+\r?\n/.test(display.log), 'owned Xvfb readiness');
      const sockets = path.join(fixture.root, 'companion');
      await fs.mkdir(sockets, { mode: 0o700 });
      const editor = ownedChild(fixture.emacs, ['-Q', ...load, '-l',
        path.join(fixture.pilish, 'test/support/emacs-companion-tests.el')], {
        ...env, DISPLAY: `:${/(?:^|\n)(\d+)\r?\n/.exec(display.log)[1]}`,
        PHIMACS_NATIVE_EMACS_ENDPOINT: path.join(sockets, 'server'),
        PILISH_NATIVE_SELECTOR: JSON.parse(companion) }, fixture.root);
      await waitForChild(editor, () => editor.exitCode !== null || editor.signalCode !== null, 'live-companion case', 240_000)
        .catch(async error => { await stopChild(editor, 'live-companion editor'); throw error; });
      process.stderr.write(editor.log);
      if (editor.exitCode !== 0 || !/Native companion: [1-9]\d* expected, 0 unexpected/.test(editor.log)) {
        throw new Error(`Pilish live-companion case failed: exit ${editor.exitCode ?? editor.signalCode}`);
      }
    }
  } catch (error) { failure = error; }
  try { await stopChild(display, 'owned Xvfb'); } catch (error) { failure = failure ? new AggregateError([failure, error]) : error; }
  await cleanupDeckFixture(fixture, failure);
  console.log('PASS: Pilish native lane; owned services and runtimes cleaned');
}

await (flag('--pilish-native') ? pilishNativeLane() : ertLane());
