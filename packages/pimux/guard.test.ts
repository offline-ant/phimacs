import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createClaimTestEnvironment, acquireClaim, claimsForOwner, lookupClaim, releaseClaim } from "./ownership.ts";
import { readProcessIdentity } from "./process-identity.ts";
import { installManagedSessionGuard, MANAGED_CLAIM_ENV, reserveManagedSession } from "./guard.ts";

test("managed reservation precedes initialization and survives cancelled transitions", async (t) => {
  const sandbox = createClaimTestEnvironment();
  const previous = { claim: process.env[MANAGED_CLAIM_ENV], root: process.env.PHIMACS_TEST_ROOT };
  delete process.env[MANAGED_CLAIM_ENV];
  process.env.PHIMACS_TEST_ROOT = sandbox.root;
  assert.throws(() => reserveManagedSession(path.join(sandbox.sessions, "unmanaged.jsonl")), /phimacs pi/);
  const self = readProcessIdentity(process.pid)!;
  const owner = { id: "synthetic-owner", kind: "rpc" as const, wrapper: self, pi: self, protocol: 2 };
  const source = acquireClaim(path.join(sandbox.sessions, "source.jsonl"), owner, sandbox.options);
  process.env[MANAGED_CLAIM_ENV] = JSON.stringify(source);
  t.after(() => {
    for (const claim of claimsForOwner(owner, sandbox.options)) releaseClaim({ file: claim.file, token: claim.token, owner: claim.owner, testRoot: sandbox.root });
    if (previous.claim === undefined) delete process.env[MANAGED_CLAIM_ENV]; else process.env[MANAGED_CLAIM_ENV] = previous.claim;
    if (previous.root === undefined) delete process.env.PHIMACS_TEST_ROOT; else process.env.PHIMACS_TEST_ROOT = previous.root;
    const globals = globalThis as typeof globalThis & { [key: symbol]: unknown };
    delete globals[Symbol.for("phimacs:managed-session-guard")];
    fs.rmSync(sandbox.root, { recursive: true, force: true });
  });
  const destination = path.join(sandbox.sessions, "destination.jsonl");
  const handle = reserveManagedSession(destination);
  assert.equal(fs.existsSync(destination), false, "claim creation performs no session I/O");
  assert.equal(lookupClaim(destination, sandbox.options)?.token, handle.token);
  assert.throws(() => acquireClaim(destination, { ...owner, id: "competitor" }, sandbox.options), /Session is owned/);
  fs.writeFileSync(destination, "synthetic", { mode: 0o600, flag: "wx" });
  assert.equal(reserveManagedSession(destination).token, handle.token, "existing same-writer reservation is reconciled");
  const hardlink = path.join(sandbox.sessions, "alias.jsonl");
  fs.linkSync(destination, hardlink);
  assert.throws(() => acquireClaim(hardlink, { ...owner, id: "competitor" }, sandbox.options), /Session is owned/);
  const callbacks = new Map<string, (event: Record<string, unknown>, ctx: ExtensionContext) => unknown>();
  installManagedSessionGuard({ on: (name: string, handler: (event: Record<string, unknown>, ctx: ExtensionContext) => unknown) => callbacks.set(name, handler) } as unknown as ExtensionAPI);
  const ctx = { ui: { setStatus: () => {}, notify: () => {} } } as unknown as ExtensionContext;
  assert.equal(callbacks.get("session_before_switch")!({ targetSessionFile: destination }, ctx), undefined);
  // A later extension cancels: no guaranteed settled callback exists in Pi.
  assert.equal(lookupClaim(destination, sandbox.options)?.token, handle.token);
  assert.equal(lookupClaim(source.file, sandbox.options)?.token, source.token);
  assert.equal(fs.readFileSync(destination, "utf8"), "synthetic");
  const foreignFile = path.join(sandbox.sessions, "foreign.jsonl");
  const foreign = acquireClaim(foreignFile, { ...owner, id: "other-owner" }, sandbox.options);
  try {
    assert.throws(() => reserveManagedSession(foreignFile), /Session is owned/);
    assert.deepEqual(callbacks.get("session_before_switch")!({ targetSessionFile: foreignFile }, ctx), { cancel: true });
    assert.equal(fs.existsSync(foreignFile), false, "refusal runs before initialization");
  } finally { releaseClaim(foreign); }
});
