import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { availableHosts, getHost, getHostState, hostForTarget, selectHost, setHostOverride } from "./host.ts";
import type { HostKind, HostTarget, StartSpec } from "./host-types.ts";
import { initializeNesting } from "./nesting.ts";

const inheritedNesting = process.env.PI_NESTED;
const inheritedPi = process.env.PHIMACS_PI;
const PI = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
before(() => { process.env.PI_NESTED = "0"; process.env.PHIMACS_PI = PI; });
after(() => {
  if (inheritedNesting === undefined) delete process.env.PI_NESTED;
  else process.env.PI_NESTED = inheritedNesting;
  if (inheritedPi === undefined) delete process.env.PHIMACS_PI; else process.env.PHIMACS_PI = inheritedPi;
});

test("host selection rejects ambiguous native environments and missing endpoints", () => {
  assert.throws(() => selectHost({}), /needs tmux, Herdr, or Pilish/);
  assert.throws(() => selectHost({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/h", TMUX: "/tmp/t,1,0" }), /Several orchestration hosts are present \(tmux, herdr\)/);
  assert.throws(() => selectHost({ PI_ORCHESTRATION_HOST: "emacs" }), /No emacs endpoint/);
  assert.throws(() => selectHost({ PI_ORCHESTRATION_HOST: "unknown" }), /PI_ORCHESTRATION_HOST must be one of tmux, herdr, emacs/);
  assert.deepEqual(selectHost({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/h" }), { kind: "herdr", endpoint: "/tmp/h" });
  assert.deepEqual(selectHost({ TMUX: "/tmp/t,1,0" }), { kind: "tmux", endpoint: "/tmp/t" });
  assert.deepEqual(selectHost({ PI_ORCHESTRATION_HOST: "tmux", HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/h", TMUX: "/tmp/t,1,0" }), { kind: "tmux", endpoint: "/tmp/t" });
  assert.deepEqual(selectHost({ PI_ORCHESTRATION_HOST: "emacs", PI_ORCHESTRATION_ENDPOINT: "/tmp/e" }), { kind: "emacs", endpoint: "/tmp/e" });
});

test("the explicit endpoint belongs to the explicit host; other reachable hosts keep their native endpoints", () => {
  const env = { PI_ORCHESTRATION_HOST: "emacs", PI_ORCHESTRATION_ENDPOINT: "/tmp/e", HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/h", TMUX: "/tmp/t,1,0" };
  assert.deepEqual(availableHosts(env), [
    { kind: "tmux", endpoint: "/tmp/t" }, { kind: "herdr", endpoint: "/tmp/h" }, { kind: "emacs", endpoint: "/tmp/e" },
  ]);
  assert.deepEqual(selectHost(env), { kind: "emacs", endpoint: "/tmp/e" });
  assert.deepEqual(availableHosts({ PI_ORCHESTRATION_HOST: "herdr", PI_ORCHESTRATION_ENDPOINT: "/tmp/pinned", HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/h" }),
    [{ kind: "herdr", endpoint: "/tmp/pinned" }]);
  assert.deepEqual(availableHosts({ PI_ORCHESTRATION_ENDPOINT: "/tmp/orphan" }), []);
});

test("selection is frozen per process; overrides choose among reachable hosts; stored targets retain their original host", () => {
  const keys = ["PI_ORCHESTRATION_HOST", "PI_ORCHESTRATION_ENDPOINT", "HERDR_ENV", "HERDR_SOCKET_PATH", "TMUX"];
  const previous = keys.map((key) => process.env[key]);
  const pi = {} as ExtensionAPI;
  try {
    process.env.PI_ORCHESTRATION_HOST = "emacs";
    process.env.PI_ORCHESTRATION_ENDPOINT = "/tmp/original";
    process.env.HERDR_ENV = "1";
    process.env.HERDR_SOCKET_PATH = "/tmp/herdr";
    delete process.env.TMUX;
    assert.equal(getHost(pi).kind, "emacs");
    process.env.PI_ORCHESTRATION_HOST = "tmux";
    process.env.PI_ORCHESTRATION_ENDPOINT = "/tmp/new";
    process.env.HERDR_SOCKET_PATH = "/tmp/other";
    assert.equal(getHost(pi).endpoint, "/tmp/original");
    assert.equal(getHost(pi).kind, "emacs");

    setHostOverride("herdr");
    assert.equal(getHost(pi).kind, "herdr");
    assert.equal(getHost(pi).endpoint, "/tmp/herdr", "an override never reuses the environment host's endpoint");
    assert.deepEqual(getHostState().configured, { kind: "emacs", endpoint: "/tmp/original" });
    setHostOverride("tmux");
    assert.equal(getHostState().effective, undefined);
    assert.throws(() => getHost(pi), /'tmux' is not reachable.*reachable: herdr, emacs/);
    setHostOverride(null);
    assert.equal(getHost(pi).kind, "emacs");

    const pinned = hostForTarget(pi, { host: "tmux", endpoint: "/tmp/stored", id: "%1", name: "stored", kind: "pi" });
    assert.equal(pinned.kind, "tmux");
    assert.equal(pinned.endpoint, "/tmp/stored");
  } finally {
    setHostOverride(null);
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
    });
  }
});

test("Pi startup is serialized across extension APIs; cancelled queued work never starts", async () => {
  let release!: () => void;
  const firstStartup = new Promise<void>((resolve) => { release = resolve; });
  const started: string[] = [];
  const pi = {
    exec: async (_command: string, args: string[]) => {
      if (args.includes("display-message")) return { code: 0, stderr: "", killed: false, stdout: "$1" };
      assert.ok(args.includes("new-window"));
      started.push(args[args.indexOf("-n") + 1]);
      if (started.length === 1) await firstStartup;
      throw new Error("controlled native startup stopped");
    },
  } as unknown as ExtensionAPI;
  const target: HostTarget = { host: "tmux", endpoint: "/tmp/serialized-tmux", id: "%4", name: "parent", kind: "pi" };
  const firstHost = hostForTarget(pi, target);
  const secondHost = hostForTarget({ ...pi } as ExtensionAPI, target);
  const spec: StartSpec = { kind: "pi", cwd: "/tmp", name: "first", sessionFile: "/tmp/session", args: [], placement: "worker", parent: target };
  const first = assert.rejects(firstHost.start(spec), /controlled native startup stopped/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const cancel = new AbortController();
  const cancelled = assert.rejects(secondHost.start({ ...spec, name: "cancelled" }, cancel.signal), /abort/i);
  const second = assert.rejects(secondHost.start({ ...spec, name: "second" }), /controlled native startup stopped/);
  cancel.abort();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["first"]);
  release();
  await cancelled;
  await Promise.all([first, second]);
  assert.deepEqual(started, ["first", "second"]);
});

test("all hosts receive the parent's activated depth, remote target, placement, parent and pinned selection before native startup", async () => {
  const depthKey = Symbol.for("pi-orchestration:nesting-depth");
  const globals = globalThis as typeof globalThis & { [depthKey]?: number };
  const savedDepth = globals[depthKey];
  const savedEnv = process.env.PI_NESTED;
  const savedAgentDirectory = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = "/tmp/parent-agent-directory";
  const savedRemote = process.env.PI_REMOTE;
  process.env.PI_REMOTE = "me@box:/srv";
  delete globals[depthKey];
  process.env.PI_NESTED = "1";
  initializeNesting();
  try {
    for (const kind of ["tmux", "herdr"] as const) {
      const endpoint = `/tmp/depth-${kind}`;
      let checkedEnvironment = false;
      const pi = {
        exec: async (_command: string, args: string[]) => {
          if (kind === "tmux" && args.includes("display-message")) {
            return { code: 0, stdout: "$1\n", stderr: "", killed: false };
          }
          if (kind === "herdr" && args.includes("get")) {
            return { code: 0, stdout: JSON.stringify({ result: { pane: { workspace_id: "workspace" } } }), stderr: "", killed: false };
          }
          {
            const parentEntry = `PI_ORCHESTRATION_PARENT=${JSON.stringify({ host: kind, endpoint, id: "parent", name: "parent" })}`;
            for (const entry of ["PI_REMOTE=me@box:/srv", "PI_NESTED=2", "PI_ORCHESTRATION_PLACEMENT=worker", `PI_ORCHESTRATION_HOST=${kind}`, `PI_ORCHESTRATION_ENDPOINT=${endpoint}`, "CUSTOM=preserved", "PI_CODING_AGENT_DIR=/tmp/parent-agent-directory", parentEntry]) {
              assert.ok(args.includes(entry), `Missing ${entry}: ${JSON.stringify(args)}`);
            }
            assert.ok(args.includes("PHIMACS_MANAGED_CLAIM="), "ancestor's capability is never inherited");
          }
          checkedEnvironment = true;
          throw new Error("fake native creation stopped");
        },
      } as unknown as ExtensionAPI;
      const parent: HostTarget = { host: kind, endpoint, id: "parent", kind: "pi", name: "parent" };
      await assert.rejects(hostForTarget(pi, parent).start({
        kind: "pi", name: "child", cwd: "/tmp", sessionFile: "/tmp/not-started", args: [], placement: "worker", parent,
        env: { CUSTOM: "preserved", PI_NESTED: "99", PI_ORCHESTRATION_HOST: "wrong", PI_ORCHESTRATION_ENDPOINT: "wrong" },
      }), /fake native creation stopped/);
      assert.equal(checkedEnvironment, true, kind);
    }
  } finally {
    if (savedDepth === undefined) delete globals[depthKey]; else globals[depthKey] = savedDepth;
    if (savedEnv === undefined) delete process.env.PI_NESTED; else process.env.PI_NESTED = savedEnv;
    if (savedAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgentDirectory;
    if (savedRemote === undefined) delete process.env.PI_REMOTE; else process.env.PI_REMOTE = savedRemote;
  }
});

test("a PATH Pi cannot authorize managed orchestration even if native hosts are available", async () => {
  let calls = 0;
  const pi = { exec: async () => { calls++; throw new Error("must not spawn"); } } as unknown as ExtensionAPI;
  const parent: HostTarget = { host: "tmux", endpoint: "/tmp/candidate-tmux", id: "%4", name: "parent", kind: "pi" };
  await assert.rejects(hostForTarget(pi, parent).start({ kind: "pi", cwd: "/tmp", name: "child", sessionFile: "/tmp/not-opened", args: [], placement: "worker", parent, env: { PHIMACS_PI: "pi" } }), /absolute runtime executable/);
  assert.equal(calls, 0);
});

test("depth-limit Pi starts reject before host operations; shell cancellation bypasses the depth limit", async () => {
  const depthKey = Symbol.for("pi-orchestration:nesting-depth");
  const globals = globalThis as typeof globalThis & { [depthKey]?: number };
  const savedDepth = globals[depthKey];
  globals[depthKey] = 3;
  try {
    for (const kind of ["tmux", "herdr", "emacs"] satisfies HostKind[]) {
      let calls = 0;
      const pi = { exec: async () => { calls++; throw new Error("shell reached native host"); } } as unknown as ExtensionAPI;
      const parent: HostTarget = { host: kind, endpoint: "/tmp/limit", id: "parent", kind: "pi", name: "parent" };
      const host = hostForTarget(pi, parent);
      await assert.rejects(host.start({ kind: "pi", name: "too-deep", cwd: "/tmp", sessionFile: "/tmp/not-started", args: [], placement: "worker", parent }), /nested too deep/);
      assert.equal(calls, 0, kind);
      await assert.rejects(async () => host.start({ kind: "shell", name: "shell", cwd: "/tmp", argv: ["true"], placement: "worker", parent }, AbortSignal.abort(new Error("shell reached native host"))), /shell reached native host/);
      assert.equal(calls, 0);
    }
  } finally {
    if (savedDepth === undefined) delete globals[depthKey]; else globals[depthKey] = savedDepth;
  }
});
