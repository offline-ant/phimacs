// Pi package registration shared by `phimacs setup` and `phimacs setup pi`, without running Pi or npm.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
// Pi's own source classification and Git parser, from the SDK the checkout pins.
import { parseGitUrl } from '../node_modules/@earendil-works/pi-coding-agent/dist/utils/git.js';
import { isLocalPath } from '../node_modules/@earendil-works/pi-coding-agent/dist/utils/paths.js';
import { gitRepository, inspectPiPackages, registerPiPackages } from '../scripts/pi-packages.mjs';
import { setupPi } from '../scripts/setup-pi.mjs';

function sandbox(t, checkout = 'checkout') {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'phimacs-pi-packages-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const write = (file, content) => {
    const target = path.join(directory, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content));
    return target;
  };
  const link = (file, target) => { fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true }); fs.symlinkSync(path.join(directory, target), path.join(directory, file)); return path.join(directory, file); };
  write(`${checkout}/package.json`, { name: 'phimacs', dependencies: { '@earendil-works/pi-coding-agent': '1.5.2' } });
  for (const name of ['pimux', 'orchestration', 'extensions', 'browser', 'sound']) write(`${checkout}/packages/${name}/package.json`, { name: `@phimacs/${name}` });
  const agent = path.join(directory, 'agent');
  fs.mkdirSync(agent);
  const env = { HOME: path.join(directory, 'home'), PI_CODING_AGENT_DIR: agent, PATH: '' };
  const settings = value => write('agent/settings.json', value);
  return { directory, root: path.join(directory, checkout), agent, env, write, link, settings };
}

test('only other copies of @phimacs packages and the archived packages they replaced conflict', t => {
  const { directory, root, env, write, link, settings } = sandbox(t);
  write('old/pi-ant/package.json', { name: 'pi-ant' });
  const panels = write('old/pi-ant/orchestration/extensions/panels.ts', '');
  write('old/pi-ant/orchestration/package.json', { name: 'pi-orchestration' });
  const copyQuote = write('old/pi-ant/extensions/copy-quote/index.ts', '');
  write('old/pi-ant/extensions/copy-quote/package.json', { name: 'copy-quote' });
  write('home/clones/pi-browser/package.json', { name: 'pi-browser' });
  write('other-clone/packages/orchestration/package.json', { name: '@phimacs/orchestration' });
  const otherCopy = link('links/orchestration', 'other-clone/packages/orchestration');
  const ourExtensions = link('links/extensions', 'checkout/packages/extensions');
  write('tools/package.json', { name: 'my-tools' });
  const unrelated = write('tools/extension.ts', '');
  write('checkout/packages/sound/dist/extension.js', '');
  settings({
    packages: [
      '../checkout/packages/orchestration',
      { source: ourExtensions, extensions: [] },
      path.join(directory, 'old/pi-ant'),
      '~/clones/pi-browser',
      otherCopy,
      'npm:@phimacs/browser@0.1.0',
      'npm:pi-orchestration',
      { source: path.join(directory, 'tools'), skills: [] },
      path.join(directory, 'deleted/pi-ant'),
    ],
    extensions: [panels, `+${copyQuote}`, `!${panels}`, `-${copyQuote}`, 'builtin:mcp', unrelated,
      path.join(root, 'packages/sound/dist/extension.js')],
  });
  const { settingsFile, registered, conflicts } = inspectPiPackages(root, env);
  assert.equal(settingsFile, path.join(directory, 'agent/settings.json'));
  assert.deepEqual(registered, ['orchestration', 'extensions'], 'relative paths and symlinks to this checkout are its own registration');
  assert.deepEqual(conflicts.map(({ source, name, remove }) => [source, name, remove]), [
    [path.join(directory, 'old/pi-ant'), 'pi-ant', `pi remove ${path.join(directory, 'old/pi-ant')}`],
    ['~/clones/pi-browser', 'pi-browser', `pi remove ${path.join(directory, 'home/clones/pi-browser')}`],
    [otherCopy, '@phimacs/orchestration', `pi remove ${otherCopy}`],
    ['npm:@phimacs/browser@0.1.0', '@phimacs/browser', 'pi remove npm:@phimacs/browser@0.1.0'],
    ['npm:pi-orchestration', 'pi-orchestration', 'pi remove npm:pi-orchestration'],
    [panels, 'pi-orchestration', `delete ${JSON.stringify(panels)} from "extensions" in ${settingsFile}`],
    [`+${copyQuote}`, 'pi-ant', `delete ${JSON.stringify(`+${copyQuote}`)} from "extensions" in ${settingsFile}`],
    [path.join(root, 'packages/sound/dist/extension.js'), '@phimacs/sound',
      `delete ${JSON.stringify(path.join(root, 'packages/sound/dist/extension.js'))} from "extensions" in ${settingsFile}`],
  ]);
});

test('Git sources conflict exactly when Pi 1.5.2 parses them as an archived repository', t => {
  const { root, env, settings } = sandbox(t);
  const archived = ['git:github.com/offline-ant/pi-ant@feature/quota-wait', 'git:github.com/offline-ant/pi-ant#v1',
    'git:github.com/offline-ant/pi-browser/', 'https://github.com/offline-ant/pi-ant', 'https://github.com/offline-ant/pi-browser.git#main',
    'git:git@github.com:offline-ant/pi-ant.git@v1', 'ssh://git@github.com/offline-ant/pi-browser.git', 'git:github.com/offline-ant/pi-ant.git/',
    'https://github.com/offline-ant/pi-ant@release/1.0', 'git:code.example.org/team/pi-ant@topic/a#b'];
  // Pi reads the last three as local paths, which do not exist here.
  const other = ['git:github.com/offline-ant/pi-ant-private', 'git:github.com/someone/pi-tools@pi-ant',
    'git@github.com:offline-ant/pi-ant.git', 'github:offline-ant/pi-ant', 'HTTPS://github.com/offline-ant/pi-ant'];
  for (const source of [...archived, ...other]) {
    const parsed = isLocalPath(source) ? null : parseGitUrl(source);
    if (parsed) assert.equal(gitRepository(source), parsed.path.split('/').at(-1), `${source} names Pi's repository ${parsed.path}`);
    assert.equal(['pi-ant', 'pi-browser'].includes(parsed?.path.split('/').at(-1)), archived.includes(source), `Pi parses ${source} as ${parsed?.path ?? 'a local path'}`);
  }
  settings({ packages: [...archived, ...other] });
  assert.deepEqual(inspectPiPackages(root, env).conflicts.map(({ source, remove }) => [source, remove]),
    archived.map(source => [source, `pi remove ${source.includes('#') ? `'${source}'` : source}`]));
});

test('auto-loaded user extensions conflict through symlinks and copies, respecting Pi\'s exclusions', t => {
  const { directory, root, agent, env, write, link, settings } = sandbox(t);
  write('old/pi-ant/package.json', { name: 'pi-ant', pi: { extensions: ['./extensions/lints.ts', './extensions/missing.ts'] } });
  write('old/pi-ant/extensions/lints.ts', '');
  write('old/pi-ant/orchestration/package.json', { name: 'pi-orchestration' });
  write('old/pi-ant/orchestration/index.ts', '');
  const herdr = write('agent/extensions/herdr-agent-state.ts', '// installed by herdr\n');
  const symlink = link('agent/extensions/pi-ant', 'old/pi-ant');
  write('agent/extensions/browser/package.json', { name: 'pi-browser', pi: { extensions: ['./dist/extension.js'] } });
  write('agent/extensions/browser/dist/extension.js', '');
  for (const name of ['.hidden', 'ignored', 'excluded', 'forced-out']) link(`agent/extensions/${name}`, 'old/pi-ant/orchestration');
  write('agent/extensions/.gitignore', '# Pi skips these\nignored/\n');
  write('agent/extensions/notes.md', '');
  fs.mkdirSync(path.join(agent, 'extensions/empty'));
  settings({ extensions: ['!extensions/excluded/**', '-extensions/forced-out/index.ts'] });
  const extensions = path.join(directory, 'agent/extensions');
  assert.deepEqual(inspectPiPackages(root, env).conflicts.map(({ source, name, remove }) => [source, name, remove]).sort(), [
    [path.join(extensions, 'browser'), 'pi-browser', `move ${path.join(extensions, 'browser')} out of ${extensions}`],
    [symlink, 'pi-ant', `rm ${symlink}`],
  ].sort());
  assert.ok(fs.existsSync(herdr), 'Herdr\'s own integration is no conflict and stays');
  fs.rmSync(symlink);
  fs.rmSync(path.join(extensions, 'browser'), { recursive: true });
  write('agent/extensions/index.ts', '');
  link('agent/extensions/pi-ant', 'old/pi-ant');
  assert.deepEqual(inspectPiPackages(root, env).conflicts, [], 'a directory with its own index loads only that index');
});

test('printed commands quote a checkout path with spaces and an apostrophe', t => {
  const { root, env, write, settings } = sandbox(t, "Rob's Pi checkout");
  const pi = write('bin/pi', '#!/bin/sh\n');
  fs.chmodSync(pi, 0o755);
  env.PATH = path.dirname(pi);
  settings({ packages: [path.join(root, 'packages/orchestration')] });
  const log = [];
  setupPi([], { root, env, run: (command) => command === pi ? { status: 0, stdout: '1.5.2\n' } : { status: 0 }, log: line => log.push(line) });
  const words = command => execFileSync('/bin/sh', ['-c', `printf '%s\\n' ${command}`], { encoding: 'utf8' }).trimEnd().split('\n');
  assert.deepEqual(words(log.find(line => line.startsWith('Registering the extensions')).split(': ')[1]),
    ['pi', 'install', path.join(root, 'packages/extensions')]);
  const summary = log.at(-1).split('\n');
  assert.deepEqual(words(summary.find(line => line.startsWith('Update:')).split('then: ')[1].replace(' && ', ' ')),
    ['git', '-C', root, 'pull', path.join(root, 'bin/phimacs'), 'setup', 'pi']);
  assert.deepEqual(summary.slice(summary.indexOf('Uninstall:') + 1).map(line => words(line.trim())),
    [['pi', 'remove', path.join(root, 'packages/orchestration')]]);
});

test('registration installs only missing packages by absolute path and refuses before any change on conflict', t => {
  const { directory, root, env, write, settings } = sandbox(t);
  const calls = [];
  const run = (command, args) => { calls.push([command, ...args]); return { status: 0 }; };
  const log = [];
  settings({ packages: ['../checkout/packages/orchestration'] });
  assert.equal(registerPiPackages({ root, selected: ['orchestration', 'extensions'], pi: ['/bin/pi'], env, run, log: line => log.push(line) }),
    path.join(directory, 'agent/settings.json'));
  assert.deepEqual(calls, [['/bin/pi', 'install', path.join(root, 'packages/extensions')]]);
  assert.deepEqual(log, ['The orchestration Pi package is already registered.',
    `Registering the extensions Pi package: pi install ${path.join(root, 'packages/extensions')}`]);
  assert.throws(() => registerPiPackages({ root, selected: ['browser'], pi: ['/bin/pi'], env, run: () => ({ status: 3 }), log: () => {} }),
    /pi install .*packages\/browser failed: exit 3/);
  write('old/pi-browser/package.json', { name: 'pi-browser' });
  const before = settings({ packages: [path.join(directory, 'old/pi-browser')] });
  calls.length = 0;
  assert.throws(() => registerPiPackages({ root, selected: ['browser'], pi: ['/bin/pi'], env, run, log: () => {} }),
    new RegExp(`already loads other copies[^]*Pi's settings are unchanged\\. Remove those copies, then run this setup again:\\n  pi remove ${path.join(directory, 'old/pi-browser')}$`));
  assert.deepEqual(calls, []);
  assert.equal(fs.readFileSync(before, 'utf8'), JSON.stringify({ packages: [path.join(directory, 'old/pi-browser')] }));
  settings('{ not json');
  assert.throws(() => inspectPiPackages(root, env), /Cannot read Pi settings .*settings\.json/);
});

test('setup pi checks Node and Pi and refuses conflicts before installing anything', t => {
  const { directory, root, env, write, settings } = sandbox(t);
  const calls = [];
  const run = (command, args) => { calls.push([command, ...args]); return command.endsWith('/pi') ? { status: 0, stdout: '1.6.0\n' } : { status: 0 }; };
  assert.throws(() => setupPi(['--emacs'], { root, env, run, log: () => {} }), /Unknown option: --emacs\nUsage: phimacs setup pi \[--browser\] \[--sound\]/);
  assert.throws(() => setupPi([], { root, env, run, log: () => {}, node: '22.19.0' }), /needs Node 24 or newer; this is Node 22\.19\.0/);
  assert.throws(() => setupPi([], { root, env, run, log: () => {} }),
    /No pi on PATH\. Install Pi first, for example:\n  npm install --global --ignore-scripts @earendil-works\/pi-coding-agent@1\.5\.2/);
  assert.deepEqual(calls, []);
  const pi = write('bin/pi', '#!/bin/sh\n');
  fs.chmodSync(pi, 0o755);
  env.PATH = `relative:${path.dirname(pi)}`;
  write('old/pi-ant/package.json', { name: 'pi-ant' });
  settings({ packages: [path.join(directory, 'old/pi-ant')] });
  assert.throws(() => setupPi([], { root, env, run, log: () => {} }), /already loads other copies/);
  assert.deepEqual(calls, [[pi, '--version']], 'a conflict stops setup before npm');
  settings({ packages: ['../checkout/packages/orchestration'] });
  calls.length = 0;
  const log = [];
  assert.equal(setupPi(['--browser'], { root, env, run, log: line => log.push(line) }), path.join(directory, 'agent/settings.json'));
  assert.deepEqual(calls, [[pi, '--version'], ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
    ...['pimux', 'orchestration', 'extensions', 'browser'].map(name => ['npm', 'run', 'compile', `--workspace=@phimacs/${name}`]),
    [pi, 'install', path.join(root, 'packages/extensions')], [pi, 'install', path.join(root, 'packages/browser')]]);
  assert.equal(log[1], "warning: Global Pi 1.6.0 differs from the checkout's SDK 1.5.2; run npm run update:pi -- 1.6.0");
  assert.match(log[2], /downloads the whole root graph/);
  settings({ packages: ['../checkout/packages/sound'] });
  calls.length = 0;
  setupPi([], { root, env, run, log: () => {} });
  assert.deepEqual(calls.filter(call => call[2] === 'compile').map(call => call[3]),
    ['pimux', 'orchestration', 'extensions', 'sound'].map(name => `--workspace=@phimacs/${name}`), 'an update rebuilds registered packages');
});
