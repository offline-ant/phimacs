import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { JsonRecord } from "./protocol.ts";
import { startMux, until, type SocketPeer } from "./test/harness.ts";

async function ready(peer: SocketPeer): Promise<void> {
  const mark = peer.mark();
  const response = await peer.request({ type: "pimux_bootstrap" });
  const generation = (response.data as { generation: number }).generation;
  await peer.waitFor((record) => record.type === "pimux_live" && record.generation === generation, "explicit input boundary", mark);
}

const isType = (type: string) => (record: JsonRecord): boolean => record.type === type;
const conversational = (record: JsonRecord): boolean =>
  record.type === "message_end" && ["user", "assistant"].includes((record.message as { role: string }).role);
const text = (message: unknown): string => {
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content
    : Array.isArray(content) ? content.flatMap((item: { type?: string; text?: string }) => item.type === "text" ? [item.text ?? ""] : []).join("") : "";
};

// Pi adds entries of its own on opening a session, and system messages to its context.
const conversation = (entries: { type: string }[]): number => entries.filter((entry) => entry.type === "message").length;
const chat = (messages: { role: string }[]): number => messages.filter((message) => message.role !== "system").length;

test("a session thousands of entries deep gets complete snapshots for every client", { timeout: 60_000 }, async (t) => {
  const entries = 3200;
  const run = await startMux(t, { entries });
  const phone = await run.connect();
  const attach = phone.records.find(isType("pimux_snapshot"))!;
  assert.equal(conversation(attach.entries as { type: string }[]), entries);
  assert.equal(chat(attach.messages as { role: string }[]), entries);

  const start = phone.mark();
  const response = await phone.request({ type: "pimux_bootstrap", include: ["entries"] });
  const generation = (response.data as { generation: number }).generation;
  const requested = await phone.waitFor((record) => record.type === "pimux_snapshot" && record.generation === generation, "bootstrap", start);
  assert.equal((requested.entries as { id: string }[]).at(-1)!.id, requested.leafId);
  assert.equal("messages" in requested, false);

  // The first peer never narrowed its includes, so this asks for both.
  const own = await run.first.request({ type: "pimux_bootstrap" });
  const firstSnapshot = await run.first.waitFor((record) => record.type === "pimux_snapshot" && record.generation === (own.data as { generation: number }).generation, "first snapshot");
  assert.equal(conversation(firstSnapshot.entries as { type: string }[]), entries);
  assert.equal(chat(firstSnapshot.messages as { role: string }[]), entries);

  for (const peer of [phone, run.first]) {
    assert.equal(peer.after(0, isType("extension_error")).length, 0);
    assert.equal(peer.after(0, isType("pimux_snapshot_failed")).length, 0);
  }
});

test("one Pi is shared: prompts, replies and responses route between equal socket clients", { timeout: 60_000 }, async (t) => {
  const run = await startMux(t);
  assert.deepEqual(Object.keys(run.first.records[0]!).sort(), ["capabilities", "clientId", "muxId", "piPid", "protocol", "socket", "type"]);
  const discovery = run.discovery()!;
  assert.equal(discovery.session?.file, run.sessionFile);
  assert.deepEqual(discovery.model, { provider: "fx", id: "one" });
  assert.equal(discovery.placement, "root");
  assert.equal(fs.statSync(discovery.socket).mode & 0o777, 0o600);
  const phone = await run.connect();
  const snapshot = phone.records.find(isType("pimux_snapshot"))!;
  assert.equal(snapshot.reason, "attach");
  assert.deepEqual(snapshot.session, { file: run.sessionFile, id: discovery.session!.id, name: null, cwd: run.dir });

  const firstStart = run.first.mark();
  await phone.run("from the phone");
  const users = run.first.after(firstStart, conversational);
  assert.deepEqual(users.map((record) => text(record.message)), ["from the phone", "reply: from the phone"]);
  assert.equal(run.first.after(firstStart, isType("response")).length, 0, "the phone's responses stay with the phone");

  const phoneStart = phone.mark();
  await run.first.run("from emacs");
  assert.deepEqual(phone.after(phoneStart, conversational).map((record) => text(record.message)), ["from emacs", "reply: from emacs"]);
  // Both see one conversation.
  const messages = await phone.request({ type: "get_messages" });
  const roles = (messages.data as { messages: { role: string }[] }).messages.map((message) => message.role).filter((role) => role !== "system");
  assert.deepEqual(roles, ["user", "assistant", "user", "assistant"]);
  const commands = await phone.request({ type: "get_commands" });
  const names = (commands.data as { commands: { name: string }[] }).commands.map((command) => command.name);
  assert.ok(names.includes("fx-select") && !names.includes("pimux-snapshot"));

  // A peer that stops reading does not hold another peer back.
  run.first.socket.pause();
  await phone.run("stream 3000");
  await phone.run("stream 3000");
  run.first.socket.resume();
  await run.first.waitFor((record) => record.type === "message_end" && text(record.message) === "stream 3000", "first peer catches up");
});

test("dialogs: first answer wins, every close is announced, discovery reports blocked", { timeout: 60_000 }, async (t) => {
  const run = await startMux(t);
  const phone = await run.connect();
  let start = run.first.mark();
  const selected = run.first.request({ type: "prompt", message: "/fx-select" });
  const request = await run.first.waitFor((record) => record.type === "extension_ui_request" && record.method === "select", "dialog", start);
  await phone.waitFor((record) => record.id === request.id, "phone sees the dialog");
  await until(() => run.discovery()?.status === "blocked", "discovery blocked");
  assert.deepEqual(run.discovery()!.blocked, { reason: "dialog", method: "select", title: "Pick a fruit" });
  phone.send({ type: "extension_ui_response", id: request.id, value: "pear" });
  run.first.send({ type: "extension_ui_response", id: request.id, value: "apple" });
  const closed = await run.first.waitFor(isType("pimux_dialog_closed"), "closed", start);
  assert.deepEqual(closed, { type: "pimux_dialog_closed", id: request.id, reason: "answered", clientId: phone.records[0]!.clientId });
  await run.first.waitFor((record) => record.method === "notify" && record.message === "picked:pear", "Pi got the phone's answer", start);
  await delay(200);
  assert.equal(run.first.after(start, (record) => record.method === "notify").length, 1, "the late answer was dropped");
  await until(() => run.discovery()?.status === "idle", "discovery idle");
  assert.equal((await selected).success, true);
  await ready(run.first); await ready(phone);

  start = phone.mark();
  const timedResult = run.first.request({ type: "prompt", message: "/fx-select 300" });
  const timed = await phone.waitFor((record) => record.method === "select", "timed dialog", start);
  const timedClose = await phone.waitFor(isType("pimux_dialog_closed"), "timed close", start);
  assert.equal(timedClose.id, timed.id);
  assert.ok(["timeout", "ended"].includes(String(timedClose.reason)));
  assert.equal((await timedResult).success, true);
  await ready(run.first); await ready(phone);

  start = phone.mark();
  const abandonedResult = run.first.request({ type: "prompt", message: "/fx-abandon" });
  const abandoned = await phone.waitFor((record) => record.method === "confirm", "abandoned dialog", start);
  assert.deepEqual(await phone.waitFor(isType("pimux_dialog_closed"), "abandoned close", start),
    { type: "pimux_dialog_closed", id: abandoned.id, reason: "ended" });
  assert.equal((await abandonedResult).success, true);
  await ready(run.first);

  run.first.send({ type: "prompt", message: "/fx-wait" });
  await until(() => run.discovery()?.blocked?.reason === "worker-waiting", "worker waiting is blocked");
});

test("a client joining mid-stream rebuilds the exact message; model and thinking changes reach everyone", { timeout: 60_000 }, async (t) => {
  const run = await startMux(t);
  const first = await run.connect();
  const start = run.first.mark();
  const model = await first.request({ type: "set_model", provider: "fx-slow", modelId: "one" });
  assert.equal(model.success, true);
  const changed = await run.first.waitFor(isType("pimux_model_changed"), "model change", start);
  assert.equal((changed.model as { provider: string }).provider, "fx-slow");
  await until(() => run.discovery()?.model?.provider === "fx-slow", "discovery model");
  await first.request({ type: "set_thinking_level", level: "high" });
  await run.first.waitFor((record) => record.type === "thinking_level_changed" && record.level === "high", "native thinking event", start);

  run.first.send({ type: "prompt", message: "stream 300" });
  await run.first.waitFor((record) => record.type === "message_update"
    && (record.assistantMessageEvent as { type: string }).type === "text_delta", "streaming started", start);
  await until(() => run.discovery()?.status === "working", "discovery working");
  const late = await run.connect();
  const end = await late.waitFor((record) => record.type === "message_end" && (record.message as { role: string }).role === "assistant", "late end", 0, 30_000);
  const snapshotIndex = late.records.findIndex(isType("pimux_snapshot"));
  const snapshot = late.records[snapshotIndex]!;
  assert.deepEqual(snapshot.run, { active: true, compacting: false, tailTruncated: false });
  assert.equal(snapshot.thinkingLevel, "high");
  assert.equal(text((snapshot.messages as unknown[]).at(-1)), "stream 300", "completed messages come from the snapshot");
  const after = late.records.slice(snapshotIndex + 1);
  assert.equal(after[0]!.type, "agent_start");
  assert.equal(after.filter((record) => record.type === "message_start" && (record.message as { role: string }).role === "user").length, 0);
  const rebuilt = after.filter((record) => record.type === "message_update")
    .map((record) => record.assistantMessageEvent as { type: string; contentIndex: number; delta?: string })
    .filter((event) => event.type === "text_delta" && event.contentIndex === 0).map((event) => event.delta).join("");
  assert.ok(rebuilt.length > 0);
  assert.equal(rebuilt, text(end.message));
  await late.waitFor(isType("agent_settled"), "settled");
});

test("session replacement and tree navigation are boundaries; bash is announced to everyone", { timeout: 60_000 }, async (t) => {
  const run = await startMux(t);
  const phone = await run.connect();
  await run.first.run("hello");
  let start = run.first.mark();
  const replaced = await phone.request({ type: "new_session" });
  assert.deepEqual(replaced.data, { cancelled: false });
  const change = await run.first.waitFor(isType("pimux_session_changed"), "session change", start);
  assert.equal(change.reason, "new");
  assert.equal(change.previousSessionFile, run.sessionFile);
  assert.notEqual(change.sessionFile, run.sessionFile);
  const snapshot = await run.first.waitFor(isType("pimux_snapshot"), "new session snapshot", start);
  assert.equal(snapshot.generation, change.generation);
  assert.equal(snapshot.reason, "session_changed");
  assert.deepEqual(snapshot.messages, []);
  await run.first.waitFor(isType("pimux_live"), "live", start);
  await delay(300);
  assert.equal(run.first.after(start, isType("pimux_session_changed")).length, 1, "one change despite Pi's double bind");
  await until(() => run.discovery()?.session?.file === change.sessionFile, "discovery follows the session");

  start = phone.mark();
  assert.equal((await run.first.request({ type: "prompt", message: "/fx-new" })).success, true);
  assert.equal((await phone.waitFor(isType("pimux_session_changed"), "extension-started change", start)).reason, "new");

  await run.first.run("first");
  await run.first.run("second");
  start = phone.mark();
  assert.equal((await run.first.request({ type: "prompt", message: "/fx-tree" })).success, true);
  const tree = await phone.waitFor(isType("pimux_tree_changed"), "tree change", start);
  const treeSnapshot = await phone.waitFor(isType("pimux_snapshot"), "tree snapshot", start);
  assert.equal(treeSnapshot.leafId, tree.leafId);
  assert.equal(treeSnapshot.reason, "tree_changed");

  start = run.first.mark();
  const bash = await phone.request({ type: "bash", command: "echo hi" });
  assert.equal((bash.data as { exitCode: number }).exitCode, 0);
  const announced = await run.first.waitFor(isType("pimux_bash_start"), "bash start", start);
  assert.equal(announced.command, "echo hi");
  const update = await run.first.waitFor(isType("bash_execution_update"), "bash output", start);
  assert.equal(update.bashId, announced.bashId);
  assert.equal("id" in update, false);
  const ended = await run.first.waitFor(isType("pimux_bash_end"), "bash end", start);
  assert.equal((ended.result as { output: string }).output, "hi\n");
});

test("orchestration workers publish placement and parent, and keep their session file", { timeout: 60_000 }, async (t) => {
  const parent = { host: "emacs", endpoint: "/tmp/emacs-test", id: "root-buffer", name: "root-buffer" };
  const run = await startMux(t, { env: {
    PI_ORCHESTRATION_PLACEMENT: "worker", PI_ORCHESTRATION_PARENT: JSON.stringify(parent),
    PI_ORCHESTRATION_HOST: "emacs", PI_ORCHESTRATION_ENDPOINT: "/tmp/emacs-test", PI_ORCHESTRATION_TARGET: "worker-1",
  } });
  const discovery = run.discovery()!;
  assert.equal(discovery.placement, "worker");
  assert.deepEqual(discovery.parent, parent);
  assert.deepEqual(discovery.orchestration, { host: "emacs", endpoint: "/tmp/emacs-test", id: "worker-1" });
  const phone = await run.connect();
  for (const command of [{ type: "new_session" }, { type: "switch_session", sessionPath: path.join(run.dir, "other.jsonl") }]) {
    const response = await phone.request(command);
    assert.equal((response.data as { cancelled: boolean }).cancelled, true, JSON.stringify(response));
  }
  await run.first.run("hello");
  const entries = await phone.request({ type: "get_fork_messages" });
  const entryId = (entries.data as { messages: { entryId: string }[] }).messages[0]!.entryId;
  assert.equal(((await phone.request({ type: "fork", entryId })).data as { cancelled: boolean }).cancelled, true);
  assert.equal(run.discovery()!.session?.file, run.sessionFile);
  assert.equal(run.first.records.filter(isType("pimux_session_changed")).length, 0);
});
