// Opt-in installed dependency closures: no checkout links or unpublished-name fetches.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).dependencies['@earendil-works/pi-coding-agent'];
const skip = process.env.PHIMACS_INSTALL === '1' ? false : 'Set PHIMACS_INSTALL=1 with explicit disposable PHIMACS_TEST_NPM_CACHE and PHIMACS_TEST_NPM_SEED';

function run(command, args, cwd, env) {
  return execFileSync(command, args, { cwd, env, encoding: 'utf8', timeout: 55_000, maxBuffer: 16 * 1024 * 1024 });
}

function environment(directory, cache) {
  const env = Object.fromEntries(['PATH', 'LANG', 'LC_ALL'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  return { ...env, HOME: path.join(directory, 'home'), XDG_CONFIG_HOME: path.join(directory, 'config'),
    XDG_CACHE_HOME: path.join(directory, 'cache'), XDG_DATA_HOME: path.join(directory, 'data'),
    NPM_CONFIG_USERCONFIG: '/dev/null', NPM_CONFIG_GLOBALCONFIG: path.join(directory, 'global-npmrc'),
    NPM_CONFIG_CACHE: cache, NPM_CONFIG_UPDATE_NOTIFIER: 'false', PI_OFFLINE: '1' };
}

async function ready(service, diagnostic) {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(`Service readiness timed out: ${diagnostic.text}`)), 15_000);
    const finish = error => {
      clearTimeout(timeout);
      service.stdout.off('data', receive);
      service.off('error', failed);
      service.off('exit', exited);
      if (error) reject(error); else resolve();
    };
    const receive = chunk => {
      diagnostic.text += chunk.toString();
      if (diagnostic.text.includes('pimux service ready')) finish();
    };
    const failed = error => finish(error);
    const exited = (code, signal) => finish(new Error(`Service exited before readiness (${code}/${signal}): ${diagnostic.text}`));
    service.stdout.on('data', receive);
    service.stderr.on('data', chunk => { diagnostic.text += chunk.toString(); });
    service.once('error', failed);
    service.once('exit', exited);
  });
}

for (const managed of [false, true]) {
  test(`offline installed ${managed ? 'managed' : 'minimal'} closure works without optional packages`, { skip, timeout: 180_000 }, async t => {
    const cache = process.env.PHIMACS_TEST_NPM_CACHE;
    assert.ok(path.isAbsolute(cache ?? '') && fs.statSync(cache).isDirectory(), 'Prepare an absolute disposable npm cache first');
    const seed = process.env.PHIMACS_TEST_NPM_SEED;
    assert.ok(path.isAbsolute(seed ?? ''), 'Prepare an absolute disposable stock-Pi seed project first');
    const seedManifest = JSON.parse(fs.readFileSync(path.join(seed, 'package.json'), 'utf8'));
    const seedLock = JSON.parse(fs.readFileSync(path.join(seed, 'package-lock.json'), 'utf8'));
    assert.deepEqual(seedManifest.dependencies, { '@earendil-works/pi-coding-agent': version });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phimacs-install-'));
    const prefix = path.join(directory, 'installation');
    const artifacts = path.join(directory, 'artifacts');
    const env = environment(directory, cache);
    for (const folder of [prefix, artifacts, env.HOME, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.XDG_DATA_HOME]) fs.mkdirSync(folder, { mode: 0o700 });
    fs.writeFileSync(path.join(prefix, 'package.json'), JSON.stringify({ name: 'phimacs-install-check', private: true, dependencies: seedManifest.dependencies }));
    // Preserve the selected public host's exact resolved dependency URLs. No seed
    // node_modules are copied; npm extracts fresh packages from the isolated cache.
    seedLock.name = 'phimacs-install-check';
    seedLock.packages[''].name = 'phimacs-install-check';
    fs.writeFileSync(path.join(prefix, 'package-lock.json'), JSON.stringify(seedLock));
    let service;
    let namespace;
    let receipt;
    let runtimeEnv;
    let pimux;
    const diagnostic = { text: '' };
    t.after(async () => {
      const errors = [];
      if (receipt) {
        try { run(process.execPath, [pimux, 'stop', '--json', '--id', receipt.muxId], prefix, runtimeEnv); }
        catch (error) { errors.push(error); }
      }
      if (service && service.exitCode === null && service.signalCode === null) {
        service.kill('SIGTERM');
        try { await once(service, 'exit', { signal: AbortSignal.timeout(15_000) }); }
        catch (error) { errors.push(error); }
      }
      if (errors.length) {
        t.diagnostic(`Retained failed installation inputs at ${directory}; service: ${diagnostic.text}`);
        throw new AggregateError(errors, 'Installed closure cleanup failed');
      }
      if (namespace) fs.rmSync(namespace.root, { recursive: true, force: true });
      fs.rmSync(directory, { recursive: true, force: true });
    });

    // .npmrc disables prepack: compile each selected prerequisite explicitly.
    const names = ['pimux', ...(managed ? ['orchestration'] : [])];
    const tarballs = [];
    for (const name of names) {
      run('npm', ['run', 'compile', `--workspace=@phimacs/${name}`], root, env);
      const [pack] = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', `--workspace=@phimacs/${name}`, '--pack-destination', artifacts], root, env));
      assert.equal(pack.name, `@phimacs/${name}`);
      assert.ok(pack.files.some(file => file.path === 'LICENSE'));
      if (name === 'orchestration') {
        for (const file of ['host-modules.ts', 'emacs/pi-orchestration.el', 'shell/osc133.bash']) assert.ok(pack.files.some(entry => entry.path === file), file);
      }
      tarballs.push(path.join(artifacts, pack.filename));
    }
    run('npm', ['install', '--prefix', prefix, '--ignore-scripts', '--offline', '--registry=http://127.0.0.1:9',
      '--replace-registry-host=never', '--legacy-peer-deps', '--no-audit', '--no-fund', '--save-exact', ...tarballs], directory, env);

    const requireInstalled = createRequire(path.join(prefix, 'package.json'));
    for (const name of names.map(name => `@phimacs/${name}`)) {
      const resolved = fs.realpathSync(requireInstalled.resolve(`${name}/package.json`));
      assert.ok(resolved.startsWith(prefix + path.sep), `${name} escaped its installation: ${resolved}`);
    }
    for (const name of ['browser', 'sound', 'extensions', ...(!managed ? ['orchestration'] : [])]) {
      assert.throws(() => requireInstalled.resolve(`@phimacs/${name}/package.json`), { code: 'MODULE_NOT_FOUND' });
      assert.equal(fs.existsSync(path.join(prefix, 'node_modules/@phimacs', name)), false);
    }
    for (const name of names) {
      const packageDirectory = path.join(prefix, 'node_modules/@phimacs', name);
      assert.equal(fs.lstatSync(packageDirectory).isSymbolicLink(), false);
      assert.equal(fs.existsSync(path.join(packageDirectory, 'node_modules/@earendil-works/pi-coding-agent')), false);
      assert.ok(fs.statSync(path.join(packageDirectory, 'LICENSE')).isFile());
    }
    pimux = fs.realpathSync(path.join(prefix, 'node_modules/.bin/pimux'));
    const pi = fs.realpathSync(path.join(prefix, 'node_modules/.bin/pi'));
    assert.ok(pi.startsWith(path.join(prefix, 'node_modules/@earendil-works/pi-coding-agent') + path.sep));
    assert.equal(run(process.execPath, [pi, '--version'], prefix, env).trim(), version);

    const { createClaimTestEnvironment } = requireInstalled('@phimacs/pimux/ownership');
    namespace = createClaimTestEnvironment();
    const agent = path.join(directory, 'agent');
    fs.mkdirSync(agent, { mode: 0o700 });
    const report = path.join(directory, 'registration.json');
    const fixture = path.join(prefix, 'installation-fixture.ts');
    fs.copyFileSync(path.join(root, 'test/install/fixture.ts'), fixture);
    const orchestration = path.join(prefix, 'node_modules/@phimacs/orchestration');
    fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({
      packages: managed ? [orchestration] : [], defaultProvider: 'installation', defaultModel: 'one',
      compaction: { enabled: false }, retry: { enabled: false },
    }));
    runtimeEnv = { ...env, ...namespace.env, PHIMACS_STATE_DIR: path.join(namespace.root, 'pimux-state'),
      PHIMACS_PI: pi, PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: namespace.sessions,
      PHIMACS_INSTALLATION_REPORT: report, PI_NESTED: '' };
    assert.deepEqual(JSON.parse(run(process.execPath, [pimux, 'list', '--json'], prefix, runtimeEnv)), []);
    if (managed) {
      const taskStatus = fs.realpathSync(path.join(prefix, 'node_modules/.bin/phimacs-task-status'));
      const state = JSON.parse(run(process.execPath, [taskStatus, '--id', 'installation-no-task', '--json'], prefix, runtimeEnv));
      assert.equal(state, null, 'missing task evidence is unknown, not successful cleanup');
    }
    service = spawn(process.execPath, [pimux, 'serve'], { cwd: prefix, env: runtimeEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    await ready(service, diagnostic);
    receipt = JSON.parse(run(process.execPath, [pimux, 'start', '--json', '--', pi, '--mode', 'rpc',
      '--session', path.join(namespace.sessions, 'installed.jsonl'), '--no-context-files', '--no-skills',
      '--no-prompt-templates', '--offline', '-e', fixture,
      ...(!managed ? ['--no-extensions'] : [])], prefix, runtimeEnv));
    assert.equal(receipt.outcome, 'started');
    assert.ok(receipt.sessionFile.startsWith(namespace.sessions + path.sep));
    run(process.execPath, [pimux, 'agent', 'prompt', receipt.muxId, '--wait', '--', '/installation-check'], prefix, runtimeEnv);
    const registration = JSON.parse(fs.readFileSync(report, 'utf8'));
    assert.ok(registration.commands.includes('installation-check'));
    assert.ok(registration.commands.includes('pimux-tree-navigate'));
    if (managed) {
      for (const tool of ['do', 'panel-start', 'wait']) assert.ok(registration.tools.includes(tool), `Missing installed tool ${tool}: ${JSON.stringify(registration)}`);
    } else {
      assert.equal(registration.tools.includes('do'), false);
      assert.equal(registration.tools.includes('panel-start'), false);
    }
    run(process.execPath, [pimux, 'agent', 'prompt', receipt.muxId, '--wait', '--', 'installed prompt'], prefix, runtimeEnv);
    assert.match(run(process.execPath, [pimux, 'agent', 'read', receipt.muxId, '--format', 'text'], prefix, runtimeEnv), /installed reply/);
    t.diagnostic(`Installed stock Pi ${version} and ${names.join(' + ')} from tarballs; offline unpublished closure, actual CLI/extension loading and faux inference passed.`);
  });
}
