import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createClaimTestEnvironment } from "./ownership.ts";

const BIN = fileURLToPath(new URL("./bin/pimux", import.meta.url));
const GUARD = fileURLToPath(new URL("./test/reject-sdk.mjs", import.meta.url));
const OWNER = fileURLToPath(new URL("./test/import-owner.mjs", import.meta.url));

test("discovery and control commands work without importing the Pi SDK", { timeout: 15_000 }, (t) => {
  const isolated = createClaimTestEnvironment();
  t.after(() => fs.rmSync(isolated.root, { recursive: true, force: true }));
  const receipts = path.join(isolated.env.PIMUX_DIR!, "receipts");
  fs.mkdirSync(receipts, { recursive: true, mode: 0o700 });
  const receipt = { protocol: 2, muxId: "closed", operationId: "stop", state: "stopped", code: 0,
    signal: null, stoppedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(receipts, "closed.json"), JSON.stringify(receipt), { mode: 0o600 });
  for (const [args, expected] of [
    [["list", "--json"], []],
    [["lookup", "--json", "--session", path.join(isolated.sessions, "absent.jsonl")], null],
    [["receipt", "--json", "--id", "closed"], receipt],
    [["stop", "--json", "--id", "closed"], receipt],
  ] as const) {
    const result = spawnSync(process.execPath, ["--import", GUARD, BIN, ...args], {
      cwd: isolated.root, env: { ...process.env, ...isolated.env }, encoding: "utf8", timeout: 3000,
    });
    assert.equal(result.status, 0, `${args[0]}: ${result.error?.message ?? result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), expected);
  }
});

test("extensions resolve the managed host without a second Pi SDK copy", { timeout: 5000 }, () => {
  const entry = new URL("./dist/host-identity.js", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--import", GUARD, "--input-type=module", "-e",
    `import { resolveHost } from ${JSON.stringify(entry)}; console.log(typeof resolveHost);`], { encoding: "utf8", timeout: 3000 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.equal(result.stdout.trim(), "function");
});

test("the compiled detached owner exports its entry point without the Pi SDK", { timeout: 5000 }, () => {
  const result = spawnSync(process.execPath, ["--import", GUARD, OWNER], { encoding: "utf8", timeout: 3000 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.equal(result.stdout.trim(), "function");
});
