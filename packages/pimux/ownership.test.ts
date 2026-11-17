import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fork, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  acquireClaim, canonicalSessionPath, ClaimConflictError, ClaimStoreError, createClaimTestEnvironment,
  lookupClaim, reconcileClaim, releaseClaim, updateClaim, type ClaimOwner, type ClaimRecord, type ClaimTestEnvironment,
} from "./ownership.ts";
import { processExists, processIdentityStatus, readProcessIdentity, type ProcessIdentity } from "./process-identity.ts";

const self = readProcessIdentity(process.pid)!;
const owner = (id = "test", changes: Partial<ClaimOwner> = {}): ClaimOwner => ({ id, kind: "rpc", wrapper: self, pi: null, protocol: 2, ...changes });
interface Reply { id?: string; ready?: boolean; ok?: boolean; conflict?: boolean; token?: string; owner?: ClaimOwner; identity?: ProcessIdentity; error?: string; claim?: ClaimRecord }
interface Peer { child: ChildProcess; identity: ProcessIdentity; request: (type: string, file?: string) => Promise<Reply> }

function setup(t: TestContext): ClaimTestEnvironment & { children: ChildProcess[] } {
  const environment = createClaimTestEnvironment();
  const children: ChildProcess[] = [];
  t.after(async () => {
    await Promise.all(children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }));
    fs.rmSync(environment.root, { recursive: true, force: true });
  });
  return { ...environment, children };
}

async function peer(environment: ReturnType<typeof setup>): Promise<Peer> {
  const child = fork(path.join(import.meta.dirname, "test", "ownership-child.ts"), [], {
    execArgv: [], env: { ...process.env, ...environment.env }, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  environment.children.push(child);
  let diagnostics = "";
  child.stderr?.on("data", (chunk: Buffer) => { diagnostics += chunk.toString(); });
  const ready = await new Promise<Reply>((resolve, reject) => {
    const failed = (code: number | null): void => reject(new Error(`Claim peer exited before readiness (${code}): ${diagnostics}`));
    child.once("exit", failed);
    child.once("error", reject);
    child.once("message", (message: Reply) => { child.off("exit", failed); resolve(message); });
  });
  assert.equal(ready.ready, true);
  assert.ok(ready.identity);
  let serial = 0;
  return { child, identity: ready.identity, request: (type, file) => new Promise((resolve, reject) => {
    const id = String(++serial);
    const timer = setTimeout(() => { child.off("message", response); reject(new Error(`Claim peer timed out: ${diagnostics}`)); }, 20_000);
    const response = (message: Reply): void => {
      if (message.id !== id) return;
      clearTimeout(timer);
      child.off("message", response);
      resolve(message);
    };
    child.on("message", response);
    child.send({ id, type, file });
  }) };
}

function conflict(action: () => unknown, token?: string): ClaimConflictError {
  let caught: unknown;
  try { action(); } catch (error) { caught = error; }
  assert.ok(caught instanceof ClaimConflictError, String(caught));
  if (token) assert.equal(caught.claim.token, token);
  return caught;
}

test("Linux process identity uses PID, boot and start time; exited identities are dead", () => {
  assert.ok(self.bootId.length > 0);
  assert.match(self.startTime, /^\d+$/);
  assert.equal(processIdentityStatus(self), "alive");
  assert.equal(processExists(self), true);
  assert.equal(processExists(process.pid), true);
  assert.equal(processIdentityStatus({ ...self, startTime: `${BigInt(self.startTime) + 1n}` }), "dead");
  assert.equal(processIdentityStatus({ ...self, bootId: "another-boot" }), "dead");
  assert.equal(processExists({ ...self, bootId: "another-boot" }), false);
  const unknown = { ...self, pid: Number.MAX_SAFE_INTEGER };
  assert.equal(processIdentityStatus(unknown), "unknown");
  assert.equal(processExists(unknown), true);
  assert.throws(() => readProcessIdentity(unknown.pid));
});

test("claims absent intended paths before creation and publishes private files", (t) => {
  const env = setup(t);
  const file = path.join(env.sessions, "not-created", "session.jsonl");
  const handle = acquireClaim(file, owner(), env.options);
  assert.equal(handle.file, file);
  assert.equal(fs.existsSync(file), false);
  assert.equal(lookupClaim(file, env.options)?.token, handle.token);
  conflict(() => acquireClaim(file, owner("other"), env.options), handle.token);
  for (const dir of [env.claims, path.join(env.claims, "keys"), path.join(env.claims, "records"), path.join(env.claims, "tickets")]) {
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  }
  for (const name of fs.readdirSync(path.join(env.claims, "records"))) assert.equal(fs.statSync(path.join(env.claims, "records", name)).mode & 0o777, 0o600);
  releaseClaim(handle);
  assert.equal(lookupClaim(file, env.options), undefined);
});

test("canonical parent aliases and final symlinks share one claim", (t) => {
  const env = setup(t);
  const targetDir = path.join(env.sessions, "real");
  fs.mkdirSync(targetDir);
  fs.symlinkSync(targetDir, path.join(env.sessions, "directory-link"));
  const file = path.join(targetDir, "session.jsonl");
  fs.writeFileSync(file, "synthetic\n");
  const symlink = path.join(env.sessions, "session-link");
  fs.symlinkSync(file, symlink);
  const alias = path.join(env.sessions, "directory-link", "session.jsonl");
  assert.equal(canonicalSessionPath(alias), file);
  const handle = acquireClaim(symlink, owner(), env.options);
  for (const candidate of [file, alias, symlink]) {
    assert.equal(lookupClaim(candidate, env.options)?.token, handle.token);
    conflict(() => acquireClaim(candidate, owner("other"), env.options), handle.token);
  }
  reconcileClaim(handle);
  releaseClaim(handle);
});

test("dangling intended symlink resolves to its future destination", (t) => {
  const env = setup(t);
  const target = path.join(env.sessions, "future.jsonl");
  const link = path.join(env.sessions, "future-link");
  fs.symlinkSync(target, link);
  const handle = acquireClaim(link, owner(), env.options);
  assert.equal(handle.file, target);
  fs.writeFileSync(target, "synthetic\n");
  reconcileClaim(handle);
  conflict(() => acquireClaim(target, owner("other"), env.options), handle.token);
  releaseClaim(handle);
});

test("hardlink aliases are excluded, including materialization before explicit reconciliation", (t) => {
  const env = setup(t);
  const file = path.join(env.sessions, "session.jsonl");
  const handle = acquireClaim(file, owner(), env.options);
  fs.writeFileSync(file, "synthetic\n");
  const alias = path.join(env.sessions, "hardlink.jsonl");
  fs.linkSync(file, alias);
  assert.equal(lookupClaim(alias, env.options)?.token, handle.token);
  conflict(() => acquireClaim(alias, owner("other"), env.options), handle.token);
  reconcileClaim(handle);
  releaseClaim(handle);
  const next = acquireClaim(alias, owner("other"), env.options);
  conflict(() => acquireClaim(file, owner(), env.options), next.token);
  releaseClaim(next);
});

test("retargeting a claimed alias refuses lookup/reconciliation without stealing either target", (t) => {
  const env = setup(t);
  const a = path.join(env.sessions, "a.jsonl");
  const b = path.join(env.sessions, "b.jsonl");
  const link = path.join(env.sessions, "alias");
  fs.writeFileSync(a, "a\n"); fs.writeFileSync(b, "b\n");
  fs.symlinkSync(a, link);
  const handle = acquireClaim(link, owner(), env.options);
  fs.unlinkSync(link); fs.symlinkSync(b, link);
  assert.equal(conflict(() => lookupClaim(link, env.options), handle.token).code, "CLAIM_PATH_CHANGED");
  assert.equal(conflict(() => reconcileClaim(handle), handle.token).code, "CLAIM_PATH_CHANGED");
  assert.equal(lookupClaim(b, env.options), undefined);
  assert.equal(fs.readFileSync(a, "utf8"), "a\n");
  releaseClaim(handle);
});

test("atomic same-path replacement retains both inode claims until release", (t) => {
  const env = setup(t);
  const file = path.join(env.sessions, "session.jsonl");
  const oldAlias = path.join(env.sessions, "old-hardlink.jsonl");
  fs.writeFileSync(file, "old\n"); fs.linkSync(file, oldAlias);
  const handle = acquireClaim(file, owner(), env.options);
  const temp = path.join(env.sessions, "replacement.jsonl");
  fs.writeFileSync(temp, "new\n"); fs.renameSync(temp, file);
  reconcileClaim(handle);
  conflict(() => acquireClaim(oldAlias, owner("other"), env.options), handle.token);
  conflict(() => acquireClaim(file, owner("other"), env.options), handle.token);
  assert.equal(lookupClaim(file, env.options)?.inodes.length, 2);
  releaseClaim(handle);
});

test("ownership transfer has no claim gap and invalidates stale launcher handles", (t) => {
  const env = setup(t);
  const file = path.join(env.sessions, "session.jsonl");
  const handle = acquireClaim(file, owner("launcher"), env.options);
  const old = structuredClone(handle);
  const runtime = owner("runtime", { socket: path.join(env.root, "mux", "runtime.sock"), operationId: "operation" });
  updateClaim(handle, runtime);
  assert.equal(lookupClaim(file, env.options)?.token, handle.token);
  assert.deepEqual(lookupClaim(file, env.options)?.owner, runtime);
  assert.throws(() => releaseClaim(old), /current owner/);
  assert.throws(() => updateClaim(old, owner("stale")), /current owner/);
  assert.throws(() => releaseClaim({ ...handle, token: "a".repeat(64) }), /Unreadable session claim/);
  conflict(() => acquireClaim(file, owner("competitor"), env.options), handle.token);
  releaseClaim(handle);
});

test("dead/reused wrapper claims are reclaimed but live or uncertain Pi owners are retained", async (t) => {
  const env = setup(t);
  const file = path.join(env.sessions, "session.jsonl");
  const dead = { ...self, startTime: "0" };
  const stale = acquireClaim(file, owner("old", { wrapper: dead }), env.options);
  assert.equal(lookupClaim(file, env.options), undefined);
  const child = await peer(env);
  const livePi = acquireClaim(file, owner("dead-wrapper-live-pi", { wrapper: dead, pi: child.identity }), env.options);
  conflict(() => acquireClaim(file, owner("other"), env.options), livePi.token);
  assert.throws(() => releaseClaim(stale), /Unreadable session claim/);
  releaseClaim(livePi);
  const unknown = acquireClaim(file, owner("uncertain", { wrapper: dead, pi: { ...self, pid: Number.MAX_SAFE_INTEGER } }), env.options);
  conflict(() => acquireClaim(file, owner("other"), env.options), unknown.token);
  releaseClaim(unknown);
});

test("synthetic overrides cannot reach outside paths, symlinks or hardlinks", (t) => {
  const env = setup(t);
  const outside = fs.mkdtempSync("/tmp/phimacs-outside-");
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const foreign = path.join(outside, "synthetic.jsonl");
  fs.writeFileSync(foreign, "outside synthetic fixture\n");
  for (const file of [foreign, path.join(env.root, "not-sessions.jsonl")]) assert.throws(() => acquireClaim(file, owner(), env.options), /outside their sessions/);
  const link = path.join(env.sessions, "outside-link");
  fs.symlinkSync(foreign, link);
  assert.throws(() => acquireClaim(link, owner(), env.options), /outside their sessions/);
  const hardlink = path.join(env.sessions, "outside-hardlink");
  fs.linkSync(foreign, hardlink);
  assert.throws(() => acquireClaim(hardlink, owner(), env.options), /hardlink outside/);
  assert.equal(fs.readFileSync(foreign, "utf8"), "outside synthetic fixture\n");
  assert.equal(fs.readdirSync(path.join(env.claims, "records")).length, 0);
});

test("unmarked, public-permission and symlinked test namespaces fail closed", (t) => {
  const env = setup(t);
  const unmarked = fs.mkdtempSync("/tmp/phimacs-test-");
  t.after(() => fs.rmSync(unmarked, { recursive: true, force: true }));
  assert.throws(() => acquireClaim(path.join(unmarked, "sessions", "file"), owner(), { testRoot: unmarked }), /test marker/);
  fs.chmodSync(env.root, 0o755);
  assert.throws(() => lookupClaim(path.join(env.sessions, "file"), env.options), /0700/);
  fs.chmodSync(env.root, 0o700);
  fs.chmodSync(path.join(env.root, ".phimacs-test"), 0o644);
  assert.throws(() => lookupClaim(path.join(env.sessions, "file"), env.options), /test marker/);
  fs.chmodSync(path.join(env.root, ".phimacs-test"), 0o600);
  assert.throws(() => createClaimTestEnvironment(path.join(env.root, "nested")), ClaimStoreError);
});

test("interrupted index publication is repaired before an absent pathname can be claimed", (t) => {
  const env = setup(t);
  const file = path.join(env.sessions, "not-yet-created.jsonl");
  const handle = acquireClaim(file, owner(), env.options);
  for (const name of fs.readdirSync(path.join(env.claims, "keys"))) fs.unlinkSync(path.join(env.claims, "keys", name));
  conflict(() => acquireClaim(file, owner("other"), env.options), handle.token);
  assert.equal(lookupClaim(file, env.options)?.token, handle.token);
  releaseClaim(handle);
});

test("dead transaction participants are reclaimed; malformed participants fail closed", (t) => {
  const env = setup(t);
  const id = "a".repeat(64);
  const ticket = path.join(env.claims, "tickets", `${id}.json`);
  fs.writeFileSync(ticket, JSON.stringify({ schema: 1, id, process: { ...self, startTime: "0" }, choosing: true, number: 0 }), { mode: 0o600 });
  const file = path.join(env.sessions, "session.jsonl");
  const handle = acquireClaim(file, owner(), env.options);
  assert.equal(fs.existsSync(ticket), false);
  releaseClaim(handle);
  fs.writeFileSync(ticket, "broken\\n", { mode: 0o600 });
  assert.throws(() => acquireClaim(file, owner(), env.options), /Unreadable transaction ticket/);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(ticket, "utf8"), "broken\\n");
});

test("private store corruption does not prove that a live owner is dead", (t) => {
  const env = setup(t);
  const file = path.join(env.sessions, "session.jsonl");
  const handle = acquireClaim(file, owner(), env.options);
  const record = path.join(env.claims, "records", `${handle.token}.json`);
  const bytes = fs.readFileSync(record);
  fs.writeFileSync(record, "invalid\n");
  assert.throws(() => lookupClaim(file, env.options), /Unreadable session claim/);
  assert.equal(fs.readFileSync(record, "utf8"), "invalid\n");
  fs.writeFileSync(record, bytes);
  fs.chmodSync(record, 0o644);
  assert.throws(() => lookupClaim(file, env.options), /Unreadable session claim/);
  fs.chmodSync(record, 0o600);
  releaseClaim(handle);
});

test("independent simultaneous processes elect exactly one writer across hardlink/symlink aliases", async (t) => {
  const env = setup(t);
  const file = path.join(env.sessions, "session.jsonl");
  fs.writeFileSync(file, "sentinel\n");
  const hardlink = path.join(env.sessions, "hardlink.jsonl");
  const symlink = path.join(env.sessions, "symlink.jsonl");
  fs.linkSync(file, hardlink); fs.symlinkSync(file, symlink);
  const aliases = [file, hardlink, symlink];
  const peers = await Promise.all(Array.from({ length: 12 }, () => peer(env)));
  const replies = await Promise.all(peers.map((child, index) => child.request("acquire", aliases[index % aliases.length])));
  assert.equal(replies.filter((reply) => reply.ok).length, 1, JSON.stringify(replies));
  assert.equal(replies.filter((reply) => reply.conflict).length, 11, JSON.stringify(replies));
  const winner = replies.findIndex((reply) => reply.ok);
  assert.equal(lookupClaim(file, env.options)?.token, replies[winner].token);
  assert.equal(fs.readFileSync(file, "utf8"), "sentinel\n");
  await peers[winner].request("release");
  const next = await peers[(winner + 1) % peers.length].request("acquire", hardlink);
  assert.equal(next.ok, true, next.error);
});

test("verified process exit reclaims stale records while obsolete capabilities cannot unlink replacements", async (t) => {
  const env = setup(t);
  const file = path.join(env.sessions, "session.jsonl");
  const first = await peer(env);
  const original = await first.request("acquire", file);
  assert.equal(original.ok, true);
  const oldToken = original.token;
  const oldOwner = original.owner;
  assert.ok(oldToken && oldOwner);
  const exited = once(first.child, "exit");
  first.child.send({ type: "exit" });
  await exited;
  assert.equal(processIdentityStatus(first.identity), "dead");
  const second = await peer(env);
  const replacement = await second.request("acquire", file);
  assert.equal(replacement.ok, true, replacement.error);
  assert.notEqual(replacement.token, original.token);
  assert.throws(() => releaseClaim({ file, token: oldToken, owner: oldOwner, testRoot: env.root }), /Unreadable session claim/);
  assert.equal(lookupClaim(file, env.options)?.token, replacement.token);
});

test("independent processes can claim different files concurrently without lost indexes", async (t) => {
  const env = setup(t);
  const peers = await Promise.all(Array.from({ length: 8 }, () => peer(env)));
  const files = peers.map((_, index) => path.join(env.sessions, `${index}.jsonl`));
  const replies = await Promise.all(peers.map((child, index) => child.request("acquire", files[index])));
  assert.ok(replies.every((reply) => reply.ok), JSON.stringify(replies));
  for (let index = 0; index < files.length; index++) assert.equal(lookupClaim(files[index], env.options)?.token, replies[index].token);
  await Promise.all(peers.map((child) => child.request("release")));
  assert.equal(fs.readdirSync(path.join(env.claims, "keys")).length, 0);
});

test("zombie processes are dead writers before their PID is reaped", { skip: spawnSync("python3", ["--version"]).status !== 0 }, async (t) => {
  const env = setup(t);
  const helper = spawn("python3", [path.join(import.meta.dirname, "test", "ownership-zombie.py")], { stdio: ["pipe", "pipe", "pipe"] });
  env.children.push(helper);
  const pid = await new Promise<number>((resolve, reject) => {
    helper.stdout.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
    helper.once("error", reject);
  });
  assert.ok(pid > 0);
  for (let tries = 0; tries < 100; tries++) {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ")) break;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(readProcessIdentity(pid), undefined);
  assert.equal(processExists(pid), false);
  const done = once(helper, "exit");
  helper.stdin.end("reap\n");
  await done;
});
