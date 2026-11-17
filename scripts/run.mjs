#!/usr/bin/env node
/**
 * Local `phimacs` commands. bin/phimacs runs this file (and scripts/pi.mjs for
 * `pi`); it owns remote use over SSH and device sharing itself.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { childEnvironment, inspectEnvironment, parseOptions } from './emacs-environment.mjs';
import { checkDaemonStop, ensureDaemon, openFrame, privateDirectory, probe, stopDaemon } from './emacs-launch.mjs';
import { runtimeEnvironment, runtimePaths } from './runtime.mjs';
import { describeService, ensureService, serviceEnvironment, stopAll } from './service.mjs';
import { preparedState, setup } from './setup.mjs';
import { setupPi } from './setup-pi.mjs';
import { shareHost } from './share-host.mjs';
import { collectStatus, formatStatus } from './status.mjs';

export const USAGE = `Usage: phimacs [--gui | --no-frame] [-- EMACSCLIENT-ARGUMENTS]
       phimacs setup [pi [--browser] [--sound]] | status [--json] | stop [--force] | pi [PI-ARGUMENTS]
       phimacs service pimux|emacs | pimux ARGUMENTS | share | client [install [FILE]]
Prefix --local to ignore PHIMACS_HOST.`;

class UsageError extends Error {}

/** The private state directory, created 0700 when missing. */
export async function prepareState(options) {
  fs.mkdirSync(path.dirname(options.state), { recursive: true });
  await privateDirectory(options.state);
}

/** Absolute executable for execve, which does not search PATH. */
function which(name, env) {
  if (name.includes('/')) return path.resolve(name);
  for (const directory of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const file = path.join(directory, name);
    try { fs.accessSync(file, fs.constants.X_OK); return file; } catch { /* next */ }
  }
  throw new Error(`Cannot find ${name} on PATH`);
}

/** Start or attach pimux and tell a user who just started it what that means. */
export async function startService(options, runtime, env) {
  await prepareState(options);
  const { outcome } = await ensureService({ runtime, state: options.state, env });
  if (outcome === 'attached') return { outcome };
  console.error(`Started pimux ${outcome === 'started' ? `(log ${path.join(options.state, 'pimux.log')})` : 'through its supervisor'}.`
    + ' Journaled root agents are restored idle; nothing is replayed. Agents keep running after Emacs closes; `phimacs stop` stops them.');
  const service = await describeService(env, runtime.root);
  for (const root of service.failed ?? []) console.error(`warning: root ${root.muxId} (${root.cwd}) was not restored: ${root.error}`);
  return { outcome, pid: service.pid };
}

/** Full preflight for a daemon start, including the one-time setup. */
const startPreflight = env => async options => {
  const report = await inspectEnvironment(options, { env });
  const missing = preparedState(options.state);
  if (missing.length) {
    report.ok = false;
    report.issues.push(`Setup is incomplete (missing ${missing.join(', ')}); run phimacs setup`);
  }
  return report;
};

async function frame(argv, env) {
  for (const arg of argv) {
    if (arg === '--') break;
    if (!['--gui', '--no-frame'].includes(arg)) throw new UsageError(`Unknown option or command: ${arg}`);
  }
  const options = parseOptions(argv, env);
  const runtime = runtimePaths(options.root, env);
  await prepareState(options);
  await privateDirectory(path.dirname(options.socket));
  // Prove a needed Emacs start can succeed before pimux starts: a failed preflight leaves nothing running.
  let preflight;
  if (!probe(options)) {
    preflight = await startPreflight(env)(options);
    if (!preflight.ok) throw new Error(preflight.issues.join('\n'));
  }
  const service = await startService(options, runtime, env);
  try { await ensureDaemon(options, { inspect: async () => preflight ?? await startPreflight(env)(options) }); }
  catch (error) {
    if (service.outcome === 'attached') throw error;
    throw new Error(`${error.message}\nThe pimux service this command started is still running${service.pid ? ` (pid ${service.pid})` : ''}; \`phimacs stop\` stops it.`, { cause: error });
  }
  return options.noFrame ? 0 : openFrame(options);
}

async function service(argv, env) {
  const options = parseOptions([], env);
  const runtime = runtimePaths(options.root, env);
  await prepareState(options);
  if (argv.length !== 1) throw new UsageError('Usage: phimacs service pimux|emacs');
  if (argv[0] === 'pimux') {
    // Exec keeps the PID, so a supervisor signals and observes the service itself.
    process.execve(process.execPath, [process.execPath, runtime.pimux, 'serve'], serviceEnvironment(runtime, options.state, env));
  } else if (argv[0] === 'emacs') {
    const report = await startPreflight(env)(options);
    if (!report.ok) throw new Error(report.issues.join('\n'));
    await privateDirectory(path.dirname(options.socket));
    process.execve(which(options.emacs, env), [options.emacs, `--init-directory=${path.join(runtime.root, 'emacs/config')}`,
      `--fg-daemon=${options.socket}`], childEnvironment(options, env, { display: true }));
  } else throw new UsageError('Usage: phimacs service pimux|emacs');
  throw new Error('Service exec returned without replacing the launcher');
}

async function stop(argv, env) {
  if (argv.some(arg => arg !== '--force')) throw new UsageError('Usage: phimacs stop [--force]');
  const options = parseOptions([], env);
  let emacs;
  // --force interrupts agents; it never discards unsaved editor changes.
  const result = await stopAll({ env, root: options.root, force: argv.includes('--force'),
    checkFrontends: async () => checkDaemonStop(options),
    stopFrontends: async () => { emacs = await stopDaemon(options); } });
  const parts = [emacs?.outcome === 'stopped' ? `Saved and quit Emacs (pid ${emacs.pid})` : 'Emacs was not running'];
  const roots = result.roots === 0 ? 'no journaled root agents remain'
    : result.roots === 1 ? 'the next phimacs restores its 1 journaled root agent idle'
      : `the next phimacs restores its ${result.roots} journaled root agents idle`;
  parts.push(result.service === 'stopped' ? `stopped pimux; ${roots}` : 'pimux was not running');
  console.log(`${parts.join('; ')}.`);
  return 0;
}

export async function main(argv, env = process.env) {
  const [command, ...rest] = argv;
  if (command === undefined || command.startsWith('-')) return await frame(argv, env);
  if (command === 'setup') {
    if (rest[0] === 'pi') { setupPi(rest.slice(1), { env }); return 0; }
    if (rest.length) throw new UsageError('Usage: phimacs setup [pi [--browser] [--sound]]');
    await setup(parseOptions([], env), { env });
    return 0;
  }
  if (command === 'status') {
    if (rest.some(arg => arg !== '--json')) throw new UsageError('Usage: phimacs status [--json]');
    const status = await collectStatus(parseOptions([], env), env);
    console.log(rest.includes('--json') ? JSON.stringify(status) : formatStatus(status));
    return 0;
  }
  if (command === 'stop') return await stop(rest, env);
  if (command === 'service') return await service(rest, env);
  if (command === 'pimux') {
    if (rest[0] === 'serve') throw new UsageError('Use `phimacs service pimux` for a foreground service, or `phimacs` to start it');
    const options = parseOptions([], env);
    const runtime = runtimePaths(options.root, env);
    process.execve(process.execPath, [process.execPath, runtime.pimux, ...rest], { ...runtimeEnvironment(runtime, env),
      PHIMACS_STATE_DIR: options.state, PHIMACS_EMACS_LAUNCHER: path.join(runtime.root, 'scripts/emacs-launch.mjs') });
  }
  if (command === 'share-host') return await shareHost(rest, env);
  throw new UsageError(`Unknown command: ${command}`);
}

if (process.argv[1] && pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    console.error(error instanceof UsageError ? `phimacs: ${error.message}\n${USAGE}` : `phimacs: ${error.message}`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  });
}
