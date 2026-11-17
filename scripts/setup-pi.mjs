#!/usr/bin/env node
/**
 * `phimacs setup pi [--browser] [--sound]`: build and register this checkout's Pi
 * packages for plain `pi`, without Emacs or the pimux service. It runs in a fresh
 * clone, so it uses Node built-ins only and imports nothing compiled.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PI_PACKAGES, conflictReport, findPi, hostVersionWarning, inspectPiPackages, registerPiPackages, shell } from './pi-packages.mjs';

const OPTIONAL = { '--browser': 'browser', '--sound': 'sound' };
export const SETUP_PI_USAGE = 'Usage: phimacs setup pi [--browser] [--sound]';

function step(run, command, args, root, env) {
  const result = run(command, args, { cwd: root, stdio: 'inherit', env });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.error?.message ?? `exit ${result.status}`}`);
  }
}

/** Check Node and Pi, refuse conflicting packages, install and compile, then register. Never installs Pi. */
export function setupPi(argv, { root = fileURLToPath(new URL('../', import.meta.url)), env = process.env,
  log = console.log, run = spawnSync, node = process.versions.node } = {}) {
  for (const arg of argv) if (!OPTIONAL[arg]) throw new Error(`Unknown option: ${arg}\n${SETUP_PI_USAGE}`);
  root = fs.realpathSync(root);
  const library = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).dependencies['@earendil-works/pi-coding-agent'];
  if (Number(node.split('.')[0]) < 24) throw new Error(`Phimacs needs Node 24 or newer; this is Node ${node}`);
  const pi = findPi(env);
  if (!pi) {
    throw new Error(`No pi on PATH. Install Pi first, for example:\n  npm install --global --ignore-scripts @earendil-works/pi-coding-agent@${library}`);
  }
  const answer = run(pi, ['--version'], { encoding: 'utf8', timeout: 60_000, env });
  const version = answer.stdout?.trim();
  if (answer.error || answer.status !== 0 || !/^\d+\.\d+\.\d+/.test(version ?? '')) {
    throw new Error(`${pi} --version failed: ${(answer.error?.message ?? answer.stderr ?? '').trim() || `exit ${answer.status}`}`);
  }
  log(`Pi ${version}: ${pi}`);
  const warning = hostVersionWarning({ version, library });
  if (warning) log(`warning: ${warning}`);
  // Refuse before the long build, and again inside registration.
  const { settingsFile, registered: before, conflicts } = inspectPiPackages(root, env);
  if (conflicts.length) throw new Error(conflictReport(conflicts, settingsFile));
  // An update rebuilds every package already registered from this checkout too.
  const selected = PI_PACKAGES.filter(name => ['orchestration', 'extensions'].includes(name)
    || argv.includes(`--${name}`) || before.includes(name));

  log('Installing the npm dependencies (npm ci --ignore-scripts). This downloads the whole root graph, '
    + 'including the Pi SDK and the dependencies of unselected packages, and replaces node_modules.');
  step(run, 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], root, env);
  for (const name of ['pimux', ...selected]) {
    log(`Compiling @phimacs/${name}.`);
    step(run, 'npm', ['run', 'compile', `--workspace=@phimacs/${name}`], root, env);
  }
  registerPiPackages({ root, selected, pi: [pi], env, log, run });

  const registered = inspectPiPackages(root, env).registered;
  const phimacs = shell(path.join(root, 'bin/phimacs'));
  log([`The Pi packages ${registered.join(', ')} are registered in ${settingsFile}.`,
    'Next:',
    '  pi                              in a Herdr or tmux pane: workers, panels and forks open there',
    '  /orchestration-host status      inside Pi: the selected host',
    '  herdr integration install pi    once, for Herdr\'s agent states and finish prompts',
    '  /tools                          if you saved a tool selection, enable the new tools there',
    `${phimacs} pi also runs Pi, holding a writer claim on its conversation.`,
    `Update: let running Pi agents finish and exit them, then: git -C ${shell(root)} pull && ${phimacs} setup pi`,
    'Uninstall:',
    ...registered.map(name => `  pi remove ${shell(path.join(root, 'packages', name))}`)].join('\n'));
  return settingsFile;
}

if (process.argv[1] && pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url) {
  try { setupPi(process.argv.slice(2)); } catch (error) { console.error(`phimacs: ${error.message}`); process.exitCode = 1; }
}
