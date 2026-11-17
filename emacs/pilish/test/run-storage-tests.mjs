#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Explicit fresh inputs only; never package-initialize a personal directory.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { emacsPackageArguments } from '../../../scripts/emacs-packages.mjs';

const source = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const assets = process.env.PILISH_TEST_ASSETS;
const pimux = process.env.PILISH_TEST_PIMUX;
const pi = process.env.PILISH_TEST_PI;
for (const [name, value] of Object.entries({ PILISH_TEST_ASSETS: assets, PILISH_TEST_PIMUX: pimux, PILISH_TEST_PI: pi })) {
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must name an explicit absolute fresh input`);
}
const grammarDirectory = process.env.PILISH_TEST_GRAMMARS ?? path.join(assets, 'tree-sitter');
if (!path.isAbsolute(grammarDirectory)) throw new Error('PILISH_TEST_GRAMMARS must be absolute');
for (const dir of [path.join(assets, 'elpa'), grammarDirectory]) {
  if (!fs.statSync(dir).isDirectory()) throw new Error(`Missing prepared input ${dir}`);
}
const cache = path.resolve(source, '../../.cache');
fs.mkdirSync(cache, { recursive: true });
const scratch = fs.mkdtempSync(path.join(cache, 'pilish-storage-tests-'));
const env = { ...process.env, HOME: scratch, XDG_CACHE_HOME: path.join(scratch, 'cache'),
  XDG_CONFIG_HOME: path.join(scratch, 'config'), XDG_DATA_HOME: path.join(scratch, 'data'),
  PHIMACS_STATE_DIR: path.join(scratch, 'state'), PIMUX_DIR: path.join(scratch, 'mux'),
  PI_CODING_AGENT_DIR: path.join(scratch, 'agent'), PI_CODING_AGENT_SESSION_DIR: path.join(scratch, 'sessions') };
for (const name of Object.keys(env)) {
  if (/^(PI_ORCHESTRATION_|PI_WORKER_|PHIMACS_PARENT_|PHIMACS_MANAGED_CLAIM$|PHIMACS_TEST_ROOT$|PI_REMOTE$|EMACSLOADPATH$)/.test(name)) delete env[name];
}
const lisp = value => JSON.stringify(value);
function run(command, args) {
  const result = spawnSync(command, args, { cwd: source, env, stdio: 'inherit', timeout: 180_000 });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message ?? result.status}`);
}
try {
  const initialization = `(progn (setq native-comp-jit-compilation nil native-comp-enable-subr-trampolines nil load-prefer-newer t) (startup-redirect-eln-cache ${lisp(path.join(scratch, 'eln-cache'))}))`;
  const args = ['-Q', '--batch', '-L', source, '-L', path.join(source, 'test'), '--eval', initialization,
    ...emacsPackageArguments(assets), '--eval', `(setq treesit-extra-load-path (list ${lisp(grammarDirectory)}))`, '-l', 'pilish'];
  run('emacs', [...args, '-l', 'pilish-storage-test', '-f', 'ert-run-tests-batch-and-exit']);
  const selector = String.raw`pilish-test-\(rename\|session-delete\|set-label\|label-survives\|navigate\)`;
  run('emacs', [...args, '-l', 'pilish-browse-test', '--eval', `(ert-run-tests-batch-and-exit ${lisp(selector)})`]);
  run('emacs', [...args, '--eval', `(progn (require 'bytecomp) (setq byte-compile-error-on-warn t byte-compile-dest-file-function (lambda (file) (expand-file-name (concat (file-name-base file) ".elc") ${lisp(scratch)}))) (dolist (file '("pilish-storage.el" "pilish-browse.el")) (unless (byte-compile-file file) (error "Compilation failed"))) (require 'checkdoc) (dolist (file '("pilish-storage.el" "pilish-browse.el")) (checkdoc-file file)))`]);
  run(process.execPath, ['--test', path.join(source, 'test/pilish-storage.test.mjs')]);
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
