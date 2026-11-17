import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, SessionTreeEvent } from "@earendil-works/pi-coding-agent";
import { type JsonRecord, TREE_NAVIGATE_COMMAND, TREE_NAVIGATION_MARKER_TYPE } from "./protocol.ts";
import { type Peer, startMux } from "./test/harness.ts";
import pimuxTreeNavigate from "./tree-navigate.ts";

type Entry = { id: string; parentId: string | null; type: string; customType?: string; data?: unknown };

async function entries(peer: Peer): Promise<{ entries: Entry[]; leafId: string | null }> {
  const response = await peer.request({ type: "get_entries" });
  assert.equal(response.success, true, String(response.error));
  return response.data as { entries: Entry[]; leafId: string | null };
}

async function navigate(peer: Peer, args: string): Promise<JsonRecord[]> {
  const mark = peer.mark();
  const response = await peer.request({ type: "prompt", message: `/${TREE_NAVIGATE_COMMAND} ${args}`.trimEnd() });
  assert.equal(response.success, true, String(response.error));
  return peer.after(mark, (record) => record.type === "extension_error" && record.extensionPath === `command:${TREE_NAVIGATE_COMMAND}`);
}

/** Pi derives a reopened session's leaf from its last file entry. */
function lastFileEntry(file: string): Entry {
  return JSON.parse(fs.readFileSync(file, "utf8").trimEnd().split("\n").at(-1)!) as Entry;
}

test("a managed faux Pi moves its leaf in place and persists every move", { timeout: 20_000 }, async (t) => {
  // e0 user → e1 assistant → e2 user → e3 assistant (leaf).
  const run = await startMux(t, { entries: 4 });
  const peer = run.first;
  const commands = await peer.request({ type: "get_commands" });
  assert.ok((commands.data as { commands: JsonRecord[] }).commands
    .some((command) => command.name === TREE_NAVIGATE_COMMAND && command.source === "extension"));

  // A summarized move to a user message lands at its parent; the summary is the persisted leaf.
  assert.deepEqual(await navigate(peer, "--summarize e2"), []);
  let tree = await entries(peer);
  const summary = tree.entries.find((entry) => entry.id === tree.leafId)!;
  assert.deepEqual([summary.type, summary.parentId], ["branch_summary", "e1"]);
  assert.equal(lastFileEntry(run.sessionFile).id, summary.id);

  // An unsummarized move to an assistant entry lands on it; a marker persists it.
  assert.deepEqual(await navigate(peer, "e3"), []);
  tree = await entries(peer);
  const marker = tree.entries.find((entry) => entry.id === tree.leafId)!;
  assert.deepEqual({ type: marker.type, customType: marker.customType, parentId: marker.parentId, data: marker.data },
    { type: "custom", customType: TREE_NAVIGATION_MARKER_TYPE, parentId: "e3", data: { navigatedTo: "e3" } });
  assert.equal(lastFileEntry(run.sessionFile).id, marker.id);

  // Selecting the current position appends nothing.
  assert.deepEqual(await navigate(peer, marker.id), []);
  assert.equal(lastFileEntry(run.sessionFile).id, marker.id);

  // Refusals surface as extension errors and leave the leaf in place.
  for (const [args, error] of [["", /Expected exactly one entry ID/], ["e1 e2", /Usage/], ["--summarize", /Usage/], ["--unknown e1", /Unknown flag/], ["missing", /Unknown entry: missing/]] as const) {
    const errors = await navigate(peer, args);
    assert.equal(errors.length, 1, args);
    assert.match(String(errors[0]!.error), error);
  }
  assert.equal((await entries(peer)).leafId, marker.id);
  assert.doesNotMatch(fs.readFileSync(run.sessionFile, "utf8"), new RegExp(TREE_NAVIGATE_COMMAND));
});

function navigationFixture() {
  let handler!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  let listener!: (event: SessionTreeEvent) => void;
  const appended: unknown[] = [];
  const navigations: { entryId: string; summarize: boolean }[] = [];
  const pi = {
    on: (_name: string, callback: typeof listener) => { listener = callback; },
    registerCommand: (_name: string, options: { handler: typeof handler }) => { handler = options.handler; },
    appendEntry: (...entry: unknown[]) => appended.push(entry),
  };
  // The fixture implements only the extension methods this command consumes.
  pimuxTreeNavigate(pi as unknown as ExtensionAPI);
  let idle = true;
  let outcome: () => { cancelled: boolean } = () => ({ cancelled: false });
  const ctx = {
    isIdle: () => idle,
    sessionManager: { getEntry: (id: string) => id === "e1" ? { id } : undefined },
    navigateTree: async (entryId: string, options: { summarize: boolean }) => {
      navigations.push({ entryId, summarize: options.summarize });
      return outcome();
    },
  } as unknown as ExtensionCommandContext;
  return {
    appended, navigations,
    invoke: (args: string) => handler(args, ctx),
    emit: (event: SessionTreeEvent) => listener(event),
    setIdle: (value: boolean) => { idle = value; },
    setOutcome: (value: typeof outcome) => { outcome = value; },
  };
}

const move: SessionTreeEvent = { type: "session_tree", oldLeafId: "old", newLeafId: "e1" };
const summary: SessionTreeEvent = {
  ...move,
  summaryEntry: { type: "branch_summary", id: "summary", parentId: "e1", timestamp: "2026-01-01", fromId: "old", summary: "branch" },
};

test("validation refuses malformed, busy and unknown-entry requests before navigating", async () => {
  const fixture = navigationFixture();
  for (const args of ["", "--summarize", "e1 extra", "--other e1", "--summarize --summarize e1"]) {
    await assert.rejects(fixture.invoke(args), /Usage:/);
  }
  fixture.setIdle(false);
  await assert.rejects(fixture.invoke("e1"), /agent is busy/);
  fixture.setIdle(true);
  await assert.rejects(fixture.invoke("missing"), /Unknown entry: missing/);
  assert.deepEqual([fixture.navigations, fixture.appended], [[], []]);
});

test("actual summary and changed leaf determine persistence, not the requested option", async () => {
  const fixture = navigationFixture();
  fixture.setOutcome(() => { fixture.emit(summary); return { cancelled: false }; });
  await fixture.invoke("--summarize e1");
  assert.deepEqual(fixture.appended, []);

  fixture.setOutcome(() => { fixture.emit(move); return { cancelled: false }; });
  await fixture.invoke("--summarize e1");
  await fixture.invoke("e1");
  assert.deepEqual(fixture.appended, [
    [TREE_NAVIGATION_MARKER_TYPE, { navigatedTo: "e1" }],
    [TREE_NAVIGATION_MARKER_TYPE, { navigatedTo: "e1" }],
  ]);
  assert.deepEqual(fixture.navigations.map(item => item.summarize), [true, true, false]);

  fixture.setOutcome(() => { fixture.emit({ ...move, oldLeafId: "e1" }); return { cancelled: false }; });
  await fixture.invoke("e1");
  assert.equal(fixture.appended.length, 2, "an unchanged leaf adds no marker");
});

test("cancellation, failures and unrelated tree events do not leak navigation observations", async () => {
  const fixture = navigationFixture();
  fixture.setOutcome(() => { fixture.emit(move); return { cancelled: true }; });
  await assert.rejects(fixture.invoke("e1"), /Navigation to e1 was cancelled/);
  fixture.setOutcome(() => { fixture.emit(summary); throw new Error("navigation failed"); });
  await assert.rejects(fixture.invoke("e1"), /navigation failed/);
  fixture.emit(summary);
  assert.deepEqual(fixture.appended, []);

  fixture.setOutcome(() => { fixture.emit(move); return { cancelled: false }; });
  await fixture.invoke("e1");
  assert.deepEqual(fixture.appended, [[TREE_NAVIGATION_MARKER_TYPE, { navigatedTo: "e1" }]]);
});
