#!/usr/bin/env node
/**
 * Prepare pinned profile packages, native assets and checkout bytecode.
 *
 *   node scripts/emacs-packages.mjs --state /abs/state
 *
 * Explicitly prepare pinned third-party packages (including Evil), Ghostel's
 * native module, the Markdown grammars and bytecode for this checkout's Lisp.
 * Prepare optional companion sources only when present; runtime selection is separate.
 * Installed packages are never changed; prepare changed pins into fresh state.
 * Normal profile startup performs none of these installation/build operations.
 */
import fs from 'node:fs/promises';
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const lisp = value => JSON.stringify(value);

/**
 * Select one Emacs build for a test harness: EMACS (a path or a name on PATH),
 * else `emacs` on the caller's PATH. EMACSCLIENT defaults to its sibling client.
 * `path` is the restricted fixture PATH; it leads with that build's directory so
 * nested `emacs`/`emacsclient` calls run the same build.
 */
export function selectedEmacs(env = process.env) {
  const executable = file => { try { accessSync(file, constants.X_OK); return true; } catch { return false; } };
  const name = env.EMACS || 'emacs';
  const emacs = name.includes('/') ? path.resolve(name)
    : (env.PATH ?? '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, name)).find(executable);
  if (!emacs || !executable(emacs)) throw new Error(`No executable Emacs selected: ${name}`);
  const directory = path.dirname(emacs);
  return { emacs, client: env.EMACSCLIENT || path.join(directory, 'emacsclient'),
    path: ['/usr/bin', '/bin'].includes(directory) ? '/usr/bin:/bin' : `${directory}:/usr/bin:/bin` };
}

/** Activate prepared third-party packages; callers load own-source packages from this checkout. */
export function emacsPackageArguments(directory) {
  if (!path.isAbsolute(directory)) throw new Error('The Emacs package directory must be absolute');
  return ['--eval', `(progn (require 'package)
  (setq package-user-dir ${lisp(path.join(directory, 'elpa'))}
        package-directory-list nil
        package-load-list '((pilish nil) all)
        treesit-extra-load-path (list ${lisp(path.join(directory, 'tree-sitter'))})
        ghostel-module-directory ${lisp(path.join(directory, 'ghostel/'))})
  (package-initialize))`];
}

/**
 * Stop the GnuPG daemons package.el started for this preparation's keyring.
 * Returns an error message, or undefined when nothing remains to stop.
 */
function stopPreparationGnupg(state, env) {
  const homedir = path.join(state, 'emacs/elpa/gnupg');
  if (!existsSync(homedir)) return undefined;
  const result = spawnSync('gpgconf', ['--homedir', homedir, '--kill', 'all'],
    { env, encoding: 'utf8', timeout: 30_000 });
  // Without gpgconf there is no GnuPG 2 installation that could start an agent.
  if (result.error?.code === 'ENOENT') return undefined;
  if (!result.error && result.status === 0) return undefined;
  return `Stopping GnuPG daemons for ${homedir} failed: ${result.error?.message
    ?? (result.stderr.trim() || `exit ${result.status}`)}`;
}

/**
 * Prepare STATE/emacs. Emacs's own output, mostly third-party compiler noise, goes to
 * STATE/emacs/prepare.log; a failure reports its last lines.
 */
export function installEmacsPackages({ state, emacs = 'emacs', env = process.env }) {
  if (!path.isAbsolute(state)) throw new Error('--state must be absolute');
  const log = preparationLog(state);
  mkdirSync(path.dirname(log), { recursive: true, mode: 0o700 });
  const output = openSync(log, 'w', 0o600);
  const child = { ...env, PHIMACS_STATE_DIR: state };
  delete child.EMACSLOADPATH;
  delete child.PHIMACS_USER_FILE;
  delete child.PHIMACS_SERVER_SOCKET;
  delete child.PHIMACS_SERVER_NAME;
  const result = spawnSync(emacs, ['-Q', '--batch', '-l', path.join(sourceRoot, 'emacs/config/early-init.el'),
    // Preparation inventories available sources, not the user's runtime choices.
    '--eval', `(progn (require 'phimacs-environment)
      (setq package-vc-register-as-project nil package-directory-list nil phimacs-enable-evil t
            phimacs-enable-orchestration
            (file-directory-p (expand-file-name "packages/orchestration/emacs" phimacs-source-directory))
            phimacs-enable-sound
            (file-directory-p (expand-file-name "packages/sound/emacs" phimacs-source-directory))))`,
    '-l', 'phimacs-packages', '-f', 'phimacs-install-packages',
    '-f', 'phimacs-install-module-and-grammars', '-f', 'phimacs-check-assets',
    '-f', 'phimacs-byte-compile-packages'],
  { env: child, stdio: ['ignore', output, output], timeout: 1_800_000 });
  closeSync(output);
  const failed = result.error || result.status !== 0;
  const errors = [];
  if (failed) errors.push(`Emacs package preparation failed: ${result.error?.message ?? `exit ${result.status}`}; its output is in ${log}`);
  // Signature checking can leave an agent running; settle it on every path.
  const cleanup = stopPreparationGnupg(state, child);
  if (cleanup) errors.push(cleanup);
  if (errors.length) {
    const tail = failed ? readFileSync(log, 'utf8').trimEnd().split('\n').slice(-20).join('\n') : '';
    throw new Error(errors.join('; ') + (tail ? `\nLast lines of ${path.basename(log)}:\n${tail}` : ''));
  }
  return path.join(state, 'emacs');
}

/** Where preparation keeps Emacs's output. */
export function preparationLog(state) {
  return path.join(state, 'emacs/prepare.log');
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  const options = {};
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index++) {
    const name = { '--state': 'state', '--emacs': 'emacs' }[argv[index]];
    if (!name || !argv[index + 1]) { console.error(`Unknown or incomplete option: ${argv[index]}`); process.exit(2); }
    options[name] = argv[++index];
  }
  if (!options.state) { console.error('Usage: emacs-packages.mjs --state /abs/state [--emacs PROGRAM]'); process.exit(2); }
  try {
    await fs.mkdir(options.state, { recursive: true, mode: 0o700 });
    console.log(`Prepared ${installEmacsPackages(options)}; Emacs's output is in ${preparationLog(options.state)}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
