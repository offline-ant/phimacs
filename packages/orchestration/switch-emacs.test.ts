import assert from "node:assert/strict";
import test from "node:test";
import type { EmacsExec } from "./hosts/emacs.ts";
import { emacsDaemon, emacsLauncherEnvironment, prepareEmacsSwitch } from "./switch-emacs.ts";
import type { SwitchSource } from "./switch-destinations.ts";

const source: SwitchSource = {
  sessionFile: "/tmp/fixture/session.jsonl", cwd: "/tmp/fixture",
  args: ["--provider", "fixture", "--model", "one", "--thinking", "high"], runtime: { protocol: 2, muxId: "shared-runtime" },
  env: { PI_CODING_AGENT_DIR: "/tmp/agent", PI_ORCHESTRATION_TARGET: "", PI_NESTED: "", HERDR_SOCKET_PATH: "/tmp/herdr.sock" },
};

/** Decodes companion operations from emacsclient arguments and answers them. */
function companion(answer: (data: Record<string, unknown>) => Record<string, unknown>) {
  const operations: Record<string, unknown>[] = [];
  const exec: EmacsExec = async (command, args) => {
    assert.equal(command, "emacsclient");
    assert.deepEqual(args.slice(0, 3), ["--socket-name", "/tmp/emacs/pi", "--eval"]);
    const encoded = /pi-orchestration-dispatch "([^"]+)"/.exec(args[3]!)![1]!;
    const data = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Record<string, unknown>;
    operations.push(data);
    const reply = Buffer.from(JSON.stringify(answer(data)), "utf8").toString("base64");
    return { code: 0, stdout: `${JSON.stringify(reply)}\n`, stderr: "", killed: false };
  };
  return { exec, operations };
}

test("Emacs switch attaches the same managed runtime and waits for confirmed readiness", async () => {
  let polls = 0;
  const { exec, operations } = companion((data) => {
    if (data.operation === "switch") return { buffer: "*pilish-chat:/tmp/fixture/*", refreshed: false, muxId: "shared-runtime" };
    return { state: "running", ready: ++polls >= 3, failure: null, muxId: "shared-runtime" };
  });
  const location = await (await prepareEmacsSwitch(source, "/tmp/emacs/pi", exec)).start();
  assert.equal(location, "Emacs /tmp/emacs/pi, attached buffer *pilish-chat:/tmp/fixture/* (runtime shared-runtime)");
  const opened = operations[0]!;
  assert.equal(opened.operation, "switch");
  assert.equal(opened.sessionFile, source.sessionFile);
  assert.equal(opened.cwd, source.cwd);
  assert.deepEqual(opened.args, []);
  assert.equal(opened.muxId, "shared-runtime");
  // The companion's session hook supplies host, endpoint and target identity.
  assert.deepEqual(opened.env, { PI_CODING_AGENT_DIR: "/tmp/agent", PI_NESTED: "", HERDR_SOCKET_PATH: "/tmp/herdr.sock" });
  assert.deepEqual(operations.slice(1).map((data) => [data.operation, data.id, data.close]),
    Array(3).fill(["switch-state", opened.id, undefined]));
});

test("readiness polling outlasts an Emacs that does not answer", async () => {
  let polls = 0;
  const { exec } = companion((data) => data.operation === "switch" ? { buffer: "chat", refreshed: false, muxId: "shared-runtime" } : { state: "running", ready: true, muxId: "shared-runtime" });
  const stalling: EmacsExec = async (command, args, options) => args[3]!.includes("dispatch") && ++polls === 2
    ? { code: 0, stdout: "", stderr: "", killed: true } : exec(command, args, options);
  assert.match(await (await prepareEmacsSwitch(source, "/tmp/emacs/pi", stalling)).start(), /buffer chat/);
  assert.equal(polls, 3);
});

test("failed attachment detaches only its new view and leaves a pre-existing view alone", async () => {
  for (const refreshed of [false, true]) {
    const { exec, operations } = companion((data) => data.operation === "switch"
      ? { buffer: "chat", refreshed, muxId: "shared-runtime" } : { state: "running", ready: false, failure: "Pi opened a different session file" });
    await assert.rejects((await prepareEmacsSwitch(source, "/tmp/emacs/pi", exec)).start(),
      /Emacs switch failed \(Pi opened a different session file\)\. No source view was closed/);
    if (refreshed) assert.equal(operations.some(operation => operation.close), false, "an existing view receives no cleanup request");
    else assert.deepEqual(operations.at(-1), { operation: "switch-state", id: operations[0]!.id, close: true, detachOnly: true, muxId: "shared-runtime" });
  }
  const { exec, operations } = companion(() => ({ error: "The Emacs view of this session is busy or has queued input; finish it first" }));
  await assert.rejects((await prepareEmacsSwitch(source, "/tmp/emacs/pi", exec)).start(), /busy or has queued input.*No source view was closed/s);
  assert.equal(operations.length, 1, "nothing to clean up when opening was refused");
});

test("failed new-view cleanup preserves both errors and never requests agent stop", async () => {
  const { exec, operations } = companion(data => data.operation === "switch"
    ? { buffer: "chat", refreshed: false, muxId: "shared-runtime" }
    : data.close ? { error: "view detach was not acknowledged" } : { state: "running", failure: "attachment failed" });
  await assert.rejects((await prepareEmacsSwitch(source, "/tmp/emacs/pi", exec)).start(),
    /attachment failed.*No source view was closed.*New-view cleanup is uncertain:.*view detach was not acknowledged/);
  assert.equal(operations.at(-1)!.detachOnly, true);
  assert.equal(operations.at(-1)!.muxId, "shared-runtime");
});

test("the absolute checkout launcher resolves its daemon without leaking writer/task capabilities", async () => {
  const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const environment = { HOME: "/home/x", PATH: "/bin", PHIMACS_EMACS_LAUNCHER: process.execPath, HERDR_ENV: "1", HERDR_PANE_ID: "p1",
    PHIMACS_MANAGED_CLAIM: "private", PIMUX_DISCOVERY: "private", PHIMACS_PARENT_TASK: "private", PHIMACS_PARENT_TASK_FILE: "private",
    PI_ORCHESTRATION_HOST: "herdr", PI_ORCHESTRATION_ENDPOINT: "/tmp/herdr.sock", PI_ORCHESTRATION_CONTROL: "/tmp/c", PI_REMOTE: "me@box:/srv", TMUX: "x" };
  const socket = await emacsDaemon(environment, async (command, args, options) => {
    calls.push({ command, args, env: options.env });
    return { code: 0, stdout: '\x1b[1 q{"socket":"/tmp/emacs/disposable"}\n', stderr: "Starting Emacs daemon.\n", killed: false };
  });
  assert.equal(socket, "/tmp/emacs/disposable");
  assert.deepEqual(calls.map(({ command, args }) => [command, args]), [[process.execPath, ["--no-frame", "--json"]]]);
  assert.deepEqual(calls[0]!.env, { HOME: "/home/x", PATH: "/bin", PHIMACS_EMACS_LAUNCHER: process.execPath });
  assert.deepEqual(emacsLauncherEnvironment({ PI_REMOTE: "me@box:/srv", PI_NESTED: "1", TMUX_PANE: "%1", KEEP: "y" }), { KEEP: "y" });
  await assert.rejects(emacsDaemon(environment, async () => ({ code: 1, stdout: "", stderr: "emacsclient: can't find socket\n", killed: false })),
    /checkout's Emacs launcher did not confirm its Emacs daemon: emacsclient: can't find socket/);
  await assert.rejects(emacsDaemon(environment, async () => ({ code: 0, killed: true, stdout: '{"socket":"/tmp/emacs/unconfirmed"}', stderr: "" })),
    /checkout's Emacs launcher did not confirm/);
  await assert.rejects(emacsDaemon(environment, async () => { throw Object.assign(new Error("spawn launcher ENOENT"), { code: "ENOENT" }); }),
    /checkout's Emacs launcher failed/);
  await assert.rejects(emacsDaemon({ PHIMACS_EMACS_LAUNCHER: "emacs-launch.mjs" }), /absolute launcher/);
});

test("wrong runtime readiness can only detach the new view, never request agent stop", async () => {
  const { exec, operations } = companion(data => data.operation === "switch"
    ? { buffer: "chat", muxId: "shared-runtime" }
    : { state: "running", ready: true, muxId: "wrong-runtime" });
  await assert.rejects((await prepareEmacsSwitch(source, "/tmp/emacs/pi", exec)).start(), /same shared runtime/);
  assert.equal(operations.at(-1)!.detachOnly, true);
  assert.equal(operations.at(-1)!.muxId, "shared-runtime");
});

test("an explicitly selected Emacs host is used only when it already runs", async () => {
  const environment = { PI_ORCHESTRATION_HOST: "emacs", PI_ORCHESTRATION_ENDPOINT: "/tmp/emacs/other" };
  const seen: string[][] = [];
  assert.equal(await emacsDaemon(environment, async (command, args) => {
    seen.push([command, ...args]);
    return { code: 0, stdout: "t\n", stderr: "", killed: false };
  }), "/tmp/emacs/other");
  assert.deepEqual(seen, [["emacsclient", "--socket-name", "/tmp/emacs/other", "--eval", "t"]]);
  for (const unreachable of [{ code: 1, killed: false }, { code: 0, killed: true }]) {
    await assert.rejects(emacsDaemon(environment, async () => ({ ...unreachable, stdout: "", stderr: "" })),
      /Cannot reach the Emacs server \/tmp\/emacs\/other; \/switch starts only the daemon of PHIMACS_EMACS_LAUNCHER/);
  }
});
