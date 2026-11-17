import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { registerSwitch } from "./switch.ts";
import type { SwitchSource } from "../switch-destinations.ts";

function fixture(options: { muxId?: string; failure?: string; sessionFile?: string | null } = {}) {
  const commands = new Map<string, RegisteredCommand>();
  const notices: string[] = [];
  const preparations: SwitchSource[] = [];
  const choices: string[][] = [];
  let writes = 0;
  let replacements = 0;
  let starts = 0;
  let wait: (() => Promise<void>) | undefined;
  const pi = {
    registerCommand: (name: string, command: RegisteredCommand) => commands.set(name, command),
    appendEntry: () => { writes++; },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: "/synthetic/project", sessionManager: { getSessionFile: () => options.sessionFile === null ? undefined : options.sessionFile ?? "/synthetic/session.jsonl" },
    isIdle: () => false, hasPendingMessages: () => true,
    switchSession: async () => { replacements++; return { cancelled: false }; },
    ui: { select: async (_title: string, values: string[]) => { choices.push(values); return "emacs"; }, notify: (message: string) => notices.push(message) },
  } as unknown as ExtensionCommandContext;
  registerSwitch(pi, {
    runtime: () => options.muxId,
    environment: () => ({ HOME: "/synthetic", PHIMACS_MANAGED_CLAIM: "never-forward-this", PHIMACS_PARENT_TASK: "never-forward-parent" }),
    prepare: async (kind, source) => {
      assert.equal(kind, "emacs");
      preparations.push(source);
      return { start: async () => {
        starts++;
        await wait?.();
        if (options.failure) throw new Error(options.failure);
        return "Emacs attached";
      } };
    },
  });
  return { ctx, notices, preparations, choices,
    command: (arg = "emacs") => commands.get("switch")!.handler(arg, ctx),
    hold: (fn: () => Promise<void>) => { wait = fn; },
    counts: () => ({ writes, replacements, starts }),
  };
}

test("busy managed RPC attaches Emacs without replacement, appends or inferred prompts", async () => {
  const f = fixture({ muxId: "runtime-one" });
  await f.command();
  assert.deepEqual(f.preparations[0]!.runtime, { protocol: 2, muxId: "runtime-one" });
  assert.deepEqual(f.preparations[0]!.args, []);
  assert.equal(f.preparations[0]!.env.PHIMACS_MANAGED_CLAIM, "");
  assert.equal(f.preparations[0]!.env.PHIMACS_PARENT_TASK, "");
  assert.deepEqual(f.counts(), { writes: 0, replacements: 0, starts: 1 });
  assert.match(f.notices.at(-1)!, /Both views stay live and in sync/);
  assert.match(f.notices.at(-1)!, /Agent Close ends the shared agent everywhere/);
});

test("omitting the destination opens the retained host picker", async () => {
  const f = fixture({ muxId: "runtime-one" });
  await f.command("");
  assert.deepEqual(f.choices, [["herdr", "emacs"]]);
  assert.equal(f.preparations.length, 1);
});

for (const destination of ["herdr", "emacs"]) {
  test(`unmanaged /switch ${destination} refuses before destination or source mutation`, async () => {
    const f = fixture();
    await f.command(destination);
    assert.match(f.notices.at(-1)!, /source cannot be made permanently unable to write/);
    assert.deepEqual(f.preparations, []);
    assert.deepEqual(f.counts(), { writes: 0, replacements: 0, starts: 0 });
  });
}

test("managed RPC to Herdr refuses rather than release a live writer", async () => {
  const f = fixture({ muxId: "runtime-one" });
  await f.command("herdr");
  assert.match(f.notices.at(-1)!, /No claim was released and no destination was opened/);
  assert.deepEqual(f.preparations, []);
});

test("unsupported destinations and missing session identity never prepare a view", async () => {
  for (const destination of ["tau", "tmux", "other"]) {
    const f = fixture({ muxId: "runtime-one" });
    await f.command(destination);
    assert.match(f.notices.at(-1)!, /Usage: \/switch \[herdr\|emacs\]/);
    assert.deepEqual(f.preparations, []);
  }
  const f = fixture({ muxId: "runtime-one", sessionFile: null });
  await f.command();
  assert.match(f.notices.at(-1)!, /no persistent session identity/);
  assert.deepEqual(f.preparations, []);
});

test("attachment failure preserves the source and permits explicit retry", async () => {
  const f = fixture({ muxId: "runtime-one", failure: "attachment uncertain; inspect views" });
  await f.command();
  await f.command();
  assert.equal(f.preparations.length, 2);
  assert.match(f.notices.at(-1)!, /attachment uncertain/);
  assert.deepEqual(f.counts(), { writes: 0, replacements: 0, starts: 2 });
});

test("a concurrent command cannot attach again while readiness is pending", async () => {
  const f = fixture({ muxId: "runtime-one" });
  let finish!: () => void;
  f.hold(() => new Promise<void>((resolve) => { finish = resolve; }));
  const first = f.command();
  await f.command();
  assert.match(f.notices.at(-1)!, /already in progress/);
  finish();
  await first;
  assert.equal(f.preparations.length, 1);
});
