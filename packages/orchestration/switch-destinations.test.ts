import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { acquireClaim, createClaimTestEnvironment, lookupClaim, releaseClaim } from "@phimacs/pimux/ownership";
import { readProcessIdentity } from "@phimacs/pimux/process-identity";
import { writeDiscovery, type DiscoveryRecord } from "@phimacs/pimux/discovery";
import { prepareSwitch, sharedMuxId, switchEnvironment, type SwitchSource } from "./switch-destinations.ts";

test("unmanaged and native destinations refuse before destination preparation", async () => {
  const source: SwitchSource = {
    sessionFile: "/synthetic/conversation.jsonl", cwd: "/synthetic", args: [],
    env: switchEnvironment({ HOME: "/synthetic" }),
  };
  await assert.rejects(prepareSwitch("emacs", source), /No claim was released and no destination was opened/);
  await assert.rejects(prepareSwitch("herdr", source), /source cannot be made permanently unable to write/);
  await assert.rejects(prepareSwitch("herdr", { ...source, runtime: { protocol: 2, muxId: "mux-1" } }),
    /No claim was released and no destination was opened/);
});

test("attachment environment keeps agent/session selection but clears inherited writer and parent authority", () => {
  const selected = switchEnvironment({
    HOME: "/synthetic/home", PI_CODING_AGENT_DIR: "/synthetic/agent", PI_CODING_AGENT_SESSION_DIR: "/synthetic/sessions",
    PHIMACS_MANAGED_CLAIM: "source-capability", PHIMACS_PARENT_TASK: "source-parent", PIMUX_DISCOVERY: "source-discovery",
    HERDR_SOCKET_PATH: "/synthetic/herdr.sock", HERDR_PANE_ID: "source-pane", TMUX: "source-tmux",
  });
  assert.equal(selected.PI_CODING_AGENT_DIR, "/synthetic/agent");
  assert.equal(selected.PI_CODING_AGENT_SESSION_DIR, "/synthetic/sessions");
  assert.equal(selected.HERDR_SOCKET_PATH, "/synthetic/herdr.sock");
  for (const key of ["PHIMACS_MANAGED_CLAIM", "PHIMACS_PARENT_TASK", "PIMUX_DISCOVERY", "HERDR_PANE_ID", "TMUX"]) {
    assert.equal(selected[key], "", key);
  }
  assert.equal(switchEnvironment({ HOME: "/synthetic/home" }).PI_CODING_AGENT_DIR, "/synthetic/home/.pi/agent");
  assert.equal(switchEnvironment({}).PI_CODING_AGENT_DIR, path.join(os.homedir(), ".pi", "agent"));
});

test("source lookup requires this exact Pi claim and committed discovery, not just a claimed mux ID", (t) => {
  const sandbox = createClaimTestEnvironment();
  t.after(() => fs.rmSync(sandbox.root, { recursive: true, force: true }));
  const file = path.join(sandbox.sessions, "source.jsonl");
  fs.writeFileSync(file, "synthetic", { mode: 0o600 });
  const self = readProcessIdentity(process.pid)!;
  const handle = acquireClaim(file, { id: "mux-1", kind: "rpc", wrapper: self, pi: self, protocol: 2, socket: path.join(sandbox.root, "runtime.sock") }, sandbox.options);
  const discovery = path.join(sandbox.root, "runtime.json");
  const record: DiscoveryRecord = {
    protocol: 2, muxId: "mux-1", socket: handle.owner.socket!, pid: self.pid, piPid: self.pid, ownerIdentity: self, piIdentity: self,
    phase: "committed", cwd: sandbox.root, startedAt: "synthetic", updatedAt: "synthetic", status: "idle", blocked: null,
    session: { file, id: "source", name: null }, model: null, thinkingLevel: null, placement: "root", orchestration: null, parent: null,
  };
  writeDiscovery(discovery, record);
  const env = { ...sandbox.env, PHIMACS_MANAGED_CLAIM: JSON.stringify(handle), PIMUX_DISCOVERY: discovery };
  assert.equal(sharedMuxId(env, file), "mux-1");
  assert.equal(sharedMuxId({ PIMUX_DISCOVERY: discovery }, file), undefined, "discovery alone is not ownership");
  for (const changed of [{ ...record, protocol: 1 }, { ...record, phase: "provisional" as const }, { ...record, piPid: self.pid + 1 },
    { ...record, ownerIdentity: { ...self, startTime: `${BigInt(self.startTime) + 1n}` } }]) {
    writeDiscovery(discovery, changed);
    assert.throws(() => sharedMuxId(env, file), /ownership is unconfirmed/);
  }
  writeDiscovery(discovery, record);
  assert.throws(() => sharedMuxId({ ...env, PHIMACS_MANAGED_CLAIM: JSON.stringify({ ...handle, token: "wrong" }) }, file), /ownership is unconfirmed/);
  assert.equal(lookupClaim(file, sandbox.options)?.token, handle.token, "failed attachment does not release a live claim");
  assert.equal(fs.readFileSync(file, "utf8"), "synthetic");
  releaseClaim(handle);
});
