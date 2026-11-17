// `phimacs setup pi` in a fresh clone of this checkout, with a disposable agent directory and the real `pi`.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { findPi } from '../../scripts/pi-packages.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const pi = findPi(process.env);
const lane = process.env.PHIMACS_SETUP_PI === '1' ? (pi ? false : 'The lane needs the installed pi on PATH')
  : 'Set PHIMACS_SETUP_PI=1: npm ci and compilation in a fresh clone take minutes';
const git = (args, cwd = root) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** A clone of this checkout with its uncommitted changes and new files, and none of its ignored build output. */
function freshClone(t) {
  fs.mkdirSync(path.join(root, '.cache'), { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, '.cache/setup-pi-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const clone = path.join(directory, 'phimacs');
  git(['clone', '--quiet', '--no-hardlinks', root, clone], directory);
  const changed = [...git(['diff', '-z', '--name-only', 'HEAD']).split('\0'), ...git(['ls-files', '-z', '--others', '--exclude-standard']).split('\0')];
  for (const file of changed.filter(Boolean)) {
    const target = path.join(clone, file);
    fs.rmSync(target, { force: true });
    if (!fs.existsSync(path.join(root, file))) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(path.join(root, file), target, { verbatimSymlinks: true });
  }
  assert.equal(fs.existsSync(path.join(clone, 'node_modules')), false);
  assert.equal(fs.existsSync(path.join(clone, 'packages/pimux/dist')), false);
  const agent = path.join(directory, 'agent');
  const home = path.join(directory, 'home');
  for (const folder of [agent, home]) fs.mkdirSync(folder, { mode: 0o700 });
  const env = { PATH: [...new Set([pi && path.dirname(pi), path.dirname(process.execPath), '/usr/bin', '/bin'].filter(Boolean))].join(':'),
    HOME: home, PI_CODING_AGENT_DIR: agent, LANG: 'C.UTF-8', TMPDIR: os.tmpdir(), PI_OFFLINE: '1',
    npm_config_cache: process.env.PHIMACS_TEST_NPM_CACHE || path.join(os.homedir(), '.npm'),
    npm_config_prefer_offline: 'true', npm_config_update_notifier: 'false' };
  const setup = (args, overrides = {}) => spawnSync(path.join(clone, 'bin/phimacs'), ['setup', 'pi', ...args],
    { cwd: directory, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });
  return { directory, clone, agent, env, setup, settings: () => JSON.parse(fs.readFileSync(path.join(agent, 'settings.json'), 'utf8')) };
}

test('a fresh clone refuses setup pi without Pi and with an archived package, before building anything', t => {
  const { directory, clone, agent, setup } = freshClone(t);
  const missing = setup([], { PATH: [path.dirname(process.execPath), '/usr/bin', '/bin'].join(':') });
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stderr, /^phimacs: No pi on PATH\. Install Pi first, for example:\n  npm install --global --ignore-scripts @earendil-works\/pi-coding-agent@\d/);
  if (!pi) { t.diagnostic('No installed pi on PATH: the archived-package refusal was not run'); return; }
  fs.mkdirSync(path.join(directory, 'pi-ant'));
  fs.writeFileSync(path.join(directory, 'pi-ant/package.json'), JSON.stringify({ name: 'pi-ant' }));
  const settings = JSON.stringify({ packages: [path.join(directory, 'pi-ant')] });
  fs.writeFileSync(path.join(agent, 'settings.json'), settings);
  const conflict = setup([]);
  assert.equal(conflict.status, 1, conflict.stderr);
  assert.match(conflict.stderr, new RegExp(`Pi's settings are unchanged\\. Remove those copies, then run this setup again:\\n  pi remove ${path.join(directory, 'pi-ant')}\\n$`));
  assert.equal(fs.readFileSync(path.join(agent, 'settings.json'), 'utf8'), settings);
  assert.equal(fs.existsSync(path.join(clone, 'node_modules')), false, 'no npm ci before the refusal');
});

/** Extension commands of the registered packages, by name, from Pi's RPC mode without a session or inference. */
async function commands(env, cwd) {
  const child = spawn(pi, ['--mode', 'rpc', '--no-session', '--offline'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  try {
    child.stdin.write(`${JSON.stringify({ id: 'commands', type: 'get_commands' })}\n`);
    for await (const line of readline.createInterface({ input: child.stdout })) {
      const message = JSON.parse(line);
      if (message.type === 'response' && message.id === 'commands') {
        assert.equal(message.success, true, line);
        return new Map(message.data.commands.filter(command => command.source === 'extension').map(command => [command.name, command.sourceInfo.path]));
      }
    }
    throw new Error(`Pi ended without answering get_commands: ${stderr}`);
  } finally { child.kill(); }
}

test('setup pi builds, registers idempotently, adds optional packages, loads in Pi and uninstalls', { skip: lane, timeout: 900_000 }, async t => {
  const { directory, clone, agent, env, setup, settings } = freshClone(t);
  fs.mkdirSync(path.join(directory, 'tools'));
  fs.writeFileSync(path.join(directory, 'tools/package.json'), JSON.stringify({ name: 'my-tools' }));
  const unrelated = { source: path.join(directory, 'tools'), skills: [] };
  fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ packages: [unrelated] }));
  const registered = () => settings().packages.slice(1).map(source => fs.realpathSync(path.resolve(agent, source)));
  const packages = names => names.map(name => path.join(fs.realpathSync(clone), 'packages', name));

  const first = setup([]);
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  assert.deepEqual(settings().packages[0], unrelated, 'other entries and their filters stay');
  assert.deepEqual(registered(), packages(['orchestration', 'extensions']));
  assert.match(first.stdout, /downloads the whole root graph/);
  assert.match(first.stdout, new RegExp(`registered in ${path.join(agent, 'settings.json')}\\.\\nNext:\\n  pi `));
  const bytes = fs.readFileSync(path.join(agent, 'settings.json'), 'utf8');

  const rerun = setup([]);
  assert.equal(rerun.status, 0, `${rerun.stdout}\n${rerun.stderr}`);
  assert.match(rerun.stdout, /The orchestration Pi package is already registered\.\nThe extensions Pi package is already registered\./);
  assert.equal(fs.readFileSync(path.join(agent, 'settings.json'), 'utf8'), bytes, 'a rerun changes no settings');

  const optional = setup(['--browser', '--sound']);
  assert.equal(optional.status, 0, `${optional.stdout}\n${optional.stderr}`);
  assert.deepEqual(registered(), packages(['orchestration', 'extensions', 'browser', 'sound']));

  const loaded = await commands(env, directory);
  for (const [name, owner] of [['orchestration-host', 'orchestration'], ['delegate-alt', 'orchestration'], ['worktree', 'extensions'],
    ['tools', 'extensions'], ['browser', 'browser'], ['dictate-setting', 'sound']]) {
    assert.ok(loaded.get(name)?.startsWith(`${packages([owner])[0]}${path.sep}`), `/${name} from ${owner}: ${loaded.get(name)}`);
  }
  assert.equal(fs.existsSync(path.join(agent, 'voice.json')), false, 'installing sound enables no capture or backend');

  const uninstall = optional.stdout.split('Uninstall:\n')[1].trim().split('\n').map(line => line.trim());
  assert.deepEqual(uninstall, packages(['orchestration', 'extensions', 'browser', 'sound']).map(directory => `pi remove ${directory}`));
  for (const command of uninstall) execFileSync(pi, command.split(' ').slice(1), { cwd: directory, env, encoding: 'utf8' });
  assert.deepEqual(settings().packages, [unrelated]);
});
