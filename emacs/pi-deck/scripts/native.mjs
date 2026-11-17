#!/usr/bin/env node
// Real Pi/faux detached desktop checks; the default lane has no orchestration installed.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { emacsPackageArguments } from '../../../scripts/emacs-packages.mjs';
import { prepareDeckFixture, startFixtureService, cleanupDeckFixture } from './native-fixture.mjs';

const orchestration = process.env.PHIMACS_NATIVE_ORCHESTRATION === '1';
const fixture = await prepareDeckFixture({ orchestration });
let failure;
try {
  await startFixtureService(fixture);
  const selector = orchestration ? '"^pi-deck-native-"' : '(and "^pi-deck-native-" (not "^pi-deck-native-managed-"))';
  const args = ['-Q', '--batch', ...emacsPackageArguments(fixture.assets),
    '-L', fixture.pilish, '-L', fixture.deck, '-L', path.join(fixture.deck, 'test'),
    ...(fixture.orchestration ? ['-L', fixture.orchestration] : []),
    '--eval', `(setq load-prefer-newer t native-comp-jit-compilation nil native-comp-enable-subr-trampolines nil
      ghostel-module-auto-install nil pilish-essential-grammar-action (quote warn))`,
    '--eval', `(progn (require 'pilish) (require 'pi-deck)
      (dolist (entry '(("pilish" . ${JSON.stringify(fixture.pilish)}) ("pi-deck" . ${JSON.stringify(fixture.deck)})))
        (unless (string-prefix-p (file-name-as-directory (cdr entry)) (locate-library (car entry)))
          (error "Unexpected source origin: %s" (car entry)))))`,
    ...(!orchestration ? ['--eval', `(progn
      (dolist (library '("pi-orchestration" "pi-sound" "phimacs-packages"))
        (when (locate-library library) (error "Unexpected optional library: %s" library)))
      (when (executable-find "phimacs-task-status") (error "Unexpected task-status executable")))`] : []),
    '-l', 'pi-deck-native-test', '--eval', `(ert-run-tests-batch-and-exit '${selector})`];
  const result = spawnSync(fixture.emacs, args,
    { env: fixture.env, encoding: 'utf8', timeout: 240_000, maxBuffer: 16 * 1024 * 1024 });
  process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
  if (result.error || result.status !== 0) throw new Error(`Native ERT failed: ${result.error?.message ?? `exit ${result.status}`}`);
} catch (error) { failure = error; }
await cleanupDeckFixture(fixture, failure);
console.log(`PASS: native deck ${orchestration ? 'managed' : 'orchestration-absent'} installation; owned service and runtimes cleaned`);
