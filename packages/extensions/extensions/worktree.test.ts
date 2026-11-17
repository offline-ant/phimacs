import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext, type RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { acquireClaim, claimsForOwner, createClaimTestEnvironment, lookupClaim, releaseClaim, type ClaimOwner } from "@phimacs/pimux/ownership";
import { readProcessIdentity } from "@phimacs/pimux/process-identity";
import worktree from "./worktree.ts";

const self = readProcessIdentity(process.pid)!;
const owner: ClaimOwner = { id: "synthetic-worktree", kind: "rpc", wrapper: self, pi: self, protocol: 2 };

/** A saved source session with an abandoned branch, the command and a cancelling switch; MANAGED_CLAIM undefined runs a plain Pi. */
function prepare(t: TestContext, managedClaim: (sandbox: ReturnType<typeof createClaimTestEnvironment>, file: string) => string | undefined) {
  const sandbox = createClaimTestEnvironment();
  const repository = path.join(sandbox.root, "repository");
  fs.mkdirSync(repository, { mode: 0o700 });
  const source = SessionManager.create(repository, sandbox.sessions);
  const file = source.getSessionFile()!;
  const selected = source.appendCustomEntry("selected", {});
  source.appendCustomEntry("abandoned", {});
  source.branch(selected);
  const keys = ["PHIMACS_MANAGED_CLAIM", "PHIMACS_TEST_ROOT", "PI_CODING_AGENT_DIR"] as const;
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  const claim = managedClaim(sandbox, file);
  fs.writeFileSync(file, [source.getHeader(), ...source.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n", { flag: "wx", mode: 0o600 });
  if (claim === undefined) delete process.env.PHIMACS_MANAGED_CLAIM;
  else process.env.PHIMACS_MANAGED_CLAIM = claim;
  process.env.PHIMACS_TEST_ROOT = sandbox.root;
  process.env.PI_CODING_AGENT_DIR = sandbox.root;
  t.after(() => {
    for (const record of claimsForOwner(owner, sandbox.options)) releaseClaim({ file: record.file, token: record.token, owner: record.owner, testRoot: sandbox.root });
    for (const key of keys) { const value = previous.get(key); if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    const globals = globalThis as typeof globalThis & { [key: symbol]: unknown };
    delete globals[Symbol.for("phimacs:managed-session-guard")];
    fs.rmSync(sandbox.root, { recursive: true, force: true });
  });
  let command: RegisteredCommand | undefined;
  const gitCalls: string[][] = [];
  const notifications: string[] = [];
  const opened: string[] = [];
  worktree({
    registerCommand: (_name: string, registered: RegisteredCommand) => { command = registered; },
    exec: async (_binary: string, args: string[]) => {
      gitCalls.push(args);
      if (args[0] === "rev-parse") return { code: 0, stdout: repository, stderr: "", killed: false };
      assert.deepEqual(args.slice(0, 2), ["worktree", "add"]);
      fs.mkdirSync(args[2]!, { mode: 0o700 });
      return { code: 0, stdout: "", stderr: "", killed: false };
    },
  } as unknown as ExtensionAPI);
  const ctx = {
    cwd: repository, sessionManager: source, waitForIdle: async () => {},
    switchSession: async (destination: string) => { opened.push(destination); return { cancelled: true }; },
    ui: { notify: (message: string) => notifications.push(message) },
  } as unknown as ExtensionCommandContext;
  return { sandbox, repository, source, file, selected, gitCalls, notifications, opened, run: () => command!.handler("feature", ctx) };
}

/** The forked file keeps the selected branch and every other entry, and the source is untouched. */
function assertFork(input: ReturnType<typeof prepare>, before: string): string {
  assert.equal(input.opened.length, 1);
  const copied = SessionManager.open(input.opened[0]!);
  assert.equal(copied.getCwd(), `${input.repository}-feature`);
  assert.equal(copied.getHeader()!.parentSession, input.file);
  assert.notEqual(copied.getSessionId(), input.source.getSessionId());
  const entries = copied.getEntries();
  const marker = entries.at(-1)!;
  assert.equal(marker.type, "custom");
  assert.equal(marker.parentId, input.selected, "the selected branch is preserved, not the last abandoned entry");
  assert.ok(entries.some(entry => entry.type === "custom" && entry.customType === "abandoned"), "other branches are retained");
  assert.equal(fs.readFileSync(input.file, "utf8"), before);
  assert.equal(input.source.getLeafId(), input.selected);
  assert.match(input.notifications.at(-1)!, /switch was cancelled/);
  assert.equal(fs.statSync(input.opened[0]!).mode & 0o777, 0o600);
  return input.opened[0]!;
}

test("worktree exclusively initializes a reserved in-memory fork and retains it after cancellation", async (t) => {
  const input = prepare(t, (sandbox, file) => JSON.stringify(acquireClaim(file, owner, sandbox.options)));
  const before = fs.readFileSync(input.file, "utf8");
  await input.run();
  const opened = assertFork(input, before);
  assert.equal(lookupClaim(opened, input.sandbox.options)?.owner.id, owner.id, "cancelled transition reservation remains held");
  assert.throws(() => acquireClaim(opened, { ...owner, id: "other-writer" }, input.sandbox.options), /Session is owned/);
});

test("worktree in a plain pi without any managed claim forks like stock Pi and claims nothing", async (t) => {
  const input = prepare(t, () => undefined);
  const before = fs.readFileSync(input.file, "utf8");
  await input.run();
  const opened = assertFork(input, before);
  assert.equal(lookupClaim(opened, input.sandbox.options), undefined);
  assert.equal(lookupClaim(input.file, input.sandbox.options), undefined);
});

for (const [kind, claim] of [
  ["malformed", () => "{"],
  ["blank", () => ""],
  ["lost", (sandbox, file) => { const handle = acquireClaim(file, owner, sandbox.options); releaseClaim(handle); return JSON.stringify(handle); }],
  ["conflicting", (sandbox, file) => JSON.stringify({ ...acquireClaim(file, owner, sandbox.options), token: "another-writer" })],
] as const satisfies ReadonlyArray<readonly [string, Parameters<typeof prepare>[1]]>) {
  test(`worktree refuses a ${kind} managed claim before changing Git or session files`, async (t) => {
    const input = prepare(t, claim);
    await input.run();
    assert.match(input.notifications.at(-1)!, /^Worktree creation refused before changing Git or session files: /);
    assert.deepEqual(input.gitCalls, []);
    assert.deepEqual(input.opened, []);
    assert.equal(fs.existsSync(`${input.repository}-feature`), false);
  });
}
