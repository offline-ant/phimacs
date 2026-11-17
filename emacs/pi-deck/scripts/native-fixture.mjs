// Own the prepared assets, minimal installation and service used by deck native checks.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createClaimTestEnvironment } from '@phimacs/pimux/ownership';
import { resolveHost } from '@phimacs/pimux/host-identity';
import { emacsPackageArguments, selectedEmacs } from '../../../scripts/emacs-packages.mjs';

const sourceRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** Whitelist prerequisites, not provider credentials or inherited task authority. */
export function fixtureEnvironment(fixture, host, inherited = process.env) {
  const root = fixture.root;
  const env = Object.fromEntries(['LANG', 'LC_ALL', 'TERM'].filter(key => inherited[key]).map(key => [key, inherited[key]]));
  return { ...env, ...fixture.env, PATH: '/usr/bin:/bin', SHELL: '/bin/bash',
    HOME: path.join(root, 'home'), TMPDIR: path.join(root, 'tmp'),
    XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_DATA_HOME: path.join(root, 'data'), XDG_RUNTIME_DIR: path.join(root, 'run'),
    PHIMACS_STATE_DIR: path.join(root, 'state'), PIMUX_DIR: path.join(root, 'mux'),
    PI_CODING_AGENT_DIR: path.join(root, 'agent'), PI_CODING_AGENT_SESSION_DIR: fixture.sessions,
    PHIMACS_PI: host, PHIMACS_PI_EXECUTABLE: host,
    PHIMACS_NATIVE_DECK: '1', PHIMACS_TEST_NODE: process.execPath,
    // Without a session bus, GTK on the owned display autolaunches one (plus
    // accessibility services) through X, outside fixture ownership; startup and
    // exit then intermittently block on it. Select an absent private bus instead.
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(root, 'run/no-session-bus')}`,
    EMACSLOADPATH: '', DISPLAY: '', WAYLAND_DISPLAY: '', GDK_BACKEND: 'x11' };
}

/** Observe readiness or exit events; the timer is only an upper bound. */
export function waitForChild(child, predicate, label, timeout = 15_000) {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (child.failure) finish(child.failure);
      else if (predicate()) finish();
      else if (child.exitCode !== null || child.signalCode !== null) finish(new Error(`${label}: child exited: ${child.log}`));
    };
    const finish = error => {
      clearTimeout(timer);
      child.off('fixture-output', check); child.off('exit', check); child.off('error', check);
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error(`Timed out: ${label}: ${child.log}`)), timeout);
    child.on('fixture-output', check); child.on('exit', check); child.on('error', check);
    check();
  });
}

export function ownedChild(command, args, env, cwd) {
  const child = spawn(command, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  child.log = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
    child.log = (child.log + data.toString()).slice(-128 * 1024);
    child.emit('fixture-output');
  });
  child.on('error', error => { child.failure = error; });
  return child;
}

/**
 * Stop an owned child. One already asked to quit first gets `graceMs` to exit by
 * itself: a signal during Emacs's own shutdown re-enters kill-emacs from the
 * signal handler and can deadlock it. Missing the grace is reported, and the
 * child is then signalled anyway.
 */
export async function stopChild(child, label, graceMs = 0) {
  const running = () => child?.pid && child.exitCode === null && child.signalCode === null;
  const exit = timeoutMs => new Promise(resolve => {
    if (!running()) return resolve(true);
    const done = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { child.off('exit', done); resolve(false); }, timeoutMs);
    child.once('exit', done);
  });
  if (!running()) return;
  let late;
  if (graceMs) {
    if (await exit(graceMs)) return;
    late = new Error(`${label} did not exit within ${graceMs / 1000} s of its quit request: ${child.log}`);
  }
  child.kill('SIGTERM');
  const stopped = await exit(15_000) ? undefined : new Error(`${label} did not stop: ${child.log}`);
  if (late && stopped) throw new AggregateError([late, stopped], `${late.message}; ${stopped.message}`);
  if (late ?? stopped) throw late ?? stopped;
}

async function copyDirectory(source, destination) {
  await fs.cp(source, destination, { recursive: true, dereference: true, preserveTimestamps: true,
    filter: file => !file.split(path.sep).includes('.git') });
}

async function stageMinimalProduct(root, host) {
  const product = path.join(root, 'product');
  let sdk = path.dirname(host);
  while (JSON.parse(await fs.readFile(path.join(sdk, 'package.json'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '{}';
    throw error;
  })).name !== '@earendil-works/pi-coding-agent') sdk = path.dirname(sdk);
  const hostPackage = path.join(product, 'node_modules/@earendil-works/pi-coding-agent');
  const copied = new Map();
  const dependency = async (directory, name) => {
    for (;;) {
      const candidate = path.join(directory, 'node_modules', name);
      try { return await fs.realpath(candidate); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const parent = path.dirname(directory);
      if (parent === directory) return undefined;
      directory = parent;
    }
  };
  const copyPackage = async (source, destination) => {
    source = await fs.realpath(source);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    for (const [ancestor, staged] of copied) {
      if (source.startsWith(ancestor + path.sep)) {
        copied.set(source, path.join(staged, path.relative(ancestor, source)));
        break;
      }
    }
    if (copied.has(source)) {
      await fs.symlink(path.relative(path.dirname(destination), copied.get(source)), destination);
      return;
    }
    copied.set(source, destination);
    await copyDirectory(source, destination);
    const manifest = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
      const installed = path.join(destination, 'node_modules', name);
      try { await fs.access(installed); continue; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const required = await dependency(source, name);
      if (!required) {
        if (Object.hasOwn(manifest.optionalDependencies ?? {}, name)) continue;
        throw new Error(`Selected host lacks runtime dependency ${name}`);
      }
      await copyPackage(required, installed);
    }
  };
  // Preserve nested installs and acquire only declared hoisted dependencies.
  // Reused package identities link only inside this private staged product.
  await copyPackage(sdk, hostPackage);
  for (const name of ['@earendil-works/pi-ai', '@earendil-works/pi-agent-core', '@earendil-works/pi-tui', 'typebox']) {
    const source = await dependency(sdk, name);
    if (!source) throw new Error(`Selected host lacks fixture peer ${name}`);
    await copyPackage(source, path.join(product, 'node_modules', name));
  }
  await fs.mkdir(path.join(product, 'node_modules/@phimacs'), { recursive: true });
  await copyDirectory(path.join(sourceRoot, 'packages/pimux'), path.join(product, 'packages/pimux'));
  await fs.symlink('../../packages/pimux', path.join(product, 'node_modules/@phimacs/pimux'));
  for (const directory of ['emacs/pilish', 'emacs/pi-deck']) {
    await copyDirectory(path.join(sourceRoot, directory), path.join(product, directory));
  }
  await fs.mkdir(path.join(product, 'test/support'), { recursive: true });
  await fs.copyFile(path.join(sourceRoot, 'test/support/faux.ts'), path.join(product, 'test/support/faux.ts'));
  return { root: product, pi: path.join(hostPackage, path.relative(sdk, host)) };
}

/** Copy explicit acquired assets; validate their ABI by loading, not a made-up receipt. */
export async function prepareDeckFixture({ orchestration = false, inherited = process.env } = {}) {
  const packages = inherited.PHIMACS_TEST_EMACS_DIR;
  if (!packages || !path.isAbsolute(packages)) throw new Error('Provide absolute PHIMACS_TEST_EMACS_DIR; prepare assets explicitly first');
  if (!inherited.PHIMACS_PI || !path.isAbsolute(inherited.PHIMACS_PI)) throw new Error('Provide absolute PHIMACS_PI for the selected host');
  const host = resolveHost(inherited);
  const supported = JSON.parse(await fs.readFile(path.join(sourceRoot, 'package.json'), 'utf8'))
    .dependencies['@earendil-works/pi-coding-agent'];
  if (host.version !== supported) throw new Error(`Native checks require Pi ${supported}; selected ${host.version}`);
  const emacs = selectedEmacs(inherited);
  const fixture = createClaimTestEnvironment();
  try {
    const selected = orchestration ? { root: sourceRoot, pi: host.executable } : await stageMinimalProduct(fixture.root, host.executable);
    const env = { ...fixtureEnvironment(fixture, selected.pi, inherited), PATH: emacs.path };
    for (const directory of ['HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR', 'PI_CODING_AGENT_DIR', 'PHIMACS_STATE_DIR']) {
      await fs.mkdir(env[directory], { recursive: true, mode: 0o700 });
    }
    await fs.writeFile(path.join(env.PI_CODING_AGENT_DIR, 'settings.json'), '{}\n', { mode: 0o600 });
    const assets = path.join(fixture.root, 'prepared/emacs');
    await copyDirectory(packages, assets);
    const deck = path.join(selected.root, 'emacs/pi-deck');
    const pilish = path.join(selected.root, 'emacs/pilish');
    const pimux = path.join(selected.root, 'packages/pimux/bin/pimux');
    const taskStatus = orchestration ? path.join(selected.root, 'packages/orchestration/dist/worker-task-cli.js') : undefined;
    for (const entry of ['control', 'launch-entry', 'owner-entry', 'host-identity']) {
      await fs.access(path.join(selected.root, 'packages/pimux/dist', `${entry}.js`)).catch(() => {
        throw new Error('Compiled pimux inputs are incomplete; finish compilation before native checks');
      });
    }
    Object.assign(env, { PHIMACS_TEST_DECK: deck, PHIMACS_PIMUX_EXECUTABLE: pimux,
      PHIMACS_NATIVE_PILISH: pilish, PHIMACS_FAUX_EXTENSION: path.join(selected.root, 'test/support/faux.ts') });
    if (taskStatus) env.PHIMACS_TASK_STATUS_EXECUTABLE = taskStatus;
    const created = { ...fixture, env, root: fixture.root, product: selected.root, assets, deck, pilish, pimux, pi: selected.pi, taskStatus,
      orchestration: orchestration ? path.join(selected.root, 'packages/orchestration/emacs') : undefined,
      emacs: emacs.emacs, client: emacs.client };
    const probe = spawnSync(created.emacs, ['-Q', '--batch', ...emacsPackageArguments(assets),
      '--eval', `(progn (setq native-comp-jit-compilation nil ghostel-module-auto-install nil)
        (dolist (language '(markdown markdown-inline))
          (unless (treesit-language-available-p language) (error "Missing or unloadable grammar: %s" language)))
        (module-load ${JSON.stringify(path.join(assets, 'ghostel/ghostel-module.so'))}))`],
    { env, encoding: 'utf8', timeout: 30_000 });
    if (probe.error || probe.status !== 0) throw new Error(`Prepared native assets are unusable: ${probe.error?.message ?? probe.stderr}`);
    return created;
  } catch (error) {
    await fs.rm(fixture.root, { recursive: true, force: true }).catch(cleanup => { throw new AggregateError([error, cleanup], 'Preparation and cleanup failed'); });
    throw error;
  }
}

export async function startFixtureService(fixture) {
  const service = ownedChild(fixture.pimux, ['serve'], fixture.env, fixture.root);
  fixture.service = service;
  await waitForChild(service, () => service.log.includes('pimux service ready'), 'owned pimux readiness');
}

/** Stop exact discovered runtimes before their service; retain evidence on uncertainty. */
export async function cleanupDeckFixture(fixture, failure, verifyWriters) {
  const errors = failure ? [failure] : [];
  const run = args => {
    const result = spawnSync(fixture.pimux, args, { env: fixture.env, encoding: 'utf8', timeout: 30_000 });
    if (result.error || result.status !== 0) throw new Error(`Synthetic pimux ${args[0]} failed: ${result.error?.message ?? result.stderr}`);
    return JSON.parse(result.stdout);
  };
  try {
    const records = run(['list', '--json']);
    if (!Array.isArray(records)) throw new Error('Invalid synthetic discovery');
    for (const runtime of records) {
      try {
        if (!runtime.socket?.startsWith(`${fixture.root}/mux/`)) throw new Error('Refusing foreign runtime cleanup');
        run(['stop', '--json', '--id', runtime.muxId]);
      } catch (error) { errors.push(error); }
    }
    if (run(['list', '--json']).length) throw new Error('Synthetic discovery still has live runtimes');
  } catch (error) { errors.push(error); }
  try { await fs.access(path.join(fixture.root, 'deck-panels-pending')); throw new Error('Native panel cleanup is unacknowledged'); }
  catch (error) { if (error.code !== 'ENOENT') errors.push(error); }
  try { await stopChild(fixture.service, 'owned pimux service'); } catch (error) { errors.push(error); }
  try { await verifyWriters?.(); } catch (error) { errors.push(error); }
  if (errors.length) {
    if (fixture.service?.log) {
      try { await fs.writeFile(path.join(fixture.root, 'pimux-serve.log'), fixture.service.log, { mode: 0o600 }); }
      catch (error) { errors.push(error); }
    }
    throw new AggregateError(errors, `Native evidence retained at ${fixture.root}: ${errors.map(String).join('; ')}`);
  }
  await fs.rm(fixture.root, { recursive: true, force: true });
}
