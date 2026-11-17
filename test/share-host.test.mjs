import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { listShares, prepareShare, releaseShare, shareDirectory } from '../scripts/share-host.mjs';

const refusal = /must be your own non-symlink directory with mode 0700/;

test('a symlinked share directory is refused however its path ends', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phimacs-share-host-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'target');
  fs.mkdirSync(target, { mode: 0o700 });
  const link = path.join(directory, 'link');
  fs.symlinkSync(target, link);
  for (const suffix of ['', '/', '//', '/.', '/./', '/././/']) {
    const env = { PHIMACS_SHARE_DIR: `${link}${suffix}` };
    assert.equal(shareDirectory(env), link, suffix);
    await assert.rejects(prepareShare(env), refusal, suffix);
    assert.throws(() => listShares(env), refusal, suffix);
    assert.throws(() => releaseShare('laptop-00000001', env), refusal, suffix);
  }
  // The same suffixes on the real directory select it.
  for (const suffix of ['/.', '/./']) {
    assert.equal(await prepareShare({ PHIMACS_SHARE_DIR: `${target}${suffix}` }), target, suffix);
  }
  assert.equal(shareDirectory({ PHIMACS_SHARE_DIR: `${directory}/./a/../b/` }), `${directory}/b`);
});
