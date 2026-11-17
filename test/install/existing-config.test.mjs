import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { selectedEmacs } from '../../scripts/emacs-packages.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const prepared = process.env.PHIMACS_TEST_EMACS_DIR;
// The documented public source; the fixture serves it from a local snapshot.
const repositoryUrl = 'https://github.com/offline-ant/phimacs';
const release = 'v0.1.0';
const dependencies = ['dash', 'cond-let', 'llama', 'with-editor', 'magit-section',
  'markdown-mode', 'markdown-table-wrap', 'md-ts-mode', 'ghostel'];

function run(command, args, options) {
  const result = spawnSync(command, args, {
    ...options, encoding: 'utf8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0,
    `${command} ${args.join(' ')}\n${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function treeDigest(directory) {
  const hash = createHash('sha256');
  const visit = folder => {
    for (const name of fs.readdirSync(folder).sort()) {
      const file = path.join(folder, name);
      const status = fs.statSync(file);
      hash.update(`${path.relative(directory, file)}\0${status.mode}\0${status.mtimeMs}\0`);
      if (status.isDirectory()) visit(file);
      else hash.update(fs.readFileSync(file));
    }
  };
  visit(directory);
  return hash.digest('hex');
}

test('existing Emacs installs the released packages with literal use-package :vc and no archives', {
  skip: prepared ? false : 'Set PHIMACS_TEST_EMACS_DIR to prepared disposable dependencies',
  timeout: 20_000,
}, t => {
  assert.ok(path.isAbsolute(prepared), 'Prepared Emacs input must be absolute');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phimacs-existing-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const repository = path.join(directory, 'snapshot');
  const packages = path.join(directory, 'emacs/elpa');
  const dependencyState = path.join(directory, 'prepared');
  const dependencyPackages = path.join(dependencyState, 'emacs/elpa');
  const home = path.join(directory, 'home');
  for (const destination of [repository, packages, dependencyPackages, home]) {
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  }
  const emacs = selectedEmacs();
  const env = {
    PATH: emacs.path, HOME: home, TMPDIR: directory, LANG: 'C.UTF-8',
    XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache'),
    XDG_DATA_HOME: path.join(home, 'data'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ALLOW_PROTOCOL: 'file', GIT_TERMINAL_PROMPT: '0',
    PHIMACS_INSTALL_PACKAGES: packages,
    PHIMACS_INSTALL_DEPENDENCIES: dependencyPackages,
    PHIMACS_INSTALL_DEPENDENCY_INIT: path.join(directory, 'dependencies.el'),
    PHIMACS_INSTALL_PACKAGE_INIT: path.join(directory, 'packages.el'),
    PHIMACS_INSTALL_PI: path.join(directory, 'tools/pi'),
    PHIMACS_INSTALL_PIMUX: path.join(directory, 'tools/pimux'),
    PHIMACS_INSTALL_REPOSITORY: pathToFileURL(repository).href,
  };
  // Only the selected source packages are staged.  This disposable Git commit
  // and its release tag are a fixture snapshot, never a product commit or ref.
  const sources = ['emacs/pilish', 'emacs/pi-deck'];
  for (const source of sources) {
    fs.cpSync(path.join(root, source), path.join(repository, source), {
      recursive: true, dereference: true,
      filter: file => !['.git', '.cache', 'dist', 'node_modules', '__pycache__'].includes(path.basename(file))
        && !/\.(?:elc|eln|pyc)$/.test(file),
    });
  }
  for (const sentinel of ['boundary.el', 'emacs/config/probe.el', 'other-package/probe.el']) {
    const destination = path.join(repository, sentinel);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, '(eval-when-compile (error "Compiled outside :lisp-dir"))\n');
  }
  run('git', ['init', '-q', repository], { env });
  run('git', ['-C', repository, 'add', ...sources, 'boundary.el', 'emacs/config/probe.el', 'other-package/probe.el'], { env });
  run('git', ['-C', repository, '-c', 'user.name=Phimacs install fixture',
    '-c', 'user.email=fixture@invalid', '-c', 'core.hooksPath=/dev/null',
    'commit', '-q', '-m', 'Lisp snapshot'], { env });
  run('git', ['-C', repository, '-c', 'user.name=Phimacs install fixture', '-c', 'user.email=fixture@invalid',
    'tag', '-a', '-m', 'Release', release], { env });
  env.PHIMACS_INSTALL_REVISION = run('git', ['-C', repository, 'rev-parse', `${release}^{commit}`], { env });
  // A later branch commit proves that the documented tag, not the default branch, is installed.
  run('git', ['-C', repository, '-c', 'user.name=Phimacs install fixture', '-c', 'user.email=fixture@invalid',
    '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--allow-empty', '-m', 'After the release'], { env });
  for (const dependency of dependencies) {
    const source = path.join(prepared, 'elpa', dependency);
    assert.ok(fs.statSync(source).isDirectory(), `Missing prepared dependency: ${source}`);
    fs.cpSync(source, path.join(dependencyPackages, dependency), {
      recursive: true, dereference: true,
      filter: file => !['.git', '.cache'].includes(path.basename(file)),
    });
  }
  for (const asset of ['ghostel', 'tree-sitter']) {
    fs.cpSync(path.join(prepared, asset), path.join(dependencyState, 'emacs', asset), {
      recursive: true, dereference: true,
    });
  }
  fs.mkdirSync(path.join(directory, 'tools'));
  for (const executable of [env.PHIMACS_INSTALL_PI, env.PHIMACS_INSTALL_PIMUX]) {
    fs.writeFileSync(executable, '#!/bin/sh\nprintf "Unexpected runtime launch\\n" >&2\nexit 1\n', { mode: 0o700 });
  }
  // Execute the documented forms, substituting only their installation values.
  const installation = fs.readFileSync(path.join(root, 'docs/install.md'), 'utf8');
  const section = installation.split('## Existing Emacs configuration\n')[1].split('\n## ')[0];
  const snippets = [...section.matchAll(/```elisp\n([\s\S]*?)\n```/g)].map(match => match[1]);
  assert.equal(snippets.length, 2, 'Expected dependency activation and package installation snippets');
  assert.match(snippets[1], new RegExp(`:url "${repositoryUrl}" :rev "${release.replaceAll('.', '\\.')}"`));
  // The public URL maps to the local snapshot; the documented tag stays literal.
  const substitutions = {
    '/absolute/private-state': dependencyState,
    [repositoryUrl]: env.PHIMACS_INSTALL_REPOSITORY,
    '/absolute/selected/pi': env.PHIMACS_INSTALL_PI,
    '/absolute/phimacs/packages/pimux/bin/pimux': env.PHIMACS_INSTALL_PIMUX,
  };
  for (const [index, destination] of [env.PHIMACS_INSTALL_DEPENDENCY_INIT, env.PHIMACS_INSTALL_PACKAGE_INIT].entries()) {
    let snippet = snippets[index];
    for (const [placeholder, value] of Object.entries(substitutions)) snippet = snippet.replaceAll(placeholder, value);
    fs.writeFileSync(destination, snippet + '\n');
  }
  const dependencyDigest = treeDigest(dependencyState);
  run(emacs.emacs, ['-Q', '--batch',
    '--eval', `(setq user-emacs-directory ${JSON.stringify(path.join(directory, 'emacs/'))})`,
    '-l', path.join(root, 'test/install/existing-config.el')], { env });
  assert.equal(treeDigest(dependencyState), dependencyDigest, 'Installation must not write prepared dependencies/assets');
  assert.deepEqual(fs.readdirSync(dependencyPackages).sort(), [...dependencies].sort());
  assert.equal(fs.existsSync(path.join(repository, '.git/refs/heads')), true);
  assert.equal(fs.existsSync(path.join(home, '.emacs.d')), false);
});

test('pi-deck refuses to load against a Pilish without the detached runtime', {
  skip: prepared ? false : 'Set PHIMACS_TEST_EMACS_DIR to prepared disposable dependencies',
  timeout: 20_000,
}, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phimacs-stock-pilish-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  // A stock archive Pilish provides `pilish' but not `pilish-runtime'.
  fs.writeFileSync(path.join(directory, 'pilish.el'), "(provide 'pilish)\n");
  const result = spawnSync(selectedEmacs().emacs, ['-Q', '--batch', '-L', directory,
    '-L', path.join(root, 'emacs/pi-deck'), '--eval', "(require 'pi-deck)"],
  { encoding: 'utf8', timeout: 15_000, env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory } });
  assert.notEqual(result.status, 0, 'pi-deck must not load without pilish-runtime');
  assert.match(result.stderr, /pilish-runtime/);
});
