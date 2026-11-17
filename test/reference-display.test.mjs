import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const selected = process.env.PHIMACS_REFERENCE_DISPLAY === '1' && process.env.PHIMACS_TEST_EMACS_DIR;
for (const kind of ['gui', 'tty256', 'ttytrue']) {
  test(`reference UI on an isolated ${kind} frame`, { skip: !selected }, async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'phimacs-reference-frame-'));
    try {
      const evidence = path.join(home, 'evidence.json');
      const env = { ...process.env, HOME: home, TMPDIR: home, XDG_CONFIG_HOME: path.join(home, 'config'),
        XDG_CACHE_HOME: path.join(home, 'cache'), PHIMACS_STATE_DIR: path.join(home, 'state'),
        PHIMACS_TEST_DISPLAY: kind, PHIMACS_TEST_EVIDENCE: evidence, GDK_BACKEND: 'x11',
        TERM: kind === 'ttytrue' ? 'xterm-direct' : 'xterm-256color', EMACSLOADPATH: '' };
      delete env.PHIMACS_USER_FILE;
      delete env.WAYLAND_DISPLAY;
      delete env.DISPLAY;
      if (kind === 'ttytrue') env.COLORTERM = 'truecolor'; else delete env.COLORTERM;
      const file = path.join(root, 'test/reference-display.el');
      const command = kind === 'gui' ? 'xvfb-run' : 'script';
      const args = kind === 'gui'
        ? ['-a', 'emacs', '-Q', '--no-splash', '-l', file]
        : ['-q', '-e', '-c', `emacs -Q --no-splash -nw -l '${file.replaceAll("'", "'\\''")}'`, '/dev/null'];
      const result = spawnSync(command, args, { env, encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const record = JSON.parse(await fs.readFile(evidence, 'utf8'));
      assert.equal(record.kind, kind);
      assert.equal(record.dark, true);
      assert.equal(record.evil, false);
      if (kind !== 'gui') assert.equal(record.mouse, true);
      if (process.env.PHIMACS_REFERENCE_EVIDENCE) {
        await fs.mkdir(process.env.PHIMACS_REFERENCE_EVIDENCE, { recursive: true });
        await fs.copyFile(evidence, path.join(process.env.PHIMACS_REFERENCE_EVIDENCE, `${kind}.json`));
        if (kind === 'gui') await fs.copyFile(`${evidence}.png`, path.join(process.env.PHIMACS_REFERENCE_EVIDENCE, 'gui.png'));
      }
    } finally { await fs.rm(home, { recursive: true, force: true }); }
  });
}
