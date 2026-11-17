import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import { withTransaction, TransactionError } from "./transaction.ts";
import { processIdentityStatus, readProcessIdentity, type ProcessIdentity } from "./process-identity.ts";

const self = readProcessIdentity(process.pid)!;
interface Reply { id?: number; ready?: boolean; identity?: ProcessIdentity; held?: boolean; ok?: boolean; error?: string }
function setup(t: TestContext): { root: string; directory: string; children: ChildProcess[] } {
  const root = fs.mkdtempSync("/tmp/phimacs-transactions-");
  const children: ChildProcess[] = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, directory: path.join(root, "tickets"), children };
}
async function peer(env: ReturnType<typeof setup>): Promise<{ child: ChildProcess; identity: ProcessIdentity; request: (type: string, count?: number) => Promise<Reply> }> {
  const child = fork(path.join(import.meta.dirname, "test/transaction-child.ts"), [env.directory], { execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"] });
  env.children.push(child);
  let diagnostics = "";
  child.stderr?.on("data", (chunk: Buffer) => { diagnostics += chunk.toString(); });
  const ready = await new Promise<Reply>((resolve, reject) => {
    child.once("message", resolve); child.once("error", reject);
    child.once("exit", () => reject(new Error(diagnostics)));
  });
  assert.equal(ready.ready, true); assert.ok(ready.identity);
  let serial = 0;
  return { child, identity: ready.identity, request: (type, count) => new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { child.off("message", receive); reject(new Error(`Transaction peer timeout: ${diagnostics}`)); }, 20_000);
    const receive = (reply: Reply): void => {
      if (reply.id !== id) return;
      clearTimeout(timer); child.off("message", receive); resolve(reply);
    };
    child.on("message", receive); child.send({ id, type, count });
  }) };
}
function ticket(directory: string, changes: Record<string, unknown> = {}): string {
  const id = "a".repeat(64);
  const file = path.join(directory, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ schema: 1, id, process: self, choosing: true, number: 0, ...changes }), { mode: 0o600 });
  return file;
}

test("transactions return results, clean up after exceptions, and reject recursive entry", (t) => {
  const { directory } = setup(t);
  assert.equal(withTransaction(directory, () => 42), 42);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.throws(() => withTransaction(directory, () => { throw new Error("action failure"); }), /action failure/);
  assert.throws(() => withTransaction(directory, () => withTransaction(directory, () => {})), /re-enter/);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test("independent processes serialize critical sections and counter updates", { timeout: 30_000 }, async (t) => {
  const env = setup(t);
  const peers = await Promise.all(Array.from({ length: 10 }, () => peer(env)));
  const replies = await Promise.all(peers.map((child) => child.request("run", 12)));
  assert.ok(replies.every((reply) => reply.ok), JSON.stringify(replies));
  assert.equal(Number(fs.readFileSync(path.join(env.directory, "counter"), "utf8")), 120);
  assert.deepEqual(fs.readdirSync(env.directory).filter((name) => name.endsWith(".json")), []);
});

test("killed transaction recovery cannot remove another live participant", { timeout: 30_000 }, async (t) => {
  const env = setup(t);
  const holder = await peer(env);
  assert.equal((await holder.request("hold")).held, true);
  const contender = await peer(env);
  let completed = false;
  const pending = contender.request("run", 1).then((reply) => { completed = true; return reply; });
  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  assert.equal(completed, false);
  const exited = once(holder.child, "exit"); holder.child.kill("SIGKILL"); await exited;
  assert.equal(processIdentityStatus(holder.identity), "dead");
  assert.equal((await pending).ok, true);
  const fresh = await peer(env);
  assert.equal((await fresh.request("hold")).held, true);
  const files = fs.readdirSync(env.directory).filter((name) => name.endsWith(".json"));
  assert.equal(files.length, 1);
  const liveTicket = JSON.parse(fs.readFileSync(path.join(env.directory, files[0]), "utf8"));
  assert.deepEqual(liveTicket.process, fresh.identity);
  assert.throws(() => withTransaction(env.directory, () => assert.fail("live owner was bypassed"), { timeoutMs: 20 }), /live or uncertain/);
  assert.ok(fs.existsSync(path.join(env.directory, files[0])));
});

test("dead tickets recover but unknown identities and malformed publications fail closed", (t) => {
  const { directory } = setup(t);
  withTransaction(directory, () => {});
  const stale = ticket(directory, { process: { ...self, startTime: "0" } });
  withTransaction(directory, () => {});
  assert.equal(fs.existsSync(stale), false);
  const unknown = ticket(directory, { process: { ...self, pid: Number.MAX_SAFE_INTEGER } });
  assert.throws(() => withTransaction(directory, () => assert.fail("uncertain owner was bypassed"), { timeoutMs: 20 }), /live or uncertain/);
  assert.ok(fs.existsSync(unknown));
  fs.writeFileSync(unknown, "partial JSON");
  assert.throws(() => withTransaction(directory, () => {}), /Unreadable transaction ticket/);
  assert.equal(fs.readFileSync(unknown, "utf8"), "partial JSON");
  fs.unlinkSync(unknown);
  ticket(directory, { id: "b".repeat(64) });
  assert.throws(() => withTransaction(directory, () => {}), /Invalid transaction ticket/);
});

test("private permissions, symlinks, bounded tickets and atomic temporary files are checked", (t) => {
  const { root, directory } = setup(t);
  withTransaction(directory, () => {});
  fs.chmodSync(directory, 0o755);
  assert.throws(() => withTransaction(directory, () => {}), /0700/);
  fs.chmodSync(directory, 0o700);
  const alias = path.join(root, "alias"); fs.symlinkSync(directory, alias);
  assert.throws(() => withTransaction(alias, () => {}), /0700/);
  const file = ticket(directory);
  fs.chmodSync(file, 0o644);
  assert.throws(() => withTransaction(directory, () => {}), /Unreadable transaction ticket/);
  fs.chmodSync(file, 0o600); fs.writeFileSync(file, "x".repeat(4097));
  assert.throws(() => withTransaction(directory, () => {}), /Unreadable transaction ticket/);
  fs.unlinkSync(file);
  fs.symlinkSync(path.join(root, "missing"), file);
  assert.throws(() => withTransaction(directory, () => {}), /Unreadable transaction ticket/);
  fs.unlinkSync(file);
  fs.writeFileSync(`${file}.unfinished.tmp`, "partial");
  assert.equal(withTransaction(directory, () => "complete"), "complete");
  assert.equal(fs.readFileSync(`${file}.unfinished.tmp`, "utf8"), "partial");
  assert.throws(() => withTransaction(directory, () => {}, { timeoutMs: 0 }), RangeError);
  assert.ok(TransactionError.prototype instanceof Error);
});
