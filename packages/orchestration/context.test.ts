import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { acquireClaim, createClaimTestEnvironment, lookupClaim, releaseClaim } from "@phimacs/pimux/ownership";
import { readProcessIdentity } from "@phimacs/pimux/process-identity";
import { fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime, resolveCliModel, SessionManager, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { createPreparedSession, flushSessionFile, getPreToolCallLeafId, modelCliArgs, prepareDelegateSession } from "./context.ts";

function assistant(content: Extract<Extract<SessionEntry, { type: "message" }>["message"], { role: "assistant" }>["content"]): Extract<Extract<SessionEntry, { type: "message" }>["message"], { role: "assistant" }> {
  return { role: "assistant", content, timestamp: Date.now(), stopReason: "stop", api: "openai-responses", provider: "fake", model: "fake", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

test("inherited sessions fork before sibling calls without changing parent branch or file", () => {
  const synthetic = createClaimTestEnvironment();
  const previous = process.env.PHIMACS_TEST_ROOT;
  process.env.PHIMACS_TEST_ROOT = synthetic.root;
  const root = synthetic.sessions;
  const prepared = createPreparedSession(root);
  let session = prepared.session;
  const parentFile = prepared.sessionFile;
  const childFiles: string[] = [];
  try {
    session.appendSessionInfo("Original parent title");
    const before = session.appendMessage({ role: "user", content: "Shared context", timestamp: Date.now() });
    session.appendMessage(assistant([
      { type: "toolCall", id: "a", name: "do", arguments: {} },
      { type: "toolCall", id: "b", name: "do", arguments: {} },
      { type: "toolCall", id: "standalone", name: "delegate", arguments: {} },
    ]));
    // Even a title outside the selected child branch is copied by do.
    session.appendSessionInfo("Later parent title");
    flushSessionFile(session, parentFile);
    session = SessionManager.open(parentFile);
    // The loaded manager is authoritative. A new mutable source open would
    // repair this partial tail, or copy it instead of the in-memory snapshot.
    fs.appendFileSync(parentFile, '{"unfinished":');
    const original = fs.readFileSync(parentFile, "utf8");
    const parentLeaf = session.getLeafId();
    const parentEntries = structuredClone(session.getEntries());
    const ctx = { cwd: root, sessionManager: session, thinkingLevel: "high", model: { provider: "fake", id: "fake" } } as unknown as ExtensionContext;
    const runtime = { model: { provider: "other", id: "alternate" }, thinkingLevel: "high" };
    for (const id of ["a", "b"]) {
      assert.equal(getPreToolCallLeafId(session, "do", id), before);
      const child = prepareDelegateSession({ tool: "do", task: `Review only src/${id}.ts` }, ctx, { toolName: "do", toolCallId: id }, runtime);
      childFiles.push(child.sessionFile);
      const fork = SessionManager.open(child.sessionFile);
      assert.equal(child.sessionId, fork.getHeader()!.id);
      assert.equal(fork.getSessionName(), `☀️ ${id}.ts`);
      assert.deepEqual(fork.getEntries().filter((entry) => entry.type === "session_info").map((entry) => entry.name),
        ["Original parent title", "Later parent title", `☀️ ${id}.ts`]);
      assert.equal(fork.getHeader()!.parentSession, parentFile);
      assert.equal(fork.getBranch().filter((entry) => entry.type === "message").length, 1);
      assert.deepEqual(child.args, ["--provider", "other", "--model", "alternate", "--thinking", "high"]);
    }
    assert.notEqual(childFiles[0], childFiles[1]);
    assert.equal(fs.readFileSync(parentFile, "utf8"), original);
    assert.equal(session.getLeafId(), parentLeaf);
    assert.equal(session.getSessionName(), "Later parent title");
    assert.deepEqual(session.getEntries(), parentEntries);
    assert.throws(() => getPreToolCallLeafId(session, "do", "missing"), /refusing to fork/);
    assert.throws(() => prepareDelegateSession({ tool: "do", task: "Task" }, ctx, { toolName: "do", toolCallId: "standalone" }, runtime), /refusing to fork/);
    assert.throws(() => prepareDelegateSession({ tool: "do", task: "Task", folder: "/tmp" }, ctx, { toolName: "do", toolCallId: "a" }, runtime), /cannot change|folder/);
    const otherFolder = path.join(root, "other-project");
    fs.mkdirSync(otherFolder);
    const project = prepareDelegateSession({ tool: "delegate", task: "Independent subtask: implement the new src/module.ts", folder: otherFolder }, ctx, { toolName: "delegate", toolCallId: "standalone" }, runtime);
    childFiles.push(project.sessionFile);
    assert.equal(SessionManager.open(project.sessionFile).getBranch().filter((entry) => entry.type === "message").length, 0);
    assert.equal(project.cwd, otherFolder);
    assert.equal(project.sessionId, SessionManager.open(project.sessionFile).getHeader()!.id);
    assert.equal(SessionManager.open(project.sessionFile).getCwd(), otherFolder);
    assert.equal(SessionManager.open(project.sessionFile).getSessionName(), "🔨 independent module.ts");
    const clean = prepareDelegateSession({ tool: "fresh_look", task: "READ-ONLY review of the src/module.ts", folder: otherFolder }, ctx, { toolName: "fresh_look", toolCallId: "a" }, runtime);
    childFiles.push(clean.sessionFile);
    assert.equal(clean.cwd, otherFolder);
    assert.equal(SessionManager.open(clean.sessionFile).getSessionName(), "☀️ read-only module.ts");
    assert.equal(SessionManager.open(clean.sessionFile).getBranch().filter((entry) => entry.type === "message").length, 0);
    assert.ok(clean.args.includes("--no-context-files"));
    assert.ok(!clean.args.includes("--no-extensions"));
    assert.deepEqual(project.args, ["--provider", "other", "--model", "alternate", "--thinking", "high"]);
    assert.deepEqual(clean.args.slice(0, 6), project.args);
    assert.deepEqual(ctx.model, { provider: "fake", id: "fake" }, "selected worker model must not change the parent");
  } finally {
    for (const file of childFiles) fs.rmSync(file, { force: true });
    if (previous === undefined) delete process.env.PHIMACS_TEST_ROOT;
    else process.env.PHIMACS_TEST_ROOT = previous;
    fs.rmSync(synthetic.root, { recursive: true, force: true });
  }
});

test("child model arguments round-trip through Pi's CLI resolver or explicitly reject ambiguous identifiers", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-cli-test-"));
  try {
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(), modelsPath: null,
      modelsStorePath: path.join(root, "models-store.json"), refreshOnCreate: false,
    });
    const provider = fauxProvider({ provider: "example", models: [
      { id: "review" }, { id: "vendor/review" }, { id: "review:high" }, { id: "example/review" },
    ] });
    runtime.registerNativeProvider(provider.provider);
    for (const model of provider.models.slice(0, 3)) {
      const args = modelCliArgs(model, "off");
      const resolved = resolveCliModel({ cliProvider: args[1], cliModel: args[3], cliThinking: "off", modelRuntime: runtime });
      assert.equal(resolved.error, undefined);
      assert.equal(resolved.warning, undefined);
      assert.equal(resolved.model?.provider, model.provider);
      assert.equal(resolved.model?.id, model.id);
    }
    // The unguarded old arguments resolve to review, not the requested example/review.
    assert.equal(resolveCliModel({ cliProvider: "example", cliModel: "example/review", modelRuntime: runtime }).model?.id, "review");
    assert.throws(() => modelCliArgs(provider.models[3], "off"), /provider prefix ambiguously/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("child model arguments require a selected model", () => {
  assert.throws(() => modelCliArgs(undefined, "high"), /no selected model/);
});

test("preparation claims precede exclusive initialization and release after descriptor closure", () => {
  const synthetic = createClaimTestEnvironment();
  const previous = process.env.PHIMACS_TEST_ROOT;
  process.env.PHIMACS_TEST_ROOT = synthetic.root;
  try {
    const persistent = SessionManager.create(synthetic.sessions, synthetic.sessions);
    assert.throws(() => flushSessionFile(persistent, persistent.getSessionFile()!), /in-memory manager/);
    assert.equal(fs.existsSync(persistent.getSessionFile()!), false);
    const { session, sessionFile } = createPreparedSession(synthetic.sessions);
    session.appendCustomEntry("before-write", { value: 1 });
    session.appendSessionInfo("Claimed worker title");
    assert.equal(fs.existsSync(sessionFile), false, "in-memory appends, including titles, must never persist before claiming");
    const lease = acquireClaim(sessionFile, { id: "other-preparer", kind: "lease", wrapper: readProcessIdentity(process.pid)!, pi: null });
    assert.throws(() => flushSessionFile(session, sessionFile), /owned by lease/);
    assert.equal(fs.existsSync(sessionFile), false);
    releaseClaim(lease);
    flushSessionFile(session, sessionFile);
    assert.equal(lookupClaim(sessionFile), undefined, "no preparation writer survives synchronous initialization");
    const original = fs.readFileSync(sessionFile, "utf8");
    assert.equal(JSON.parse(original.trim().split("\n").at(-1)!).name, "Claimed worker title");
    session.appendCustomEntry("after-write", { value: 2 });
    assert.equal(fs.readFileSync(sessionFile, "utf8"), original, "memory manager must stay independent after lease release");
    assert.throws(() => flushSessionFile(session, sessionFile), { code: "EEXIST" });
    assert.equal(fs.readFileSync(sessionFile, "utf8"), original);
    assert.equal(lookupClaim(sessionFile), undefined);
  } finally {
    if (previous === undefined) delete process.env.PHIMACS_TEST_ROOT;
    else process.env.PHIMACS_TEST_ROOT = previous;
    fs.rmSync(synthetic.root, { recursive: true, force: true });
  }
});

test("independent preparation processes cannot overwrite the same allocated path", async () => {
  const synthetic = createClaimTestEnvironment();
  const file = path.join(synthetic.sessions, "collision.jsonl");
  const source = [
    `import { SessionManager } from '@earendil-works/pi-coding-agent';`,
    `import { flushSessionFile } from ${JSON.stringify(new URL("./context.ts", import.meta.url).href)};`,
    `const session = SessionManager.inMemory(process.cwd()); session.appendCustomEntry('preparer', process.argv[2]);`,
    `process.stdout.write('ready\\n'); process.stdin.once('data', () => { try { flushSessionFile(session, process.argv[1]); process.stdout.write('written\\n'); } catch(error) { process.stdout.write('refused:' + (error.code || error.name) + '\\n'); } process.stdin.destroy(); });`,
  ].join("\n");
  const children = ["first", "second"].map((id) => spawn(process.execPath, ["--input-type=module", "-e", source, file, id], {
    cwd: process.cwd(), env: { ...process.env, ...synthetic.env }, stdio: ["pipe", "pipe", "pipe"],
  }));
  try {
    const outcomes = await Promise.all(children.map((child) => new Promise<string>((resolve, reject) => {
      let output = "";
      let diagnostics = "";
      let started = false;
      child.stderr.on("data", (chunk) => { diagnostics += String(chunk); });
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
        if (!started && output.includes("ready\n")) { started = true; child.stdin.end("start\n"); }
      });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve(output) : reject(new Error(diagnostics || `preparer exited ${code}`)));
    })));
    assert.equal(outcomes.filter((output) => output.includes("written\n")).length, 1);
    assert.equal(outcomes.filter((output) => /refused:(CLAIM_CONFLICT|EEXIST)/.test(output)).length, 1);
    const entries = fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(entries.length, 2);
    assert.equal(entries[1].customType, "preparer");
    assert.ok(["first", "second"].includes(entries[1].data));
    assert.equal(lookupClaim(file, synthetic.options), undefined);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    fs.rmSync(synthetic.root, { recursive: true, force: true });
  }
});
