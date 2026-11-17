import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import pimuxCompanion from "./companion.ts";
import { COMPANION_STATUS_KEY, type CompanionRecord } from "./protocol.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => void;

/** The companion against a fake Pi; `failures` of the next sends throw, as an unserializable record would. */
function companion(entries: () => unknown[] = () => [{ id: "e1", parentId: null }]) {
  const handlers = new Map<string, Handler>();
  let command: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
  const records: CompanionRecord[] = [];
  const state = { failures: 0 };
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerCommand: (_name: string, options: { handler: typeof command }) => { command = options.handler; },
    getThinkingLevel: () => "off",
  };
  pimuxCompanion(pi as unknown as ExtensionAPI);
  const ctx = {
    model: { provider: "fx", id: "one" },
    isIdle: () => true,
    sessionManager: {
      getSessionFile: () => "/tmp/s.jsonl", getSessionId: () => "s1", getSessionName: () => undefined, getCwd: () => "/tmp",
      getLeafId: () => "e1", getEntries: entries, buildSessionProjection: () => ({ messages: [{ role: "user" }] }),
    },
    ui: {
      setStatus: (key: string, text: string) => {
        assert.equal(key, COMPANION_STATUS_KEY);
        if (state.failures > 0) {
          state.failures--;
          throw new RangeError("Invalid string length");
        }
        records.push(JSON.parse(text) as CompanionRecord);
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, records, state, handlers, command: (args: string) => command!(args, ctx) };
}

test("a snapshot sends flat entries, which serialize at any session depth", async () => {
  const entries = Array.from({ length: 200_000 }, (_, index) => ({ id: `e${index}`, parentId: index ? `e${index - 1}` : null }));
  const { records, command } = companion(() => entries);
  await command("7 entries");
  const record = records[0] as Extract<CompanionRecord, { kind: "snapshot" }>;
  assert.equal(record.kind, "snapshot");
  assert.equal(record.generation, 7);
  assert.equal(record.data.entries?.length, 200_000);
  assert.equal("messages" in record.data, false);
});

test("a snapshot that cannot be sent is reported at once, with no extension error", async () => {
  const { records, state, command } = companion();
  state.failures = 1;
  await command("3 entries,messages");
  assert.deepEqual(records, [{ kind: "snapshot-failed", generation: 3, error: "Invalid string length" }]);
});

test("a snapshot that cannot be taken is reported the same way", async () => {
  const { records, command } = companion(() => { throw new Error("no entries"); });
  await command("4 entries");
  assert.deepEqual(records, [{ kind: "snapshot-failed", generation: 4, error: "no entries" }]);
});

test("a session or tree change whose snapshot fails still reaches frontends, with identity and the error", () => {
  const { ctx, records, state, handlers } = companion();
  state.failures = 1;
  handlers.get("session_start")!({ reason: "fork", previousSessionFile: "/tmp/old.jsonl" }, ctx);
  state.failures = 1;
  handlers.get("session_tree")!({ newLeafId: "e1", oldLeafId: "e0" }, ctx);
  const [session, tree] = records as [Extract<CompanionRecord, { kind: "session" }>, Extract<CompanionRecord, { kind: "tree" }>];
  assert.equal(session.kind, "session");
  assert.equal(session.reason, "fork");
  assert.equal(session.previousSessionFile, "/tmp/old.jsonl");
  assert.equal(session.data.session.file, "/tmp/s.jsonl");
  assert.equal(session.data.historyError, "Invalid string length");
  assert.equal("entries" in session.data || "messages" in session.data, false);
  assert.equal(tree.kind, "tree");
  assert.equal(tree.newLeafId, "e1");
  assert.equal(tree.data.historyError, "Invalid string length");
});
