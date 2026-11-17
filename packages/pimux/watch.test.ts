import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { type DiscoveryRecord, liveDiscovery, watchDiscovery, writeDiscovery } from "./discovery.ts";
import { ensurePrivateDirectory } from "./private-files.ts";

const CONTROL = fileURLToPath(new URL("./control.ts", import.meta.url));
const GUARD = fileURLToPath(new URL("./test/reject-sdk.mjs", import.meta.url));

function directory(t: test.TestContext): string {
  const base = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "pimux-watch-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return path.join(base, "mux");
}

function record(muxId: string, fields: Partial<DiscoveryRecord> = {}): DiscoveryRecord {
  return {
    protocol: 2, muxId, socket: `/x/${muxId}.sock`, pid: process.pid, piPid: null, cwd: "/", startedAt: `2026-11-12T00:00:0${muxId.length % 10}Z`,
    updatedAt: new Date().toISOString(), status: "idle", blocked: null, session: null, model: null, thinkingLevel: null,
    placement: "root", orchestration: null, parent: null, ...fields,
  };
}

/** A pid that existed and has exited. */
async function deadPid(): Promise<number> {
  const exited = spawn(process.execPath, ["-e", ""]);
  await new Promise((resolve) => exited.on("exit", resolve));
  return exited.pid!;
}

/** Collects snapshots; `next()` resolves with the next one not yet taken. */
function snapshots() {
  const seen: string[][] = [];
  const waiting: ((ids: string[]) => void)[] = [];
  let taken = 0;
  return {
    push(records: DiscoveryRecord[]) {
      seen.push(records.map((entry) => `${entry.muxId}:${entry.status}`));
      while (waiting.length && taken < seen.length) waiting.shift()!(seen[taken++]!);
    },
    next(): Promise<string[]> {
      return taken < seen.length ? Promise.resolve(seen[taken++]!) : new Promise((resolve) => waiting.push(resolve));
    },
    get count() { return seen.length; },
  };
}

test("list and watch report live owners only, in creation order", async (t) => {
  const dir = directory(t);
  assert.deepEqual(liveDiscovery(dir), []);
  ensurePrivateDirectory(dir);
  writeDiscovery(path.join(dir, "bb.json"), record("bb"));
  writeDiscovery(path.join(dir, "a.json"), record("a"));
  writeDiscovery(path.join(dir, "dead.json"), record("dead", { pid: await deadPid() }));
  assert.deepEqual(liveDiscovery(dir).map((entry) => entry.muxId), ["a", "bb"]);
  fs.chmodSync(dir, 0o755);
  assert.throws(() => liveDiscovery(dir), /mode 0700/);
});

test("a watch sends the complete live set at once and after each change, ignoring updatedAt", { timeout: 20_000 }, async (t) => {
  const dir = directory(t);
  const received = snapshots();
  const errors: Error[] = [];
  // The directory does not exist yet: an empty first snapshot, then the backstop finds it.
  const watch = watchDiscovery(dir, (records) => received.push(records), { debounceMs: 5, backstopMs: 50, onError: (error) => errors.push(error) });
  t.after(() => watch.close());
  assert.deepEqual(await received.next(), []);
  ensurePrivateDirectory(dir);
  const file = path.join(dir, "one.json");
  writeDiscovery(file, record("one"));
  assert.deepEqual(await received.next(), ["one:idle"]);
  // Replacing the file by rename is a change; a newer updatedAt alone is not.
  writeDiscovery(file, record("one", { updatedAt: new Date(Date.now() + 1000).toISOString() }));
  const before = received.count;
  // Past several debounces and a backstop reread.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(received.count, before);
  writeDiscovery(file, record("one", { status: "working" }));
  assert.deepEqual(await received.next(), ["one:working"]);
  // An owner that dies leaves its file; the backstop's liveness check drops it.
  const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  t.after(() => owner.kill("SIGKILL"));
  writeDiscovery(path.join(dir, "two.json"), record("two", { pid: owner.pid! }));
  assert.deepEqual(await received.next(), ["one:working", "two:idle"]);
  owner.kill("SIGKILL");
  assert.deepEqual(await received.next(), ["one:working"]);
  fs.rmSync(file);
  assert.deepEqual(await received.next(), []);
  // A directory that becomes unsafe stops the watch with an error.
  fs.chmodSync(dir, 0o755);
  while (!errors.length) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(errors[0]!.message, /mode 0700/);
  const count = received.count;
  fs.chmodSync(dir, 0o700);
  writeDiscovery(path.join(dir, "three.json"), record("three"));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(received.count, count);
});

test("pimux watch --json prints snapshot lines until stdin closes; an unsafe directory fails", { timeout: 20_000 }, async (t) => {
  const dir = directory(t);
  ensurePrivateDirectory(dir);
  writeDiscovery(path.join(dir, "one.json"), record("one"));
  const run = (env: NodeJS.ProcessEnv) => spawn(process.execPath, ["--import", GUARD, "--input-type=module", "-e",
    `import { control } from ${JSON.stringify(CONTROL)}; await control(["watch", "--json"]);`], { env: { ...process.env, ...env } });
  const watcher = run({ PIMUX_DIR: dir });
  t.after(() => watcher.kill("SIGKILL"));
  let buffer = "";
  const lines: unknown[] = [];
  const line = (): Promise<unknown> => new Promise((resolve) => {
    const check = (): void => {
      if (lines.length) { watcher.stdout.off("data", read); resolve(lines.shift()); }
    };
    const read = (chunk: Buffer): void => {
      buffer += chunk;
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        lines.push(JSON.parse(buffer.slice(0, at)));
        buffer = buffer.slice(at + 1);
      }
      check();
    };
    watcher.stdout.on("data", read);
    check();
  });
  const first = await line() as { type: string; agents: DiscoveryRecord[] };
  assert.equal(first.type, "agents");
  assert.deepEqual(first.agents.map((entry) => entry.muxId), ["one"]);
  writeDiscovery(path.join(dir, "two.json"), record("two"));
  assert.deepEqual((await line() as { agents: DiscoveryRecord[] }).agents.map((entry) => entry.muxId), ["one", "two"]);
  const exited = new Promise<number | null>((resolve) => watcher.on("exit", resolve));
  watcher.stdin.end();
  assert.equal(await exited, 0);

  fs.chmodSync(dir, 0o755);
  const unsafe = run({ PIMUX_DIR: dir });
  let stderr = "";
  unsafe.stderr.on("data", (chunk: Buffer) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve) => unsafe.on("exit", resolve));
  assert.notEqual(code, 0);
  assert.match(stderr, /mode 0700/);
});
