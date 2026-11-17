import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext, type RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { acquireClaim, claimsForOwner, createClaimTestEnvironment, lookupClaim, releaseClaim } from "@phimacs/pimux/ownership";
import { readProcessIdentity } from "@phimacs/pimux/process-identity";
import worktree from "./worktree.ts";

test("worktree exclusively initializes a reserved in-memory fork and retains it after cancellation", async (t) => {
  const sandbox = createClaimTestEnvironment();
  const repository = path.join(sandbox.root, "repository");
  fs.mkdirSync(repository, { mode: 0o700 });
  const source = SessionManager.create(repository, sandbox.sessions);
  const file = source.getSessionFile()!;
  const self = readProcessIdentity(process.pid)!;
  const owner = { id: "synthetic-worktree", kind: "rpc" as const, wrapper: self, pi: self, protocol: 2 };
  const initial = acquireClaim(file, owner, sandbox.options);
  const selected = source.appendCustomEntry("selected", {});
  source.appendCustomEntry("abandoned", {});
  source.branch(selected);
  fs.writeFileSync(file, [source.getHeader(), ...source.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n", { flag: "wx", mode: 0o600 });
  const keys = ["PHIMACS_MANAGED_CLAIM", "PHIMACS_TEST_ROOT", "PI_CODING_AGENT_DIR"] as const;
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  process.env.PHIMACS_MANAGED_CLAIM = JSON.stringify(initial);
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
  const notifications: string[] = [];
  let opened: string | undefined;
  const before = fs.readFileSync(file, "utf8");
  worktree({
    registerCommand: (_name: string, registered: RegisteredCommand) => { command = registered; },
    exec: async (_binary: string, args: string[]) => {
      if (args[0] === "rev-parse") return { code: 0, stdout: repository, stderr: "", killed: false };
      assert.deepEqual(args.slice(0, 2), ["worktree", "add"]);
      fs.mkdirSync(args[2]!, { mode: 0o700 });
      return { code: 0, stdout: "", stderr: "", killed: false };
    },
  } as unknown as ExtensionAPI);
  const ctx = {
    cwd: repository, sessionManager: source, waitForIdle: async () => {},
    switchSession: async (destination: string) => {
      opened = destination;
      const claim = lookupClaim(destination, sandbox.options);
      assert.equal(claim?.owner.id, owner.id, "the transition already owns the initialized file");
      return { cancelled: true };
    },
    ui: { notify: (message: string) => notifications.push(message) },
  } as unknown as ExtensionCommandContext;
  await command!.handler("feature", ctx);
  assert.ok(opened);
  const copied = SessionManager.open(opened);
  assert.equal(copied.getCwd(), `${repository}-feature`);
  assert.equal(copied.getHeader()!.parentSession, file);
  assert.notEqual(copied.getSessionId(), source.getSessionId());
  const entries = copied.getEntries();
  const marker = entries.at(-1)!;
  assert.equal(marker.type, "custom");
  assert.equal(marker.parentId, selected, "the selected branch is preserved, not the last abandoned entry");
  assert.ok(entries.some(entry => entry.type === "custom" && entry.customType === "abandoned"), "other branches are retained");
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.equal(source.getLeafId(), selected);
  assert.match(notifications.at(-1)!, /switch was cancelled/);
  assert.equal(lookupClaim(opened, sandbox.options)?.owner.id, owner.id, "cancelled transition reservation remains held");
  assert.throws(() => acquireClaim(opened!, { ...owner, id: "other-writer" }, sandbox.options), /Session is owned/);
  assert.equal(fs.statSync(opened).mode & 0o777, 0o600);
});
