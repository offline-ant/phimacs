import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createClaimTestEnvironment } from "@phimacs/pimux/ownership";
import { readProcessIdentity } from "@phimacs/pimux/process-identity";
import test from "node:test";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TOOL_SELECTION_ENTRY } from "../session-tools.ts";
import { createPreparedSession, flushSessionFile, getLastSettledEntryId } from "../context.ts";
import { claimName, readTarget, removeTarget, saveTarget, tryClaimName } from "../workers.ts";
import type { HostTarget } from "../host-types.ts";
import forkHereExtension, { forkHere, forkNameBase, parseForkArgs } from "./fork-here.ts";

const args = ["--provider", "fixture", "--model", "fake", "--thinking", "high"];

/** Fake native surface, synthetic session claims and identity-bearing receipts. */
function forkFixture() {
  const synthetic = createClaimTestEnvironment();
  const previous = { ...process.env };
  Object.assign(process.env, synthetic.env, { TMPDIR: synthetic.sessions,
    PI_ORCHESTRATION_HOST: "tmux", PI_ORCHESTRATION_ENDPOINT: "/tmp/pi-fork-fake-tmux", TMUX_PANE: "%901",
    PHIMACS_PI: fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent"))) });
  const directory = fs.mkdtempSync(path.join(synthetic.sessions, "project-"));
  const prepared = createPreparedSession(directory);
  prepared.session.appendMessage({ role: "user", content: "Parent context", timestamp: Date.now() });
  flushSessionFile(prepared.session, prepared.sessionFile);
  const session = SessionManager.open(prepared.sessionFile);
  const commands: string[][] = [], prompts: string[] = [], children: string[] = [], targets: string[] = [];
  const exitedPanes = new Set<string>();
  const servers: net.Server[] = [];
  let failure: string | undefined;
  const pi = {
    getActiveTools: () => ["read", "ask", "do", "delegate", "fresh_look", "unknown-in-child"],
    getThinkingLevel: () => "high", getSessionName: () => undefined,
    exec: async (_command: string, argv: string[]) => {
      commands.push(argv);
      let stdout = "";
      if (argv.includes("split-window") || argv.includes("new-window")) {
        const file = /--session' '([^']+)'/.exec(argv.at(-1)!)?.[1];
        if (file) children.push(file);
        if (failure) throw new Error(failure);
        const socketPath = argv.find((value) => value.startsWith("PI_ORCHESTRATION_CONTROL="))?.slice("PI_ORCHESTRATION_CONTROL=".length);
        if (socketPath) {
          const server = net.createServer((socket) => {
            let text = "";
            socket.on("data", (chunk) => {
              text += String(chunk);
              if (!text.endsWith("\n")) return;
              const request = JSON.parse(text) as { kind: string; text?: string };
              if (request.kind === "prompt" && request.text) prompts.push(request.text);
              socket.end(JSON.stringify({ dispatched: true, process: readProcessIdentity(process.pid), sessionFile: file }));
            });
          });
          await new Promise<void>((resolve) => server.listen(socketPath, resolve));
          servers.push(server);
        }
        stdout = `%${902 + children.length}\n`;
      } else if (argv.includes("display-message")) stdout = exitedPanes.has(argv[argv.indexOf("-t") + 1]) ? "1\n" : "0\n";
      return { code: 0, stdout, stderr: "", killed: false };
    },
  } as unknown as ExtensionAPI;
  return { directory, session, sessionFile: prepared.sessionFile, pi, commands, prompts, children, targets, exitedPanes,
    failStart: (message: string) => { failure = message; },
    cleanup: async () => {
      for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const name of targets) removeTarget(name);
      fs.rmSync(synthetic.root, { recursive: true, force: true });
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
    } };
}

test("fork argument parsing preserves optional cwd and prompt text", () => {
  assert.deepEqual(parseForkArgs(""), { name: undefined, folder: undefined, prompt: undefined });
  assert.deepEqual(parseForkArgs("named '/tmp/a b' -- explain 'this'\nand that"), { name: "named", folder: "/tmp/a b", prompt: "explain 'this'\nand that" });
  assert.deepEqual(parseForkArgs("-- discuss"), { name: undefined, folder: undefined, prompt: "discuss" });
  assert.throws(() => parseForkArgs("one two three"), /Usage/);
  assert.throws(() => parseForkArgs("Bad"), /Name/);
  assert.throws(() => parseForkArgs("name 'folder"), /Unclosed/);
  assert.throws(() => parseForkArgs("name --unknown"), /Unknown/);
});

test("idle and prompted forks use explicit parent, actual branch and exact tools without touching parent", async () => {
  const fixture = forkFixture();
  try {
    const branch = fixture.session.getLeafId();
    fixture.session.appendMessage({ role: "user", content: "Excluded branch", timestamp: Date.now() });
    fixture.session.branch(branch!);
    const bytes = fs.readFileSync(fixture.sessionFile, "utf8");
    const name = `fork-test-${process.pid}`;
    const result = await forkHere(fixture.pi, { name }, fixture.directory, fixture.session, args);
    fixture.targets.push(result.name);
    assert.equal(fixture.prompts.length, 0);
    assert.equal(readTarget(name)?.id, result.target.id);
    assert.equal(fixture.session.getLeafId(), branch);
    assert.equal(fs.readFileSync(fixture.sessionFile, "utf8"), bytes);
    const child = SessionManager.open(result.sessionFile);
    assert.equal(child.getBranch().some((entry) => entry.type === "message" && entry.message.role === "user" && entry.message.content === "Excluded branch"), false);
    const tools = child.getBranch().findLast((entry) => entry.type === "custom" && entry.customType === TOOL_SELECTION_ENTRY);
    assert.ok(tools?.type === "custom");
    assert.deepEqual((tools.data as { enabledTools: string[] }).enabledTools, fixture.pi.getActiveTools());
    const startup = fixture.commands.find((command) => command.includes("split-window"))!;
    assert.equal(startup[startup.indexOf("-t") + 1], "%901");
    assert.ok(startup.at(-1)?.includes("'--provider' 'fixture' '--model' 'fake' '--thinking' 'high'"));
    assert.ok(!fixture.commands.some((command) => command.includes("send-keys")), "must not inject terminal text into a draft");

    const folder = path.join(fixture.directory, "another");
    fs.mkdirSync(folder);
    const prompted = await forkHere(fixture.pi, { name: `${name}-next`, folder, prompt: "Discuss\nwithout changing my draft" }, fixture.directory, fixture.session, args);
    fixture.targets.push(prompted.name);
    assert.deepEqual(fixture.prompts, ["Discuss\nwithout changing my draft"]);
    assert.equal(SessionManager.open(prompted.sessionFile).getCwd(), folder);
    assert.equal(fs.readFileSync(fixture.sessionFile, "utf8"), bytes);
    await assert.rejects(forkHere(fixture.pi, { name }, fixture.directory, fixture.session, args), /already exists/);
    assert.equal(readTarget(name)?.id, result.target.id);

    process.env.TMUX_PANE = prompted.target.id;
    const nested = await forkHere(fixture.pi, { name: `${name}-nested` }, folder, SessionManager.open(prompted.sessionFile), args);
    fixture.targets.push(nested.name);
    const nestedStartup = fixture.commands.findLast((command) => command.includes("split-window"))!;
    assert.equal(nestedStartup[nestedStartup.indexOf("-t") + 1], prompted.target.id);
    assert.equal(SessionManager.open(nested.sessionFile).getHeader()?.parentSession, prompted.sessionFile);
  } finally { await fixture.cleanup(); }
});

test("terminal forks require a parent target before preparing a session", () => {
  const synthetic = createClaimTestEnvironment();
  const source = [
    `import { SessionManager } from '@earendil-works/pi-coding-agent';`,
    `import { forkHere } from ${JSON.stringify(new URL("./fork-here.ts", import.meta.url).href)};`,
    `try { await forkHere({}, {folder: 'missing'}, process.cwd(), SessionManager.inMemory(), []); process.exitCode = 1; } catch(error) { process.stdout.write(error.message); }`,
  ].join("\n");
  try {
    for (const host of ["herdr", "tmux"]) {
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { cwd: process.cwd(), encoding: "utf8", env: {
        ...process.env, ...synthetic.env, PI_CODING_AGENT_DIR: path.join(synthetic.root, "agent"),
        PI_ORCHESTRATION_HOST: host, PI_ORCHESTRATION_ENDPOINT: `/tmp/fake-${host}`, TMUX_PANE: "", TMUX: "", HERDR_ENV: "", HERDR_PANE_ID: "",
      } });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Cannot identify the parent host target/);
    }
  } finally { fs.rmSync(synthetic.root, { recursive: true, force: true }); }
});

test("automatic fork names follow the session name, else the folder", () => {
  assert.equal(forkNameBase("Fix Mode Line!", "/x/pi"), "fix-mode-line");
  assert.equal(forkNameBase(undefined, "/home/user/projects/pi"), "pi");
  assert.equal(forkNameBase("  ", "/tmp/2026 Notes"), "notes");
  assert.equal(forkNameBase(undefined, "/"), "session");
  assert.ok(`${forkNameBase("a".repeat(60), "/")}-fork-99`.length <= 32);
});

test("concurrent unnamed forks reserve different names without changing the parent", async () => {
  const fixture = forkFixture();
  try {
    const bytes = fs.readFileSync(fixture.sessionFile, "utf8");
    const leaf = fixture.session.getLeafId();
    const forks = await Promise.all(Array.from({ length: 3 }, async () => {
      const result = await forkHere(fixture.pi, {}, fixture.directory, fixture.session, args);
      fixture.targets.push(result.name);
      return result;
    }));
    assert.equal(new Set(forks.map((fork) => fork.name)).size, 3);
    const base = `${forkNameBase(undefined, fixture.directory)}-fork`;
    for (const fork of forks) assert.match(fork.name, new RegExp(`^${base}(?:-\\d+)?$`));
    assert.equal(new Set(forks.map((fork) => fork.target.id)).size, 3);
    for (const fork of forks) {
      assert.deepEqual(readTarget(fork.name), fork.target);
      claimName(fork.name)();
    }
    assert.equal(fs.readFileSync(fixture.sessionFile, "utf8"), bytes);
    assert.equal(fixture.session.getLeafId(), leaf);
  } finally { await fixture.cleanup(); }
});

test("exited panels, workers and forks retain their registered names", async () => {
  const fixture = forkFixture();
  try {
    for (const [index, kind] of ["shell", "worker", "fork"].entries()) {
      // Reserve the lowest currently available automatic name without touching
      // another test's or user's registration or in-progress claim.
      let name = "";
      for (let number = 1; ; number++) {
        const candidate = `fork-${number}`;
        const release = tryClaimName(candidate);
        if (!release) continue;
        try {
          if (readTarget(candidate)) continue;
          name = candidate;
          const target: HostTarget = {
            host: "tmux", endpoint: "/tmp/pi-fork-fake-tmux", id: `%${980 + index}`,
            name, kind: kind === "shell" ? "shell" : "pi",
          };
          fixture.exitedPanes.add(target.id);
          fixture.targets.push(name);
          saveTarget(target);
          break;
        } finally { release(); }
      }
      const registered = readTarget(name);
      const before = fixture.commands.length;
      await assert.rejects(forkHere(fixture.pi, { name }, fixture.directory, fixture.session, args), /already exists/);
      assert.equal(fixture.commands.length, before, "reserved names must not inspect or close native targets");
      assert.deepEqual(readTarget(name), registered);
      const automatic = await forkHere(fixture.pi, {}, fixture.directory, fixture.session, args);
      fixture.targets.push(automatic.name);
      assert.notEqual(automatic.name, name);
      assert.deepEqual(readTarget(name), registered);
      assert.ok(!fixture.commands.some((command) => command.includes("kill-pane")));
      claimName(name)();
    }
  } finally { await fixture.cleanup(); }
});

test("failed startup and cancellation release the name without altering parent", async () => {
  const fixture = forkFixture();
  try {
    const name = `fork-fail-${process.pid}`;
    fixture.failStart("native startup failed");
    await assert.rejects(forkHere(fixture.pi, { name }, fixture.directory, fixture.session, args), /native startup failed/);
    assert.equal(readTarget(name), undefined);
    claimName(name)();
    for (const child of fixture.children) assert.equal(fs.existsSync(child), true, "an uncertain runtime start must retain its prepared transcript");
    const controller = new AbortController();
    controller.abort();
    const count = fixture.commands.length;
    await assert.rejects(forkHere(fixture.pi, { name }, fixture.directory, fixture.session, args, controller.signal), /abort/i);
    assert.equal(fixture.commands.length, count);
  } finally { await fixture.cleanup(); }
});

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (toolCallIds: string[], stopReason: "stop" | "toolUse" | "error" = toolCallIds.length ? "toolUse" : "stop") => ({
  role: "assistant" as const, api: "fixture", provider: "fixture", model: "fake", usage, stopReason, timestamp: Date.now(),
  content: toolCallIds.length
    ? toolCallIds.map((id) => ({ type: "toolCall" as const, id, name: "bash", arguments: {} }))
    : [{ type: "text" as const, text: "Done" }],
});
const toolResult = (toolCallId: string) => ({
  role: "toolResult" as const, toolCallId, toolName: "bash", content: [{ type: "text" as const, text: "ok" }], isError: false, timestamp: Date.now(),
});

test("a running session settles on its last finished entry", () => {
  const session = SessionManager.inMemory();
  const settled = () => getLastSettledEntryId(session.getBranch());
  assert.equal(settled(), null);
  session.appendMessage({ role: "user", content: "First", timestamp: Date.now() });
  assert.equal(settled(), null);
  const reply = session.appendMessage(assistant([]));
  assert.equal(settled(), reply);
  session.appendMessage({ role: "user", content: "Unanswered", timestamp: Date.now() });
  session.appendCustomEntry("metadata", {});
  assert.equal(settled(), reply);
  session.appendMessage(assistant([], "error"));
  assert.equal(settled(), reply);
  session.appendMessage(assistant(["a", "b"]));
  assert.equal(settled(), reply);
  session.appendMessage(toolResult("a"));
  assert.equal(settled(), reply);
  const batch = session.appendMessage(toolResult("b"));
  assert.equal(settled(), batch);
  session.appendMessage({ role: "user", content: "Steering", timestamp: Date.now() });
  assert.equal(settled(), batch);
  session.appendMessage(assistant(["c"]));
  assert.equal(settled(), batch);
  const compaction = session.appendCompaction("Summary", batch, 0);
  session.appendMessage({ role: "user", content: "After compaction", timestamp: Date.now() });
  assert.equal(settled(), compaction);
});

test("fork shortcut leaves an unsent draft and session unchanged; a busy parent forks its last finished entry", async () => {
  const fixture = forkFixture();
  type Handler = (args: unknown, ctx?: unknown) => Promise<void>;
  const commands = new Map<string, Handler>();
  const shortcuts = new Map<string, Handler>();
  Object.assign(fixture.pi, {
    on: () => undefined,
    registerCommand: (name: string, command: { handler: Handler }) => commands.set(name, command.handler),
    registerShortcut: (name: string, command: { handler: Handler }) => shortcuts.set(name, command.handler),
  });
  forkHereExtension(fixture.pi);
  let idle = true;
  const draft = "my unsent parent draft";
  const ctx = {
    cwd: fixture.directory,
    sessionManager: fixture.session,
    model: { provider: "fixture", id: "fake" },
    isIdle: () => idle, hasPendingMessages: () => false,
    ui: {
      getEditorText: () => draft,
      setEditorText: () => assert.fail("fork modified draft"),
      notify: (text: string) => { if (text.startsWith("Started ")) fixture.targets.push(text.slice(8, -1)); },
    },
  };
  try {
    assert.deepEqual([...commands.keys()], ["fork-here"]);
    const parent = fs.readFileSync(fixture.sessionFile, "utf8");
    await shortcuts.get("ctrl+alt+f")!(ctx);
    assert.equal(fixture.targets.length, 1);
    assert.equal(ctx.ui.getEditorText(), draft);
    assert.equal(fs.readFileSync(fixture.sessionFile, "utf8"), parent);
    const finished = fixture.session.appendMessage(assistant([]));
    fixture.session.appendMessage(assistant(["running"]));
    idle = false;
    await shortcuts.get("ctrl+alt+f")!(ctx);
    assert.equal(fixture.targets.length, 2);
    const child = SessionManager.open(fixture.children.at(-1)!);
    assert.equal(child.getBranch().some((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "toolUse"), false);
    assert.ok(child.getBranch().some((entry) => entry.id === finished));
  } finally { await fixture.cleanup(); }
});
