import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const dist = path.join(import.meta.dirname, "dist");

test("panel entry scripts reached through a symlinked directory run their entry point", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "orchestration-entry-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const link = path.join(directory, "linked");
  fs.symlinkSync(dist, link);
  for (const entry of ["panel-owner.js", "panel-runtime-owner.js", "panel-close.js"]) {
    // The entry point itself refuses a null binding/target; a skipped entry point exits 0 silently.
    const result = spawnSync(process.execPath, [path.join(link, entry), "null"], {
      env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory }, encoding: "utf8", timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, `${entry} ran its entry point through the symlink: ${result.stderr}`);
  }
});
