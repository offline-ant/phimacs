// Resolve checkout code and private state for a dedicated Emacs endpoint.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { hostVersionWarning } from './pi-packages.mjs';
import { runtimePaths, runtimeEnvironment, sourceRoot } from './runtime.mjs';

export function parseOptions(argv, env = process.env) {
  const options = { root: env.PHIMACS_ROOT || sourceRoot,
    state: env.PHIMACS_STATE_DIR || path.join(env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'), 'phimacs'),
    mode: env.PHIMACS_DAEMON_MODE ?? 'manual', server: env.PHIMACS_SERVER_NAME ?? 'phimacs',
    emacs: env.PHIMACS_EMACS ?? 'emacs', client: env.PHIMACS_EMACSCLIENT ?? 'emacsclient',
    supervisor: env.PHIMACS_SUPERVISOR_COMMAND,
    supervisorArgs: JSON.parse(env.PHIMACS_SUPERVISOR_ARGS ?? '[]'),
    supervisorStopArgs: JSON.parse(env.PHIMACS_SUPERVISOR_STOP_ARGS ?? '[]'), clientArgs: [] };
  const values = { '--root': 'root', '--state': 'state',
    '--daemon-mode': 'mode', '--server': 'server', '--emacs': 'emacs', '--emacsclient': 'client',
    '--restart-after': 'restartAfter', '--restart-start': 'restartStart' };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--') { options.clientArgs = argv.slice(index + 1); break; }
    if (arg === '--no-frame') options.noFrame = true;
    else if (arg === '--gui') options.gui = true;
    else if (arg === '--json') options.json = true;
    else if (values[arg]) {
      if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`Missing ${arg}`);
      options[values[arg]] = argv[++index];
    } else throw new Error(`Unknown option: ${arg}`);
  }
  for (const [name, value] of [['PHIMACS_SUPERVISOR_ARGS', options.supervisorArgs], ['PHIMACS_SUPERVISOR_STOP_ARGS', options.supervisorStopArgs]]) {
    if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) throw new Error(`${name} must be a JSON string array`);
  }
  if (!['manual', 'supervised'].includes(options.mode)) throw new Error('--daemon-mode must be manual or supervised');
  if (!/^[a-zA-Z0-9_-]+$/.test(options.server)) throw new Error('--server must be a simple dedicated name');
  for (const field of ['root', 'state']) {
    if (!path.isAbsolute(options[field])) throw new Error(`--${field} must be absolute`);
    options[field] = path.resolve(options[field]);
  }
  // An explicit endpoint is deployment configuration, as in early-init.el.
  const socket = env.PHIMACS_SERVER_SOCKET;
  if (socket && !path.isAbsolute(socket)) throw new Error('PHIMACS_SERVER_SOCKET must be absolute');
  options.socket = socket ? path.resolve(socket) : path.join(options.state, 'sockets', options.server);
  return options;
}

/** Read-only preflight of the runtime, Emacs and private state; packages are checked by startup itself. */
export async function inspectEnvironment(options, { run = spawnSync, env = process.env } = {}) {
  const issues = [];
  const warnings = [];
  const checks = [];
  try {
    const runtime = runtimePaths(options.root, env);
    const warning = hostVersionWarning(runtime);
    if (warning) warnings.push(warning);
    for (const executable of [runtime.pi, runtime.pimux]) await fs.access(executable, fs.constants.X_OK);
    checks.push({ component: 'runtime', version: runtime.version, root: runtime.root });
  } catch (error) { issues.push(`Runtime: ${error.message}`); }
  const expression = `(progn (unless (and (version<= "31.1" emacs-version) (fboundp 'module-load) (treesit-available-p)) (error "Emacs 31.1+ with native modules and tree-sitter required")) (princ emacs-version))`;
  const result = run(options.emacs, ['-Q', '--batch', '--eval', expression],
    { encoding: 'utf8', timeout: 10_000, env: { ...env, EMACSLOADPATH: '' } });
  if (result.error || result.status !== 0) issues.push(`Emacs: ${result.error?.message || result.stderr || 'check failed'}`);
  else checks.push({ component: 'emacs', version: result.stdout.trim() });
  const state = await fs.lstat(options.state).catch(() => null);
  if (state && (!state.isDirectory() || state.isSymbolicLink() || state.uid !== process.getuid() || (state.mode & 0o077))) issues.push(`State directory ${options.state} must be your own non-symlink directory with mode 0700; create it with mkdir -m 700 (or umask 077) or run chmod 700 on it`);
  if (Number(process.versions.node.split('.')[0]) < 24) issues.push('Node 24+ is required');
  return { ok: !issues.length, checks, issues, warnings, mode: options.mode, socket: options.socket };
}

/**
 * The caller environment without its terminal, desktop session and host/worker
 * identities. Detached services and daemons outlive the caller and must not
 * inherit authority from it. A supervisor's own `display` selection is kept.
 */
export function detachedEnvironment(env = process.env, { display = false } = {}) {
  const result = { ...env };
  for (const name of Object.keys(result)) {
    if (/^(HERDR_|TMUX|PILISH_|PI_ORCHESTRATION_|PI_WORKER_|PHIMACS_PARENT_TASK(?:_|$)|PHIMACS_MANAGED_CLAIM$)/.test(name)
        || (name.startsWith('PIMUX_') && name !== 'PIMUX_DIR')
        || (!display && ['DISPLAY', 'WAYLAND_DISPLAY'].includes(name))
        || ['SESSION_MANAGER', 'DBUS_SESSION_BUS_ADDRESS', 'EMACSLOADPATH', 'PI_REMOTE'].includes(name)) delete result[name];
  }
  return result;
}

/**
 * Remove inherited host identities before starting a separate editor. A detached
 * start drops the caller's display; a supervisor's foreground service keeps the
 * display it deliberately selected (`display: true`).
 */
export function childEnvironment(options, env = process.env, { display = false } = {}) {
  const runtime = runtimePaths(options.root, env);
  const result = detachedEnvironment(env, { display });
  Object.assign(result, runtimeEnvironment(runtime, {}),
    { PHIMACS_PI: runtime.pi,
      PHIMACS_STATE_DIR: options.state, PHIMACS_SERVER_NAME: options.server, PHIMACS_SERVER_SOCKET: options.socket,
      PHIMACS_DAEMON_MODE: options.mode,
      PHIMACS_EMACS: options.emacs, PHIMACS_EMACSCLIENT: options.client,
      PHIMACS_SUPERVISOR_ARGS: JSON.stringify(options.supervisorArgs),
      PHIMACS_SUPERVISOR_STOP_ARGS: JSON.stringify(options.supervisorStopArgs),
      PHIMACS_EMACS_LAUNCHER: path.join(runtime.root, 'scripts/emacs-launch.mjs') });
  if (options.supervisor) result.PHIMACS_SUPERVISOR_COMMAND = options.supervisor;
  return result;
}
