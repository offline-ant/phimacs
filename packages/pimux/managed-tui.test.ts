import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import childProcess, { type ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { runManagedTui } from "./managed-tui.ts";
import { acquireClaim, lookupClaim, releaseClaim } from "./ownership.ts";
import { readProcessIdentity } from "./process-identity.ts";
import { PI, prepare, startMux } from "./test/harness.ts";

test("managed export leases the actual input before Pi's repair-capable open and releases after exit", { timeout: 30_000 }, async (t) => {
  const input = prepare();
  t.after(() => fs.rmSync(input.dir, { recursive: true, force: true }));
  fs.writeFileSync(input.sessionFile, fs.readFileSync(input.sessionFile, "utf8").trimEnd(), { mode: 0o600 });
  const output = path.join(input.dir, "export.html");
  const result = await runManagedTui({ command: PI, args: ["--export", input.sessionFile, output], cwd: input.dir, env: input.env });
  assert.deepEqual(result, { code: 0, signal: null });
  assert.ok(fs.existsSync(output));
  assert.ok(fs.readFileSync(input.sessionFile, "utf8").endsWith("\n"));
  assert.equal(lookupClaim(input.sessionFile, input.isolation.options), undefined);
});

test("managed export cannot open another runtime's claimed input", { timeout: 30_000 }, async (t) => {
  const run = await startMux(t);
  const output = path.join(run.dir, "refused.html");
  const before = fs.readFileSync(run.sessionFile);
  await assert.rejects(runManagedTui({ command: PI, args: ["--export", run.sessionFile, output], cwd: run.dir, env: run.env }), /Session is owned/);
  assert.equal(fs.existsSync(output), false);
  assert.deepEqual(fs.readFileSync(run.sessionFile), before);
});

test("repeated --export leases Pi's last effective input, never an earlier unowned decoy", async (t) => {
  const input = prepare();
  t.after(() => fs.rmSync(input.dir, { recursive: true, force: true }));
  const decoy = path.join(input.isolation.sessions, "decoy.jsonl");
  fs.copyFileSync(input.sessionFile, decoy);
  fs.writeFileSync(input.sessionFile, fs.readFileSync(input.sessionFile, "utf8").trimEnd(), { mode: 0o600 });
  const before = fs.readFileSync(input.sessionFile);
  const claim = acquireClaim(input.sessionFile, { id: "held-export", kind: "lease", wrapper: readProcessIdentity(process.pid)!, pi: null }, input.isolation.options);
  const output = path.join(input.dir, "refused.html");
  try {
    await assert.rejects(runManagedTui({ command: PI, args: ["--export", decoy, "--export", input.sessionFile, output], cwd: input.dir, env: input.env }), /Session is owned/);
    assert.deepEqual(fs.readFileSync(input.sessionFile), before);
    assert.equal(fs.existsSync(output), false);
  } finally { releaseClaim(claim); }
});

test("export passes its claimed canonical input even when the original alias retargets before spawn", { timeout: 30_000 }, async (t) => {
  const input = prepare();
  t.after(() => fs.rmSync(input.dir, { recursive: true, force: true }));
  const other = path.join(input.isolation.sessions, "held.jsonl");
  const alias = path.join(input.isolation.sessions, "export-alias.jsonl");
  fs.writeFileSync(other, fs.readFileSync(input.sessionFile, "utf8").trimEnd(), { mode: 0o600 });
  fs.symlinkSync(input.sessionFile, alias);
  const before = fs.readFileSync(other);
  const claim = acquireClaim(other, { id: "held-alias-export", kind: "lease", wrapper: readProcessIdentity(process.pid)!, pi: null }, input.isolation.options);
  const original = childProcess.spawn;
  childProcess.spawn = ((...args: Parameters<typeof childProcess.spawn>) => {
    fs.unlinkSync(alias); fs.symlinkSync(other, alias);
    return Reflect.apply(original, childProcess, args) as ChildProcess;
  }) as typeof original;
  syncBuiltinESMExports();
  try {
    const result = await runManagedTui({ command: PI, args: ["--export", alias, path.join(input.dir, "export.html")], cwd: input.dir, env: input.env });
    assert.equal(result.code, 0);
    assert.deepEqual(fs.readFileSync(other), before, "Pi must not repair the newly retargeted unowned input");
    assert.equal(lookupClaim(other, input.isolation.options)?.token, claim.token);
  } finally {
    childProcess.spawn = original; syncBuiltinESMExports(); releaseClaim(claim);
  }
});

test("a post-spawn child error cannot release a native lease before actual exit", { timeout: 30_000 }, async (t) => {
  const input = prepare();
  t.after(() => fs.rmSync(input.dir, { recursive: true, force: true }));
  const original = childProcess.spawn;
  let spawned: ChildProcess | undefined;
  let observedSpawn: () => void = () => {};
  const started = new Promise<void>((resolve) => { observedSpawn = resolve; });
  childProcess.spawn = ((...args: Parameters<typeof childProcess.spawn>) => {
    const child = Reflect.apply(original, childProcess, args) as ChildProcess;
    spawned = child;
    child.once("spawn", () => { child.kill("SIGSTOP"); observedSpawn(); });
    return child;
  }) as typeof original;
  syncBuiltinESMExports();
  try {
    const running = runManagedTui({ command: PI, args: ["--export", input.sessionFile, path.join(input.dir, "export.html")], cwd: input.dir, env: input.env });
    const rejected = assert.rejects(running, /post-spawn test error/);
    await started;
    spawned!.emit("error", new Error("post-spawn test error"));
    assert.ok(lookupClaim(input.sessionFile, input.isolation.options), "a live stopped child still owns its input");
    spawned!.kill("SIGCONT");
    await rejected;
    assert.equal(lookupClaim(input.sessionFile, input.isolation.options), undefined);
  } finally {
    spawned?.kill("SIGCONT");
    childProcess.spawn = original; syncBuiltinESMExports();
  }
});

test("managed native launcher refuses an RPC stdio lifetime bridge", async (t) => {
  const input = prepare();
  t.after(() => fs.rmSync(input.dir, { recursive: true, force: true }));
  await assert.rejects(runManagedTui({ command: PI, args: input.piArgs, cwd: input.dir, env: input.env }), /not managed TUI passthrough/);
  assert.equal(lookupClaim(input.sessionFile, input.isolation.options), undefined);
});
