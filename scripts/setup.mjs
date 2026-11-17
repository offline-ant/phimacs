// `phimacs setup`: the one-time, networked preparation the launcher never does implicitly.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { installEmacsPackages, preparationLog } from './emacs-packages.mjs';
import { privateDirectory } from './emacs-launch.mjs';
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

/** Whether Pi's user settings load this checkout's orchestration extension. */
export function orchestrationInstalled(root, env = process.env) {
  const agent = env.PI_CODING_AGENT_DIR || path.join(env.HOME || os.homedir(), '.pi/agent');
  let settings;
  try { settings = JSON.parse(fs.readFileSync(path.join(agent, 'settings.json'), 'utf8')); } catch { return false; }
  const real = file => { try { return fs.realpathSync(file); } catch { return path.resolve(file); } };
  const extension = real(path.join(root, 'packages/orchestration'));
  return (Array.isArray(settings.packages) ? settings.packages : []).some(entry => {
    const source = typeof entry === 'string' ? entry : entry?.source;
    return typeof source === 'string' && real(path.resolve(agent, source)) === extension;
  });
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

/** Prepare packages and native assets, then register the orchestration extension if it is selected. Idempotent. */
export async function setup(options, { env = process.env, run = spawnSync, log = console.log, install = installEmacsPackages } = {}) {
  fs.mkdirSync(path.dirname(options.state), { recursive: true });
  await privateDirectory(options.state);
  const missing = preparedState(options.state);
  log(missing.length
    ? `Preparing ${missing.join(', ')} in ${path.join(options.state, 'emacs')}: this downloads and builds them and takes a few minutes.`
    : `Checking the prepared packages in ${path.join(options.state, 'emacs')} and compiling this checkout's Lisp.`);
  log(`Emacs's output goes to ${preparationLog(options.state)}.`);
  install({ state: options.state, emacs: options.emacs, env });
  log('Emacs packages, native module, grammars and checkout bytecode are ready.');
  if (!orchestrationSelected(options, env, run)) {
    log('Orchestration is disabled by your overrides, so its Pi extension is not registered.');
  } else if (orchestrationInstalled(options.root, env)) {
    log('The orchestration Pi extension is already registered.');
  } else {
    const runtime = runtimePaths(options.root, env);
    if (!fs.existsSync(runtime.taskStatus)) throw new Error(`Compile the checkout first (npm run compile): missing ${runtime.taskStatus}`);
    const extension = path.join(runtime.root, 'packages/orchestration');
    log(`Registering the orchestration Pi extension: ${runtime.pi} install ${extension}`);
    const result = run(process.execPath, [runtime.pi, 'install', extension],
      { stdio: 'inherit', timeout: 120_000, env: runtimeEnvironment(runtime, env) });
    if (result.error || result.status !== 0) throw new Error(`pi install failed: ${result.error?.message ?? `exit ${result.status}`}`);
  }
  log('Setup is complete. Start Phimacs with: phimacs');
}
