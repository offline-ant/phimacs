import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { createClaimTestEnvironment, type ClaimTestEnvironment } from "./ownership.ts";
import { processIdentityStatus } from "./process-identity.ts";
import { runtimePaths } from "./runtime-files.ts";
import { writePrivateJson } from "./private-files.ts";
import { lookupTerminalReceipt, stopRuntime, type TerminalReceipt } from "./runtime.ts";
import { BIN, startMux } from "./test/harness.ts";

const ID = "receipt-test";
const terminal: TerminalReceipt = { protocol: 2, muxId: ID, operationId: "operation-test", state: "stopped",
  code: null, signal: "SIGTERM", stoppedAt: "2026-01-02T03:04:05.000Z" };

function isolated(t: TestContext): ClaimTestEnvironment {
  const input = createClaimTestEnvironment();
  t.after(() => fs.rmSync(input.root, { recursive: true, force: true }));
  return input;
}

function cli(args: string[], env: NodeJS.ProcessEnv) {
  const result = spawnSync(process.execPath, [BIN, "receipt", "--json", ...args], {
    env: { ...process.env, ...env }, encoding: "utf8", timeout: 5000,
  });
  if (result.error) throw result.error;
  return result;
}

function tree(directory: string): unknown[] {
  return fs.readdirSync(directory).sort().map((name) => {
    const file = path.join(directory, name);
    const stat = fs.lstatSync(file);
    return [name, stat.mode, stat.mtimeMs, stat.ctimeMs,
      stat.isDirectory() ? tree(file) : fs.readFileSync(file, "utf8")];
  });
}

test("receipt lookup reports no evidence without creating runtime directories or changing claims", { timeout: 20_000 }, (t) => {
  const input = isolated(t);
  const before = tree(input.root);
  assert.equal(lookupTerminalReceipt(ID, input.env), null);
  const missingRoot = cli(["--id", ID], input.env);
  assert.equal(missingRoot.status, 0, missingRoot.stderr);
  assert.equal(missingRoot.stdout, "null\n");
  assert.deepEqual(tree(input.root), before);

  fs.mkdirSync(input.env.PIMUX_DIR!, { mode: 0o700 });
  const withoutReceipts = tree(input.root);
  assert.equal(lookupTerminalReceipt(ID, input.env), null);
  assert.equal(cli(["--id", ID], input.env).stdout, "null\n");
  assert.deepEqual(tree(input.root), withoutReceipts);
});

test("receipt lookup validates and returns retained terminal evidence without rewriting it", { timeout: 20_000 }, (t) => {
  const input = isolated(t);
  const files = runtimePaths(ID, terminal.operationId, input.env);
  writePrivateJson(files.receipt, terminal);
  const before = tree(input.root);
  assert.deepEqual(lookupTerminalReceipt(ID, input.env), terminal);
  const found = cli(["--id", ID], input.env);
  assert.equal(found.status, 0, found.stderr);
  assert.deepEqual(JSON.parse(found.stdout), terminal);
  assert.equal(lookupTerminalReceipt("absent", input.env), null);
  assert.deepEqual(tree(input.root), before);
});

test("receipt lookup rejects malformed identities and missing CLI identity explicitly", { timeout: 20_000 }, (t) => {
  const input = isolated(t);
  for (const id of ["", "../escape", "/absolute", "id/child", "id\\child", "id\u0000", "id\n", ".", "id.json"]) {
    assert.throws(() => lookupTerminalReceipt(id, input.env), /Invalid runtime identity/);
  }
  for (const args of [[], ["--id"], ["--id", "--json"], ["--id", "../escape"]]) {
    const refused = cli(args, input.env);
    assert.equal(refused.status, 1);
    assert.equal(refused.stdout, "");
    assert.match(refused.stderr, /Usage: pimux receipt|Invalid runtime identity/);
  }
  assert.equal(fs.existsSync(input.env.PIMUX_DIR!), false);
});

test("receipt lookup rejects malformed JSON, mismatched identities and incomplete terminal records", { timeout: 20_000 }, (t) => {
  const input = isolated(t);
  const files = runtimePaths(ID, terminal.operationId, input.env);
  for (const value of [null, [], {}, { ...terminal, protocol: 1 }, { ...terminal, muxId: "another-runtime" },
    { ...terminal, state: "committed" }, { ...terminal, operationId: "../operation" }, { ...terminal, operationId: undefined },
    { ...terminal, code: -1 }, { ...terminal, code: 1.5 }, { ...terminal, code: "0" }, { ...terminal, code: undefined },
    { ...terminal, signal: 1 }, { ...terminal, signal: "" }, { ...terminal, signal: undefined },
    { ...terminal, stoppedAt: "not a date" }, { ...terminal, stoppedAt: undefined }]) {
    writePrivateJson(files.receipt, value);
    assert.throws(() => lookupTerminalReceipt(ID, input.env), /Invalid retained terminal receipt/);
  }
  fs.writeFileSync(files.receipt, "{", { mode: 0o600 });
  assert.throws(() => lookupTerminalReceipt(ID, input.env), SyntaxError);
  const refused = cli(["--id", ID], input.env);
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout, "");
});

test("receipt lookup refuses symlink files, directories and unsafe permissions", { timeout: 20_000 }, (t) => {
  const input = isolated(t);
  const files = runtimePaths(ID, terminal.operationId, input.env);
  const retained = path.join(input.root, "retained.json");
  writePrivateJson(retained, terminal);
  fs.symlinkSync(retained, files.receipt);
  assert.throws(() => lookupTerminalReceipt(ID, input.env), /ELOOP/);
  const refused = cli(["--id", ID], input.env);
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout, "");
  fs.unlinkSync(files.receipt);
  fs.symlinkSync(path.join(input.root, "missing"), files.receipt);
  assert.throws(() => lookupTerminalReceipt(ID, input.env), /ELOOP/);
  fs.unlinkSync(files.receipt);
  fs.mkdirSync(files.receipt, { mode: 0o700 });
  assert.throws(() => lookupTerminalReceipt(ID, input.env), /unsafe/);
  fs.rmdirSync(files.receipt);
  writePrivateJson(files.receipt, terminal);

  for (const target of [files.directory, path.dirname(files.receipt), files.receipt]) {
    const mode = fs.statSync(target).mode & 0o777;
    fs.chmodSync(target, mode | 0o040);
    assert.throws(() => lookupTerminalReceipt(ID, input.env), /unsafe/);
    fs.chmodSync(target, mode);
  }
  const linkedRoot = path.join(input.root, "linked-mux");
  fs.symlinkSync(files.directory, linkedRoot);
  assert.throws(() => lookupTerminalReceipt(ID, { ...input.env, PIMUX_DIR: linkedRoot }), /unsafe/);
  const receipts = path.dirname(files.receipt);
  const moved = path.join(input.root, "moved-receipts");
  fs.renameSync(receipts, moved);
  fs.symlinkSync(moved, receipts);
  assert.throws(() => lookupTerminalReceipt(ID, input.env), /unsafe/);
});

test("receipt lookup rejects a FIFO without waiting for a writer", { timeout: 20_000 }, (t) => {
  const input = isolated(t);
  const files = runtimePaths(ID, terminal.operationId, input.env);
  execFileSync("mkfifo", ["-m", "600", files.receipt], { timeout: 5000 });
  assert.throws(() => lookupTerminalReceipt(ID, input.env), /unsafe/);
  const refused = cli(["--id", ID], input.env);
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout, "");
});

test("receipt lookup never stops a live faux runtime and finds its receipt only after actual stop", { timeout: 20_000 }, async (t) => {
  const run = await startMux(t);
  const before = tree(run.isolation.claims);
  assert.equal(lookupTerminalReceipt(run.receipt.muxId, run.env), null);
  const live = cli(["--id", run.receipt.muxId], run.env);
  assert.equal(live.status, 0, live.stderr);
  assert.equal(live.stdout, "null\n");
  assert.equal(processIdentityStatus(run.ownerIdentity), "alive");
  assert.equal(processIdentityStatus(run.piIdentity), "alive");
  assert.deepEqual(tree(run.isolation.claims), before);
  await run.first.run("still running after receipt lookup");

  const stopped = await stopRuntime(run.receipt.muxId, { env: run.env });
  assert.equal(processIdentityStatus(run.piIdentity), "dead");
  assert.deepEqual(lookupTerminalReceipt(run.receipt.muxId, run.env), stopped);
  const closed = cli(["--id", run.receipt.muxId], run.env);
  assert.equal(closed.status, 0, closed.stderr);
  assert.deepEqual(JSON.parse(closed.stdout), stopped);
});
