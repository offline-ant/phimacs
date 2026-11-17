import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { agentCommand } from "./agent-cli.ts";
import { writeDiscovery, type DiscoveryRecord } from "./discovery.ts";
import { startMux, until } from "./test/harness.ts";

const CONTROL = fileURLToPath(new URL("./control.ts", import.meta.url));
const GUARD = fileURLToPath(new URL("./test/reject-sdk.mjs", import.meta.url));

/** A held fixture prompt stays working until the test creates its file. */
async function heldRuntime(t: test.TestContext) {
  const holds = fs.mkdtempSync(path.join(fs.realpathSync.native("/tmp"), "pimux-agent-holds-"));
  t.after(() => fs.rmSync(holds, { recursive: true, force: true }));
  const run = await startMux(t, { entries: 2, env: { FX_HOLD_DIR: holds } });
  return { run, release: (name: string) => fs.writeFileSync(path.join(holds, name), "") };
}

/** Discovery-only neighbours: kept alive by this test process, never connected to. */
function neighbour(dir: string, muxId: string, fields: Partial<DiscoveryRecord>): string {
  const file = path.join(dir, `${muxId}.json`);
  const now = new Date(0).toISOString();
  writeDiscovery(file, { protocol: 2, muxId, socket: path.join(dir, `${muxId}.sock`), pid: process.pid, piPid: null,
    cwd: "/", startedAt: now, updatedAt: now, status: "idle", blocked: null, session: null, model: null, thinkingLevel: null,
    placement: "root", orchestration: null, parent: null, ...fields });
  return file;
}

test("agent list selects same-cwd peers; get, read, prompt and wait observe one runtime", { timeout: 20_000 }, async (t) => {
  const { run, release } = await heldRuntime(t);
  const id = run.receipt.muxId;
  const mux = run.env.PIMUX_DIR!;
  const self = neighbour(mux, "self-agent", { cwd: run.dir });
  neighbour(mux, "own-worker", { cwd: run.dir, placement: "worker" });
  neighbour(mux, "elsewhere", { cwd: "/" });
  const env = { ...run.env, PIMUX_DISCOVERY: self };

  const peers = await agentCommand(["list"], env);
  assert.equal(peers.exitCode, 0);
  assert.deepEqual((peers.output as { muxId: string }[]).map((peer) => peer.muxId), [id]);
  assert.equal((peers.output as { title: string }[])[0]!.title, "question 0");
  // The control CLI dispatches from source without loading the Pi SDK.
  const all = spawnSync(process.execPath, ["--import", GUARD, "--input-type=module", "-e",
    `import { control } from ${JSON.stringify(CONTROL)}; await control(["agent", "list", "--all"]);`],
  { env, encoding: "utf8", timeout: 5000 });
  assert.equal(all.status, 0, all.stderr);
  const listed = JSON.parse(all.stdout) as { muxId: string; self?: true }[];
  assert.deepEqual(listed.map((peer) => peer.muxId).sort(), [id, "elsewhere", "own-worker", "self-agent"].sort());
  assert.equal(listed.find((peer) => peer.muxId === "self-agent")!.self, true);

  assert.equal(((await agentCommand(["get", id.slice(0, 8)], env)).output as { muxId: string }).muxId, id);
  assert.deepEqual(await agentCommand(["get", "absent"], env),
    { exitCode: 1, output: { error: { code: "agent_not_found", message: "No live managed agent absent" } } });
  assert.deepEqual((await agentCommand(["read", id], env)).output,
    { muxId: id, status: "idle", blocked: null, sessionFile: run.sessionFile, prompt: "question 0", answer: "answer 1", inFlight: null });

  const answered = await agentCommand(["prompt", id, "--wait", "--", "hello"], env);
  assert.deepEqual(answered, { exitCode: 0, output: { muxId: id, disposition: "started", status: "idle", blocked: null, answer: "reply: hello" } });

  // Default waits match the current run's settlement; turn tracking ignores a run active at attachment.
  const held = await agentCommand(["prompt", id, "--", "hold one"], env);
  assert.equal((held.output as { disposition: string }).disposition, "started");
  await until(() => run.discovery()?.status === "working", "held run working");
  assert.equal(((await agentCommand(["prompt", id, "--", "again"], env)).output as { error: { code: string } }).error.code, "agent_working");
  const timedOut = await agentCommand(["wait", id, "--timeout", "200"], env);
  assert.equal(timedOut.exitCode, 2);
  assert.equal((timedOut.output as { error: { code: string; status: string } }).error.status, "working");
  const settled = agentCommand(["wait", id, "--timeout", "15000"], env);
  const nextTurn = agentCommand(["wait", id, "--next-turn", "--timeout", "15000"], env);
  // Connections are served in order, so this read's boundary follows both waits' boundaries.
  assert.equal(((await agentCommand(["read", id], env)).output as { status: string }).status, "working");
  const start = run.first.mark();
  release("one");
  assert.deepEqual(await settled, { exitCode: 0, output: { muxId: id, status: "idle", blocked: null, answer: "reply: hold one" } });
  await run.first.waitFor((record) => record.type === "agent_settled", "held run settled", start);
  await run.first.run("three");
  assert.deepEqual(await nextTurn, { exitCode: 0, output: { muxId: id, status: "idle", blocked: null, answer: "reply: three" } });
  assert.deepEqual(((await agentCommand(["read", id, "--messages", "2"], env)).output as { messages: unknown }).messages,
    [{ role: "user", text: "three" }, { role: "assistant", text: "reply: three" }]);
  assert.equal((await agentCommand(["read", id, "--messages", "1", "--format", "text"], env)).output, "[assistant]\nreply: three");
});

test("agent prompt refuses blocked agents and waits report exit with the terminal receipt", { timeout: 20_000 }, async (t) => {
  const { run } = await heldRuntime(t);
  const id = run.receipt.muxId;
  const start = run.first.mark();
  // The dialog's command never answers: the runtime stops while it is open.
  run.first.send({ type: "prompt", message: "/fx-select", id: "select" });
  const blocked = await agentCommand(["wait", id, "--until", "blocked", "--timeout", "15000"], run.env);
  assert.deepEqual((blocked.output as { blocked: unknown }).blocked, { reason: "dialog", method: "select", title: "Pick a fruit" });
  const refused = await agentCommand(["prompt", id, "--follow-up", "--", "hello"], run.env);
  assert.equal((refused.output as { error: { code: string } }).error.code, "agent_blocked");
  assert.equal(run.first.after(start, (record) => record.type === "message_start").length, 0, "no input reached Pi");
  assert.equal(((await agentCommand(["wait", id], { ...run.env, PIMUX_DISCOVERY: path.join(run.env.PIMUX_DIR!, `${id}.json`) })).output as { error: { code: string } }).error.code, "self_target");

  const exited = agentCommand(["wait", id, "--next-turn", "--timeout", "15000"], run.env);
  assert.equal(((await agentCommand(["read", id], run.env)).output as { status: string }).status, "blocked");
  await run.stop();
  const ended = await exited;
  assert.equal(ended.exitCode, 3);
  assert.equal((ended.output as { error: { code: string } }).error.code, "agent_exited");
  const gone = await agentCommand(["get", id], run.env);
  assert.equal(gone.exitCode, 3);
  assert.equal((gone.output as { error: { receipt: { muxId: string } } }).error.receipt.muxId, id);
});
