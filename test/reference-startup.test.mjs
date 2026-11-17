import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseOptions, inspectEnvironment, childEnvironment } from '../scripts/emacs-environment.mjs';
import { runtimePaths } from '../scripts/runtime.mjs';

// PHIMACS_TEST_EMACS_DIR contains prepared third-party dependencies and assets.
// Own-source packages, including Pilish, always come from this checkout.
const directory = process.env.PHIMACS_TEST_EMACS_DIR;
const selected = process.env.PHIMACS_REFERENCE_STARTUP === '1' && !!directory;
const root = path.resolve(import.meta.dirname, '..');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const lisp = value => JSON.stringify(value);

/** The test's user.el: the prepared packages, this checkout's Lisp and executables. */
function userFile(runtime) {
  return `;;; -*- lexical-binding: t; -*-\n(setq package-user-dir ${lisp(path.join(directory, 'elpa'))}
      treesit-extra-load-path (list ${lisp(path.join(directory, 'tree-sitter'))})
      ghostel-module-directory ${lisp(path.join(directory, 'ghostel/'))}
      phimacs-pi-program ${lisp(runtime.pi)}
      phimacs-pimux-program ${lisp(runtime.pimux)}
      phimacs-task-status-program ${lisp(runtime.taskStatus)})
`;
}

for (const display of ['batch', 'tty256', 'ttytrue', 'gui']) {
  test(`checkout reference startup on ${display}`, { skip: !selected, timeout: 90_000 }, async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'phimacs-reference-startup-'));
    try {
      const options = parseOptions(['--state', path.join(home, 'state')], {});
      const report = await inspectEnvironment(options);
      assert.equal(report.ok, true, JSON.stringify(report.issues));
      const runtime = runtimePaths(options.root);
      const user = path.join(home, 'user.el');
      await fs.writeFile(user, userFile(runtime));
      const evidence = path.join(home, 'evidence.json');
      const env = childEnvironment(options, { ...process.env, HOME: home, TMPDIR: home,
        XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache'),
        XDG_DATA_HOME: path.join(home, 'data'), EMACSLOADPATH: '', GDK_BACKEND: 'x11', GIT_TERMINAL_PROMPT: '0',
        PIMUX_DIR: path.join(home, 'mux'), PI_CODING_AGENT_DIR: path.join(home, 'agent'),
        PHIMACS_USER_FILE: user });
      Object.assign(env, { PHIMACS_TEST_DISPLAY: display, PHIMACS_TEST_INIT_DIR: path.join(options.root, 'emacs/config'),
        PHIMACS_TEST_EVIDENCE: evidence, TERM: display === 'ttytrue' ? 'xterm-direct' : 'xterm-256color' });
      if (display === 'ttytrue') env.COLORTERM = 'truecolor'; else delete env.COLORTERM;
      const probe = path.join(root, 'test/reference-startup.el');
      const args = ['-Q', '--no-splash', ...(display === 'batch' ? ['--batch'] : display === 'gui' ? [] : ['-nw']), '-l', probe];
      const command = display === 'gui' ? 'xvfb-run' : display === 'batch' ? options.emacs : 'script';
      const argv = display === 'gui' ? ['-a', options.emacs, ...args]
        : display === 'batch' ? args : ['-q', '-e', '-c', [options.emacs, ...args].map(quote).join(' '), '/dev/null'];
      const result = spawnSync(command, argv, { env, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
      assert.equal(result.status, 0, `${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
      const record = JSON.parse(await fs.readFile(evidence, 'utf8'));
      assert.equal(record.display, display);
      assert.equal(record.detachedRestore, true);
      assert.equal(record.authoritativeClose, true);
      assert.equal(record.taskStatus, runtime.taskStatus);
      assert.equal(record.pilish, path.join(await fs.realpath(path.join(root, 'emacs/pilish')), '/'));
      assert.equal(record.stateOwner, options.socket);
      assert.equal(record.serverSocket, options.socket);
      assert.equal(record.moduleLoaded, true);
      assert.equal(record.grammarAbi, 15);
      assert.equal(record.evil, false);
      assert.equal(record.dark, true);
      if (display === 'tty256') assert.equal(record.colourCells, 256);
      if (display === 'ttytrue') assert.equal(record.colourCells, 16777216);
      if (process.env.PHIMACS_REFERENCE_EVIDENCE) {
        await fs.mkdir(process.env.PHIMACS_REFERENCE_EVIDENCE, { recursive: true });
        await fs.copyFile(evidence, path.join(process.env.PHIMACS_REFERENCE_EVIDENCE, `reference-${display}.json`));
      }
      // Startup installs nothing into the prepared directory, creates no view or
      // agent and writes no Pi settings.
      await assert.rejects(fs.stat(path.join(home, 'state/emacs/elpa')), { code: 'ENOENT' });
      await assert.rejects(fs.stat(path.join(home, 'agent/settings.json')), { code: 'ENOENT' });
      assert.deepEqual(await fs.readdir(path.join(home, 'mux')).catch(() => []), []);
    } finally { await fs.rm(home, { recursive: true, force: true }); }
  });
}
