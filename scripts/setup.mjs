// `phimacs setup`: the one-time, networked preparation the launcher never does implicitly.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { installEmacsPackages, preparationLog } from './emacs-packages.mjs';
import { privateDirectory } from './emacs-launch.mjs';
import { conflictReport, inspectPiPackages, registerPiPackages } from './pi-packages.mjs';
import { runtimeEnvironment, runtimePaths } from './runtime.mjs';

/** Prepared profile inputs that are missing from STATE/emacs; empty when setup is complete. */
export function preparedState(state) {
  const emacs = path.join(state, 'emacs');
  const missing = [];
  let packages = [];
  try { packages = fs.readdirSync(path.join(emacs, 'elpa')); } catch { /* missing */ }
  if (!packages.some(name => name !== 'gnupg' && name !== 'archives')) missing.push('Emacs packages');
  if (!fs.existsSync(path.join(emacs, 'ghostel/ghostel-module.so'))) missing.push("Ghostel's module");
  for (const language of ['markdown', 'markdown-inline']) {
    if (!fs.existsSync(path.join(emacs, `tree-sitter/libtree-sitter-${language}.so`))) missing.push(`the ${language} grammar`);
  }
  return missing;
}

/** Whether Pi's user settings load this checkout's orchestration package; unreadable settings do not. */
export function orchestrationInstalled(root, env = process.env) {
  try { return inspectPiPackages(fs.realpathSync(root), env).registered.includes('orchestration'); } catch { return false; }
}

/** Read the user's orchestration choice the way profile startup does: after their overrides. */
export function orchestrationSelected(options, env = process.env, run = spawnSync) {
  const form = `(progn (require 'phimacs-environment)
    (when (file-exists-p phimacs-user-file) (load phimacs-user-file nil t))
    (princ (if phimacs-enable-orchestration "phimacs-orchestration:on" "phimacs-orchestration:off")))`;
  const result = run(options.emacs, ['-Q', '--batch', '-l', path.join(options.root, 'emacs/config/early-init.el'), '--eval', form],
    { encoding: 'utf8', timeout: 30_000, env: { ...env, PHIMACS_STATE_DIR: options.state, EMACSLOADPATH: '' } });
  const answer = /phimacs-orchestration:(on|off)/.exec(result.stdout ?? '')?.[1];
  if (result.error || result.status !== 0 || !answer) {
    throw new Error(`Cannot read the orchestration choice from your overrides: ${(result.stderr || result.error?.message || 'no answer').trim()}`);
  }
  return answer === 'on';
}

/** Prepare packages and native assets, then register the orchestration Pi package if it is selected. Idempotent. */
export async function setup(options, { env = process.env, run = spawnSync, log = console.log, install = installEmacsPackages } = {}) {
  fs.mkdirSync(path.dirname(options.state), { recursive: true });
  await privateDirectory(options.state);
  const orchestration = orchestrationSelected(options, env, run);
  // Refuse other copies of the packages before the long preparation; registration checks again.
  if (orchestration) {
    const { settingsFile, conflicts } = inspectPiPackages(fs.realpathSync(options.root), env);
    if (conflicts.length) throw new Error(conflictReport(conflicts, settingsFile));
  }
  const missing = preparedState(options.state);
  log(missing.length
    ? `Preparing ${missing.join(', ')} in ${path.join(options.state, 'emacs')}: this downloads and builds them and takes a few minutes.`
    : `Checking the prepared packages in ${path.join(options.state, 'emacs')} and compiling this checkout's Lisp.`);
  log(`Emacs's output goes to ${preparationLog(options.state)}.`);
  install({ state: options.state, emacs: options.emacs, env });
  log('Emacs packages, native module, grammars and checkout bytecode are ready.');
  if (!orchestration) {
    log('Orchestration is disabled by your overrides, so its Pi extension is not registered.');
  } else {
    const runtime = runtimePaths(options.root, env);
    if (!fs.existsSync(runtime.taskStatus)) throw new Error(`Compile the checkout first (npm run compile): missing ${runtime.taskStatus}`);
    registerPiPackages({ root: runtime.root, selected: ['orchestration'], pi: [process.execPath, runtime.pi],
      env: runtimeEnvironment(runtime, env), log, run });
  }
  log('Setup is complete. Start Phimacs with: phimacs');
}
