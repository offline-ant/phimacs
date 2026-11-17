import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const MODULE = new URL("./host-modules.ts", import.meta.url).href;

// Hooks are process-global, so each case runs in its own Node process.
function run(script: string): string {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("later native imports receive the shared objects; the first share of a specifier wins", () => {
  const output = run(`
    import { shareHostModules } from ${JSON.stringify(MODULE)};
    const sdk = { parse: () => "host", "default": "default export" };
    shareHostModules({ "fake-host-sdk": sdk });
    shareHostModules({ "fake-host-sdk": { parse: () => "copy" }, "fake-host-ui": { width: 7 } });
    const imported = await import("fake-host-sdk");
    const ui = await import("fake-host-ui");
    console.log(JSON.stringify([imported.parse === sdk.parse, imported.parse(), imported.default, ui.width]));
  `);
  assert.deepEqual(JSON.parse(output), [true, "host", "default export", 7]);
});

test("unshared specifiers resolve as before", () => {
  const output = run(`
    import { shareHostModules } from ${JSON.stringify(MODULE)};
    shareHostModules({ "fake-host-sdk": { value: 1 } });
    await import("never-installed-package").then(() => console.log("loaded"), (error) => console.log(error.code));
  `);
  assert.equal(output, "ERR_MODULE_NOT_FOUND");
});
