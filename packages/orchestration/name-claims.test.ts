import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import { readProcessIdentity, processIdentityStatus, type ProcessIdentity } from "@phimacs/pimux/process-identity";

interface Reply { id?: number; ready?: boolean; identity?: ProcessIdentity; held?: boolean; acquired?: boolean; released?: boolean; error?: string }
interface Peer { child: ChildProcess; identity: ProcessIdentity; request: (type: string) => Promise<Reply> }
const self = readProcessIdentity(process.pid)!;
function setup(t: TestContext): { root: string; registry: string; claim: string; children: ChildProcess[] } {
  const root = fs.mkdtempSync("/tmp/phimacs-name-claims-");
  const registry = path.join(root, "pi-orchestration-targets");
  fs.mkdirSync(registry, { mode: 0o700 });
  const children: ChildProcess[] = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, registry, claim: path.join(registry, "race.json.claim"), children };
}
async function peer(env: ReturnType<typeof setup>): Promise<Peer> {
  const child = fork(path.join(import.meta.dirname, "test/name-claim-child.ts"), [], {
    execArgv: [], env: { ...process.env, TMPDIR: env.root }, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  env.children.push(child);
  let diagnostics = "";
  child.stderr?.on("data", (chunk: Buffer) => { diagnostics += chunk.toString(); });
  const ready = await new Promise<Reply>((resolve, reject) => {
    child.once("message", resolve); child.once("error", reject);
    child.once("exit", () => reject(new Error(diagnostics)));
  });
  assert.equal(ready.ready, true); assert.ok(ready.identity);
  let serial = 0;
  return { child, identity: ready.identity, request: (type) => new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { child.off("message", receive); reject(new Error(`Name peer timeout: ${diagnostics}`)); }, 20_000);
    const receive = (reply: Reply): void => {
      if (reply.id !== id) return;
      clearTimeout(timer); child.off("message", receive); resolve(reply);
    };
    child.on("message", receive); child.send({ id, type });
  }) };
}
function seed(env: ReturnType<typeof setup>, identity: ProcessIdentity): void {
  fs.writeFileSync(env.claim, JSON.stringify({ process: identity, purpose: "request", token: "previous-holder" }), { mode: 0o600 });
}

test("simultaneous stale-name reclaimers elect one holder without unlink ABA", { timeout: 60_000 }, async (t) => {
  const env = setup(t);
  const peers = await Promise.all(Array.from({ length: 12 }, () => peer(env)));
  // This is the cooperating schedule represented by the old monkeypatched
  // unlink reproducer: reclaimers and a replacement all compete independently.
  for (let round = 0; round < 8; round++) {
    seed(env, { ...self, startTime: "0" });
    const replies = await Promise.all(peers.map((child) => child.request("claim")));
    assert.equal(replies.filter((reply) => reply.acquired).length, 1, JSON.stringify(replies));
    assert.ok(replies.every((reply) => !reply.error), JSON.stringify(replies));
    const winner = peers[replies.findIndex((reply) => reply.acquired)];
    assert.deepEqual(JSON.parse(fs.readFileSync(env.claim, "utf8")).process, winner.identity);
    const losers = peers.filter((child) => child !== winner);
    const secondPass = await Promise.all(losers.map((child) => child.request("claim")));
    assert.ok(secondPass.every((reply) => reply.acquired === false), JSON.stringify(secondPass));
    assert.deepEqual(JSON.parse(fs.readFileSync(env.claim, "utf8")).process, winner.identity);
    assert.equal((await winner.request("release")).released, true);
    assert.equal(fs.existsSync(env.claim), false);
  }
});

test("killed name-transaction holder recovers without bypassing a replacement holder", { timeout: 30_000 }, async (t) => {
  const env = setup(t);
  seed(env, { ...self, startTime: "0" });
  const holder = await peer(env);
  assert.equal((await holder.request("hold-transaction")).held, true);
  const contenders = await Promise.all(Array.from({ length: 6 }, () => peer(env)));
  let completed = 0;
  const pending = contenders.map((child) => child.request("claim").then((reply) => { completed++; return reply; }));
  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  assert.equal(completed, 0, "all stale reads/reclaims wait inside the same transaction");
  const exited = once(holder.child, "exit"); holder.child.kill("SIGKILL"); await exited;
  assert.equal(processIdentityStatus(holder.identity), "dead");
  const replies = await Promise.all(pending);
  assert.equal(replies.filter((reply) => reply.acquired).length, 1, JSON.stringify(replies));
  const winner = contenders[replies.findIndex((reply) => reply.acquired)];
  const original = fs.readFileSync(env.claim, "utf8");
  assert.deepEqual(JSON.parse(original).process, winner.identity);
  assert.equal((await contenders.find((child) => child !== winner)!.request("claim")).acquired, false);
  assert.equal(fs.readFileSync(env.claim, "utf8"), original);
});

test("dead named holders recover but uncertain, malformed and nonprivate claims are not stolen", async (t) => {
  const env = setup(t);
  const contender = await peer(env);
  seed(env, { ...self, pid: Number.MAX_SAFE_INTEGER });
  const uncertain = fs.readFileSync(env.claim, "utf8");
  assert.equal((await contender.request("claim")).acquired, false);
  assert.equal(fs.readFileSync(env.claim, "utf8"), uncertain);
  fs.writeFileSync(env.claim, "partial claim");
  assert.match((await contender.request("claim")).error ?? "", /JSON/);
  assert.equal(fs.readFileSync(env.claim, "utf8"), "partial claim");
  seed(env, { ...self, startTime: "0" }); fs.chmodSync(env.claim, 0o644);
  assert.match((await contender.request("claim")).error ?? "", /Unsafe name claim/);
  fs.chmodSync(env.claim, 0o600);
  assert.equal((await contender.request("claim")).acquired, true);
  const identity = contender.identity;
  const exited = once(contender.child, "exit"); contender.child.kill("SIGKILL"); await exited;
  assert.equal(processIdentityStatus(identity), "dead");
  const successor = await peer(env);
  assert.equal((await successor.request("claim")).acquired, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(env.claim, "utf8")).process, successor.identity);
  assert.equal(fs.statSync(env.claim).mode & 0o777, 0o600);
});
