import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools, InMemoryCredentialStore, type JsonObject, type Tool } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, createCodemodeExtension, ModelRuntime,
  SessionManager, SettingsManager, type AgentSessionRuntime, type AgentToolResult, type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { EphemeralWorkerTool } from "../delegate-policy.ts";
import type { WorkerRequestFile } from "../worker-frame.ts";
import { WORKER_ENTRY, workerResumeCommand, workerStoppedNotice, type WorkerRecord } from "../worker-resume.ts";
import { claimName, readTarget } from "../workers.ts";
import delegateExtension, { type DelegateParams } from "./delegate.ts";
import { installSshStub, setSessionRemote } from "../test/ssh-stub.ts";
import { forkFixture } from "../test/fork-fixture.ts";

const alternateToolNames = ["do", "delegate", "fresh_look"] as const;
const toolNames = ["do", "microdo", "delegate", "fresh_look"] as const;
interface Launch { args: string[]; sessionFile: string; env: Record<string, string> }

function hasAlt(tool: Tool): boolean {
  const schema = tool.parameters as { properties: Record<string, unknown> };
  return Object.hasOwn(schema.properties, "alt");
}

/** Real Pi SDK runtime, registrations and worker protocol; no browser process or paid inference. */
async function fixture(t: TestContext, codemodeOnly = false) {
  // Each fixture represents a new Pi process; host selection is process-pinned.
  const hostStateKey = Symbol.for("pi-ant.orchestration.host");
  const globals = globalThis as typeof globalThis & { [hostStateKey]?: unknown };
  const previousHostState = globals[hostStateKey];
  delete globals[hostStateKey];
  t.after(() => {
    if (previousHostState === undefined) delete globals[hostStateKey];
    else globals[hostStateKey] = previousHostState;
  });
  setSessionRemote(t, undefined);
  const transport = forkFixture();
  const directory = transport.directory;
  const agentDir = path.join(directory, "agent");
  const config = path.join(agentDir, "delegate-alt.json");
  const keys = ["PI_CODING_AGENT_DIR"];
  const previous = keys.map((key) => process.env[key]);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const first = fauxProvider({ provider: "delegate-first", models: [{ id: "same-id", reasoning: true }], tokensPerSecond: 100_000 });
  const second = fauxProvider({ provider: "delegate-second", models: [{ id: "same-id", reasoning: false }], tokensPerSecond: 100_000 });
  const third = fauxProvider({ provider: "delegate-third", models: [{ id: "same-id", reasoning: true }], tokensPerSecond: 100_000 });
  const launches: Launch[] = [];
  const pendingLaunches = new Map<string, Launch>();
  const requests: WorkerRequestFile[] = [];
  const closed: string[] = [];
  let resolveClosure: (() => void) | undefined;
  const closure = new Promise<void>((resolve) => { resolveClosure = resolve; });
  const publicationErrors: unknown[] = [];
  const publications = new Set<Promise<void>>();
  let failureResult: string | undefined;
  let hold: Promise<void> | undefined;
  let release: (() => void) | undefined;
  let requestArrived: (() => void) | undefined;
  let runtime: AgentSessionRuntime | undefined;
  let disposal: Promise<void> | undefined;
  // Pi's process-exit teardown: abort and wait for idle, session_shutdown, then disposal.
  const dispose = () => disposal ??= runtime!.dispose();
  let closedAtShutdown: number | undefined;
  t.after(async () => {
    release?.();
    if (runtime) await dispose();
    await Promise.all(publications);
    await transport.cleanup();
    for (const request of requests) fs.rmSync(path.dirname(request.resultPath), { recursive: true, force: true });
    for (const launch of launches) fs.rmSync(launch.sessionFile, { force: true });
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
    });
    assert.deepEqual(publicationErrors, []);
  });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: path.join(agentDir, "models-store.json"), allowModelNetwork: false,
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoaderOptions = {
    noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [createCodemodeExtension({ mode: codemodeOnly ? "only" : "on", models: false }), (pi: ExtensionAPI) => {
      pi.on("session_shutdown", () => { closedAtShutdown = closed.length; });
      pi.registerProvider(first.provider);
      pi.registerProvider(second.provider);
      pi.registerProvider(third.provider);
      pi.registerTool({
        name: "self_compact", label: "Self Compact", description: "Fixture tool; never executed.",
        parameters: Type.Object({}),
        async execute() { throw new Error("Fixture self_compact must not execute"); },
      });
      pi.registerTool({
        name: "nested_worker", label: "Nested worker", description: "Fixture nested delegation.",
        parameters: Type.Object({ task: Type.String() }),
        async execute(_id, args, signal, _update, ctx) {
          const outcome = await ctx.executeTool("do", args, { signal });
          return { ...outcome.result, isError: outcome.isError };
        },
      });
      delegateExtension({ ...pi, exec: async (command, args, options) => {
        if (command !== "tmux") return pi.exec(command, args, options);
        if (args.includes("new-window")) {
          const name = args[args.indexOf("-n") + 1];
          const launch = pendingLaunches.get(name);
          assert.ok(launch, `Missing saved launch for ${name}`);
          launches.push(launch);
          pendingLaunches.delete(name);
        }
        const result = await transport.pi.exec(command, args, options);
        if (args.includes("kill-pane")) {
          closed.push(args[args.indexOf("-t") + 1]);
          resolveClosure?.();
        }
        return result;
      } });
    }],
  };
  runtime = await createAgentSessionRuntime(async ({ cwd, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime, settingsManager, resourceLoaderOptions });
    const created = await createAgentSessionFromServices({
      services, sessionManager, sessionStartEvent,
      model: first.getModel(), thinkingLevel: "high", tools: ["read", ...toolNames, "self_compact", "codemode", "nested_worker"],
    });
    assert.deepEqual(created.extensionsResult.errors, []);
    return { ...created, services, diagnostics: services.diagnostics };
  }, { cwd: directory, agentDir, sessionManager: SessionManager.create(directory, path.join(directory, "sessions")) });
  const session = runtime.session;
  session.setActiveToolsByName(["read", ...toolNames]);
  const errors: string[] = [];
  await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.error) });
  await modelRuntime.setRuntimeApiKey(first.provider.id, "fixture-key");
  await modelRuntime.setRuntimeApiKey(second.provider.id, "fixture-key");
  await modelRuntime.setRuntimeApiKey(third.provider.id, "fixture-key");
  await modelRuntime.getAvailable();
  assert.ok(modelRuntime.getProvider(first.provider.id));
  assert.ok(modelRuntime.hasConfiguredAuth(first.provider.id));
  const current = session;
  const updates: Array<{ result: AgentToolResult<unknown>; launches: number }> = [];
  current.subscribe((event) => {
    if (event.type === "tool_execution_update") {
      updates.push({ result: event.partialResult, launches: launches.length });
      if (!toolNames.includes(event.toolName as EphemeralWorkerTool)) return;
      const details = event.partialResult.details as { status?: string; id?: string; artifacts?: { requestPath: string } };
      if (details.status === "starting") {
        const entry = current.sessionManager.getBranch().findLast((candidate) => candidate.type === "custom" && candidate.customType === WORKER_ENTRY);
        assert.ok(entry?.type === "custom");
        const record = entry.data as WorkerRecord;
        pendingLaunches.set(record.name, { args: record.args, sessionFile: record.sessionFile, env: record.env ?? {} });
      }
      if (!details.artifacts || requests.some((request) => request.id === details.id)) return;
      const work = JSON.parse(fs.readFileSync(details.artifacts.requestPath, "utf8")) as WorkerRequestFile;
      requests.push(work);
      requestArrived?.();
      const publication = (async () => {
        await hold;
        const lease = JSON.parse(fs.readFileSync(path.join(path.dirname(work.resultPath), "parent-task.json"), "utf8")) as { state: string };
        if (lease.state !== "active") return;
        fs.writeFileSync(work.resultPath, JSON.stringify({
          id: work.id, result: failureResult ?? "fixture result", isError: failureResult !== undefined,
          ...work.resultPolicy !== "brief" && { retrospective: "fixture retrospective" }, timestamp: new Date().toISOString(),
        }));
      })().catch((error: unknown) => { publicationErrors.push(error); });
      publications.add(publication);
      void publication.finally(() => publications.delete(publication));
    }
  });
  let percent = 10;
  t.mock.method(current, "getContextUsage", () => ({ tokens: percent * 1_000, contextWindow: 100_000, percent }));
  t.after(() => assert.deepEqual(errors, []));
  const definition = (name: EphemeralWorkerTool) => {
    const tool = current.getToolDefinition(name);
    assert.ok(tool, `missing ${name}`);
    return tool;
  };
  const enable = () => current.prompt("/delegate-alt delegate-first/same-id delegate-second/same-id");
  async function call(name: string, params: JsonObject) {
    const provider = [first, second, third].find((candidate) => candidate.provider.id === current.model?.provider);
    assert.ok(provider);
    provider.setResponses([
      fauxAssistantMessage(fauxToolCall(name, params), { stopReason: "toolUse" }),
      (context) => {
        const result = context.messages.findLast((message) => message.role === "toolResult");
        assert.ok(result?.role === "toolResult");
        const command = launches.at(-1) && workerResumeCommand(launches.at(-1)!.sessionFile);
        if (command && !result.isError) {
          assert.ok(!JSON.stringify(result.content).includes(command), "successful recovery metadata must not reach the model's tool content");
          assert.doesNotMatch(JSON.stringify(result.content), /To resume\/continue|enter a prompt to continue/);
        }
        return fauxAssistantMessage("parent done");
      },
    ]);
    await current.prompt(`Run the fixture ${name}.`);
    const result = current.messages.findLast((message) => message.role === "toolResult");
    assert.ok(result?.role === "toolResult", JSON.stringify(current.messages));
    return result;
  }
  async function run(name: EphemeralWorkerTool, params: DelegateParams, expectedProvider = "delegate-first", expectedThinking = "high") {
    const parent = current.model;
    const thinking = current.thinkingLevel;
    const count = requests.length;
    const result = await call(name, params);
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(requests.length, count + 1, JSON.stringify(result));
    const request = requests.at(-1)!;
    assert.deepEqual(request.model, { provider: expectedProvider, id: "same-id" });
    assert.equal(request.thinkingLevel, expectedThinking);
    assert.deepEqual(launches.at(-1)!.args.slice(0, 6), ["--provider", expectedProvider, "--model", "same-id", "--thinking", expectedThinking]);
    assert.ok(request.tools.includes("do"));
    assert.equal(current.model, parent);
    assert.equal(current.thinkingLevel, thinking);
    assert.match(JSON.stringify(result.content), new RegExp(`Worker model: ${expectedProvider}/same-id`));
    assert.match(JSON.stringify(result.content), /fixture result/);
    assert.equal(JSON.stringify(result.content).includes("fixture retrospective"), name !== "microdo");
    assert.equal(request.resultPolicy, name === "microdo" ? "brief" : "retrospective");
    const command = workerResumeCommand(launches.at(-1)!.sessionFile);
    assert.ok(!JSON.stringify(result.content).includes(command));
    assert.doesNotMatch(JSON.stringify(result.content), /To resume\/continue|enter a prompt to continue/);
    assert.equal((result.details as { sessionCommand: string }).sessionCommand, command);
    // Pilish's read-only transcript link: absolute root, relative file, header ID.
    const sessionFile = launches.at(-1)!.sessionFile;
    const header = JSON.parse(fs.readFileSync(sessionFile, "utf8").split("\n")[0]!) as { type: string; id: string };
    assert.equal(header.type, "session");
    const saved = {
      version: 1, root: path.dirname(path.resolve(sessionFile)),
      items: [{ sessionId: header.id, file: path.basename(sessionFile), label: `${name}-${request.id}` }],
    };
    assert.deepEqual((result.details as { savedConversations: unknown }).savedConversations, saved);
    assert.ok(path.isAbsolute(saved.root));
    assert.ok(!JSON.stringify(result.content).includes(header.id));
    const persisted = SessionManager.open(current.sessionManager.getSessionFile()!).getBranch()
      .findLast((entry) => entry.type === "message" && entry.message.role === "toolResult");
    assert.ok(persisted?.type === "message" && persisted.message.role === "toolResult");
    assert.equal((persisted.message.details as { sessionCommand: string }).sessionCommand, command);
    assert.deepEqual((persisted.message.details as { savedConversations: unknown }).savedConversations, saved);
    assert.ok(!JSON.stringify(persisted.message.content).includes(command));
    for (const update of updates) {
      assert.doesNotMatch(JSON.stringify(update.result.content), /To resume\/continue|enter a prompt to continue|pi --session/);
      assert.ok((update.result.details as { sessionCommand?: string }).sessionCommand);
    }
    const runUpdates = updates.filter((update) =>
      (update.result.details as { savedConversations?: { items: { sessionId: string }[] } }).savedConversations?.items[0]?.sessionId === header.id);
    assert.ok(runUpdates.length > 0);
    assert.ok(runUpdates.some((update) => (update.result.details as { status?: string }).status === "starting"));
    for (const update of runUpdates) {
      assert.deepEqual((update.result.details as { savedConversations: unknown }).savedConversations, saved);
    }
    assert.equal(closed.length, requests.length);
    return result;
  }
  return {
    directory, config, codemodeConfig: path.join(agentDir, "codemode-delegate.json"),
    current, first, second, third, requests, launches, definition, enable, call, run, updates, closed,
    whenClosed: closure, dispose, closedAtShutdown: () => closedAtShutdown,
    failResult: (message: string | undefined) => { failureResult = message; },
    failStartup: transport.failStart,
    setPercent: (value: number) => { percent = value; },
    holdNext: () => {
      hold = new Promise<void>((resolve) => { release = resolve; });
      return new Promise<void>((resolve) => { requestArrived = resolve; });
    },
    release: () => { release?.(); hold = undefined; requestArrived = undefined; },
  };
}

for (const only of [false, true]) {
  test(`codemode delegation opt-in executes with correct context (only=${only})`, { timeout: 20_000 }, async (t) => {
    const f = await fixture(t, only);
    const selected = ["read", "codemode", ...toolNames, "nested_worker"];
    f.current.setActiveToolsByName(selected);
    assert.equal(fs.existsSync(f.codemodeConfig), false);
    for (const name of toolNames) assert.equal(f.definition(name).exposure, "model-only");
    const script = (name: string) => ({ code: `return await tools.${name}({task: "Nested assignment"});` });
    const blocked = await f.call("codemode", script("do"));
    assert.match(JSON.stringify(blocked.content), /tools.do does not exist/);
    assert.equal(f.launches.length, 0);
    f.current.setActiveToolsByName(["codemode", "fresh_look"]);
    await f.current.prompt("/codemode-delegate");
    assert.deepEqual(new Set(f.current.getActiveToolNames()), new Set(["codemode", "fresh_look"]));
    assert.ok(!f.current.getCallableToolNames().includes("do"), "toggle must not activate disabled workers");
    f.current.setActiveToolsByName(selected);
    for (const name of toolNames) assert.equal(f.definition(name).exposure, undefined);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.codemodeConfig, "utf8")), { enabled: true });
    assert.equal(fs.statSync(f.codemodeConfig).mode & 0o777, 0o600);
    assert.deepEqual(new Set(f.current.getActiveToolNames()), new Set(selected));
    await f.enable();
    for (const name of toolNames) assert.equal(hasAlt(f.definition(name)), name !== "microdo", "alternate registration composes with exposure");
    for (const name of [...toolNames, "nested_worker"]) {
      const result = await f.call("codemode", script(name));
      assert.match(JSON.stringify(result.content), /fixture result/);
      assert.equal(JSON.stringify(result.content).includes("fixture retrospective"), name !== "microdo");
      const child = SessionManager.open(f.launches.at(-1)!.sessionFile);
      const messages = child.getBranch().flatMap((entry) => entry.type === "message" ? [entry.message] : []);
      if (name === "do" || name === "microdo" || name === "nested_worker") {
        const last = messages.at(-1);
        assert.equal(last?.role, "user", "fork is before the outer codemode assistant message");
        assert.match(JSON.stringify(last), /Run the fixture codemode/);
        assert.ok(messages.some((message) => message.role === "toolResult"), "previous conversation survives");
      } else assert.deepEqual(messages, [], "standalone workers remain blank");
    }
    const count = f.launches.length;
    const parallel = await f.call("codemode", { code: 'return await Promise.all([tools.do({task:"First"}), tools.do({task:"Second"})]);' });
    assert.match(JSON.stringify(parallel.content), /fixture result/);
    assert.equal(f.launches.length, count + 2);
    const branches = f.launches.slice(-2).map((launch) => SessionManager.open(launch.sessionFile).getBranch()
      .filter((entry) => entry.type === "message"));
    assert.deepEqual(branches[0], branches[1], "parallel workers fork from the same pre-script conversation");
    await f.current.reload();
    f.current.setActiveToolsByName(selected);
    assert.match(JSON.stringify((await f.call("codemode", script("do"))).content), /fixture result/);
    await f.current.prompt("/codemode-delegate off");
    assert.equal(fs.existsSync(f.codemodeConfig), false);
    assert.deepEqual(new Set(f.current.getActiveToolNames()), new Set(selected));
    assert.match(JSON.stringify((await f.call("codemode", script("do"))).content), /tools.do does not exist/);
    // A direct call remains available even in codemode-only mode after disabling.
    f.updates.length = 0;
    await f.run("do", { task: "Direct worker still available" });
    fs.writeFileSync(f.codemodeConfig, JSON.stringify({ enabled: true }));
    assert.match(JSON.stringify((await f.call("codemode", script("do"))).content), /fixture result/);
    fs.rmSync(f.codemodeConfig);
    assert.match(JSON.stringify((await f.call("codemode", script("do"))).content), /tools.do does not exist/);
  });
}

test("codemode cancellation reaches owned workers and retains their session files", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  await f.current.prompt("/codemode-delegate on");
  f.current.setActiveToolsByName(["codemode", "do"]);
  const arrived = f.holdNext();
  const pending = f.call("codemode", { code: 'return await tools.do({task:"Wait for cancellation"});' });
  await arrived;
  const file = f.launches.at(-1)!.sessionFile;
  const saved = fs.readFileSync(file, "utf8");
  await f.current.abort();
  await pending;
  // Pi may settle codemode before a nested call's asynchronous cleanup completes.
  await f.whenClosed;
  f.release();
  assert.equal(f.closed.length, 1);
  assert.equal(fs.readFileSync(file, "utf8"), saved);
});

test("nested do warning survives reload and script failures retain recovery", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  await f.current.prompt("/codemode-delegate on");
  f.current.setActiveToolsByName(["codemode", "do", "delegate"]);
  f.setPercent(95);
  const script = { code: 'return await tools.do({task:"Check warning"});' };
  const beforeWarning = f.current.sessionManager.getLeafId()!;
  assert.match(JSON.stringify((await f.call("codemode", script)).content), /Retry do/);
  assert.equal(f.launches.length, 0);
  await f.current.reload();
  assert.match(JSON.stringify((await f.call("codemode", script)).content), /fixture result/);
  await f.current.navigateTree(beforeWarning, { summarize: false });
  assert.match(JSON.stringify((await f.call("codemode", script)).content), /Retry do/);
  f.failStartup("nested startup rejected");
  const result = await f.call("codemode", script);
  assert.match(JSON.stringify(result.content), /nested startup rejected/);
  assert.ok(JSON.stringify(result.content).includes(workerResumeCommand(f.launches.at(-1)!.sessionFile)));
});

test("codemode receives worker results, failures and warnings as structured content", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  await f.current.prompt("/codemode-delegate on");
  f.current.setActiveToolsByName(["codemode", "do", "microdo"]);
  const structured = async (name: string) => {
    const result = await f.call("codemode", { code: `return JSON.stringify(await tools.${name}({task: "Structured"}));` });
    const text = result.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
    return JSON.parse(/\{.*\}/s.exec(text)![0]) as Record<string, unknown>;
  };
  const done = await structured("do");
  assert.deepEqual({ ...done, worker: undefined }, {
    state: "finished", result: "fixture result", worker: undefined, model: "delegate-first/same-id", thinking: "high",
    retrospective: "fixture retrospective",
  });
  assert.match(String(done.worker), /^do-/);
  assert.equal((await structured("microdo")).retrospective, undefined);
  f.failResult("Provider unavailable");
  const failed = await structured("do");
  assert.equal(failed.state, "failed");
  assert.equal(failed.result, "Provider unavailable");
  f.failResult(undefined);
  f.setPercent(95);
  const warning = await structured("do");
  assert.equal(warning.state, "not_started");
  assert.match(String(warning.result), /do not started.*Retry do/);
});

test("split schemas have no context flag, fresh_look is opt-in, and alternate re-registration preserves selections", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const assertSchemas = (enabled: boolean) => {
    for (const name of toolNames) {
      const tool = f.definition(name);
      const schema = tool.parameters as { properties: Record<string, { default?: unknown; description?: string }>; required?: string[] };
      assert.equal(Object.hasOwn(schema.properties, "alt"), enabled && name !== "microdo");
      assert.equal(Object.hasOwn(schema.properties, "context"), false);
      assert.equal(Object.hasOwn(schema.properties, "folder"), name === "delegate" || name === "fresh_look");
      assert.equal(Object.hasOwn(schema.properties, "resume"), name === "do");
      assert.deepEqual(schema.required, ["task"]);
      if (name !== "microdo") assert.doesNotMatch(tool.description, /retrospective/);
      if (enabled && name !== "microdo") {
        assert.equal(schema.properties.alt.default, false);
        assert.match(tool.description, /alt=true/);
        assert.match(tool.description, /first if the caller is outside the pair/);
        assert.match(schema.properties.alt.description!, /first if the caller is outside the pair/);
        assert.match(tool.description, /delegate-first\/same-id/);
        assert.match(tool.description, /delegate-second\/same-id/);
      } else assert.doesNotMatch(JSON.stringify(tool.parameters), /alternate|\balt\b/i);
    }
  };
  assertSchemas(false);
  assert.equal(fs.existsSync(f.config), false);
  assert.deepEqual(new Set(f.current.getActiveToolNames()), new Set(["read", "do", "microdo", "delegate"]));
  await f.enable();
  assertSchemas(true);
  assert.deepEqual(new Set(f.current.getActiveToolNames()), new Set(["read", "do", "microdo", "delegate"]));
  f.current.setActiveToolsByName(["read", "fresh_look"]);
  await f.current.prompt("/delegate-alt off");
  assertSchemas(false);
  assert.deepEqual(new Set(f.current.getActiveToolNames()), new Set(["read", "fresh_look"]), "manual fresh_look choice survives re-registration");
  await f.enable();
  assertSchemas(true);
  assert.deepEqual(new Set(f.current.getActiveToolNames()), new Set(["read", "fresh_look"]), "re-registration must not enable inactive ordinary tools");
  f.current.setActiveToolsByName(["read", ...toolNames]);
  for (const name of alternateToolNames) {
    await f.run(name, { task: "Default" });
    await f.run(name, { task: "Explicit false", alt: false });
    await f.run(name, { task: "Other provider", alt: true }, "delegate-second", "off");
  }
  await f.current.setModel(f.second.getModel());
  await f.run("do", { task: "Reverse alternate", alt: true }, "delegate-first", "off");
  const arrived = f.holdNext();
  const pending = f.run("delegate", { task: "Pinned", alt: true }, "delegate-first", "off");
  await arrived;
  await f.current.prompt("/delegate-alt off");
  assertSchemas(false);
  f.release();
  await pending;
  fs.writeFileSync(f.config, JSON.stringify({ models: ["delegate-first/same-id", "delegate-second/same-id"] }));
  f.second.setResponses([(context) => {
    for (const name of toolNames) assert.equal(hasAlt(getCurrentTools(context.messages).find((tool) => tool.name === name)!), name !== "microdo");
    return fauxAssistantMessage("schema enabled before request");
  }]);
  await f.current.prompt("Check changed global selection.");
  assertSchemas(true);
  fs.rmSync(f.config);
  f.second.setResponses([(context) => {
    for (const name of toolNames) assert.ok(!hasAlt(getCurrentTools(context.messages).find((tool) => tool.name === name)!));
    return fauxAssistantMessage("schema disabled before request");
  }]);
  await f.current.prompt("Check disabled global selection.");
  assertSchemas(false);
});

test("all worker tools select the first configured model for an outside caller only with alt true", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  await f.enable();
  await f.current.setModel(f.third.getModel());
  f.current.setActiveToolsByName(["read", ...toolNames]);
  for (const name of alternateToolNames) {
    await f.run(name, { task: "Outside caller default" }, "delegate-third");
    await f.run(name, { task: "Outside caller explicit false", alt: false }, "delegate-third");
    await f.run(name, { task: "Outside caller alternate", alt: true }, "delegate-first");
  }
  await f.current.prompt("/delegate-alt delegate-second/same-id delegate-first/same-id");
  await f.run("do", { task: "Reordered pair", alt: true }, "delegate-second", "off");
});

test("do inherits the pre-call conversation, delegate and fresh_look start blank in the selected directory", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  f.current.setActiveToolsByName(["read", ...toolNames]);
  await f.run("do", { task: "Inherited investigation" });
  const inherited = SessionManager.open(f.launches.at(-1)!.sessionFile);
  const inheritedRoles = () => inherited.getBranch().flatMap((entry) => entry.type === "message" ? [entry.message.role] : []);
  assert.deepEqual(inheritedRoles(), ["system", "user"]);
  assert.equal(inherited.getCwd(), f.directory);
  const other = path.join(f.directory, "other-project");
  fs.mkdirSync(other);
  for (const name of ["delegate", "fresh_look"] as const) {
    await f.run(name, { task: "Standalone assignment", folder: other });
    const launch = f.launches.at(-1)!;
    const child = SessionManager.open(launch.sessionFile);
    assert.equal(child.getCwd(), other);
    assert.ok(child.getBranch().every((entry) => entry.type !== "message"));
    assert.equal(launch.args.includes("--no-context-files"), name === "fresh_look");
    assert.equal(launch.args.includes("--no-skills"), name === "fresh_look");
    assert.equal(launch.args.includes("--no-prompt-templates"), name === "fresh_look");
    assert.equal(launch.args.includes("--system-prompt"), name === "fresh_look");
    assert.ok(!launch.args.includes("--no-extensions"));
  }
});

test("remote workers resolve their SSH target before startup and run with it; session targets are inherited", { timeout: 20_000 }, async (t) => {
  const stub = installSshStub(t);
  const project = path.join(stub.home, "proj");
  fs.mkdirSync(path.join(project, "sub"), { recursive: true });
  const f = await fixture(t);
  f.current.setActiveToolsByName(["read", ...toolNames]);
  await f.run("do", { task: "Local work" });
  assert.equal(f.launches.at(-1)!.env.PI_REMOTE, undefined, "local sessions start local workers");

  const remoteDo = await f.call("do", { task: "Remote work", remote: `box:${project}` });
  assert.equal(remoteDo.isError, false, JSON.stringify(remoteDo));
  assert.equal(f.launches.at(-1)!.env.PI_REMOTE, `box:${project}`);
  assert.match(JSON.stringify(remoteDo.content), new RegExp(`Tools run on box:${project} over SSH`));
  const details = remoteDo.details as { remote: string; sessionCommand: string; cwd: string };
  assert.equal(details.remote, `box:${project}`);
  assert.equal(details.cwd, f.directory, "the worker's Pi process and session stay local");
  assert.match(details.sessionCommand, new RegExp(`'PI_REMOTE=box:${project}'`));

  await f.call("delegate", { task: "Remote standalone", remote: "box:~/proj", folder: "sub" });
  assert.equal(f.launches.at(-1)!.env.PI_REMOTE, `box:${path.join(project, "sub")}`);
  assert.equal(SessionManager.open(f.launches.at(-1)!.sessionFile).getCwd(), f.directory);

  const count = f.launches.length;
  for (const [remote, error] of [["down", /SSH connection to down failed/], ["box:/no/such/dir", /is not accessible/], ["-oProxyCommand=x", /Invalid SSH destination/]] as const) {
    const result = await f.call("delegate", { task: "Unreachable", remote });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), error);
  }
  assert.equal(f.launches.length, count, "failed targets start no worker");

  // A session whose own tools run remotely passes its target on; folders are remote paths.
  setSessionRemote(t, `box:${project}`);
  for (const tool of ["do", "microdo"]) {
    await f.call(tool, { task: "Inherited remote" });
    assert.equal(f.launches.at(-1)!.env.PI_REMOTE, `box:${project}`);
  }
  await f.call("delegate", { task: "Inherited remote folder", folder: "sub" });
  assert.equal(f.launches.at(-1)!.env.PI_REMOTE, `box:${path.join(project, "sub")}`);
});

test("worker compaction guidance follows the enabled tool selection for all worker tools", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const guidance = "Use self_compact only when substantial work remains; never to wrap up.";
  for (const enabled of [false, true, false]) {
    const tools = ["read", ...toolNames, ...(enabled ? ["self_compact"] : [])];
    f.current.setActiveToolsByName(tools);
    for (const name of toolNames) {
      await f.run(name, { task: "Check worker guidance" });
      const request = f.requests.at(-1)!;
      assert.equal(request.task.includes(guidance), enabled);
      assert.equal(request.tools.includes("self_compact"), enabled);
      if (!enabled) assert.doesNotMatch(request.task, /self_compact/);
      assert.deepEqual(new Set(f.current.getActiveToolNames()), new Set(tools));
    }
  }
});

test("stale context arguments, do folder, and disabled alternate flags fail without starting workers", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  f.current.setActiveToolsByName(["read", ...toolNames]);
  const staleArguments: JsonObject[] = [{ context: "inherit" }, { context: "project" }, { context: "clean" }, { alt: true }, { alt: false }];
  for (const name of toolNames) {
    for (const extra of staleArguments) {
      const result = await f.call(name, { task: "Invalid old input", ...extra });
      assert.equal(result.isError, true, JSON.stringify(result));
      assert.equal(f.launches.length, 0);
    }
  }
  for (const folder of [f.directory, "/tmp"]) {
    const result = await f.call("do", { task: "Invalid cwd argument", folder });
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.equal(f.launches.length, 0);
  }
  await f.enable();
  for (const name of toolNames) {
    const result = await f.call(name, { task: "Invalid alternate type", alt: "true" });
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.equal(f.launches.length, 0);
  }
});

test("microdo validates its task-only Unicode limit and inherits the caller even with an alternate pair", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  const schema = f.definition("microdo").parameters as { properties: Record<string, { minLength?: number; maxLength?: number }> };
  assert.deepEqual(Object.keys(schema.properties), ["task"]);
  assert.equal(schema.properties.task.minLength, 1);
  assert.equal(schema.properties.task.maxLength, 40);
  for (const task of ["a", "x".repeat(40), "界".repeat(40), "😀".repeat(40)]) {
    await f.run("microdo", { task });
    assert.ok(f.requests.at(-1)!.task.endsWith(task), "valid tasks reach the worker unchanged");
  }
  const child = SessionManager.open(f.launches.at(-1)!.sessionFile);
  const messages = child.getBranch().flatMap((entry) => entry.type === "message" ? [entry.message] : []);
  assert.equal(messages.at(-1)?.role, "user", "snapshot excludes the calling assistant message");
  assert.ok(messages.some((message) => message.role === "toolResult"), "earlier work is inherited");
  assert.equal(child.getCwd(), f.directory);
  await f.enable();
  assert.doesNotMatch(f.definition("microdo").description, /alt=true|Models:/);
  await f.current.setModel(f.third.getModel());
  await f.run("microdo", { task: "Update example.md" }, "delegate-third");
  const count = f.launches.length;
  const invalidInputs: JsonObject[] = [
    {}, { task: "" }, { task: "x".repeat(41) }, { task: "😀".repeat(41) },
    { task: "Invalid option", alt: false }, { task: "Invalid option", alt: true },
    { task: "Invalid option", remote: "box" }, { task: "Invalid option", folder: f.directory },
    { task: "Invalid option", resume: "microdo-missing" },
  ];
  for (const input of invalidInputs) {
    const result = await f.call("microdo", input);
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.equal(f.launches.length, count, "invalid arguments must start no worker");
    if ("alt" in input) assert.doesNotMatch(JSON.stringify(result.content), /Configure \/delegate-alt/);
  }
  f.setPercent(95);
  const warning = await f.call("microdo", { task: "Update example.md" });
  assert.match(JSON.stringify(warning.content), /microdo not started.*Retry microdo/);
  assert.equal(f.launches.length, count);
  await f.run("microdo", { task: "Update example.md" }, "delegate-third");
});

test("do warns only above 90 percent, permits retry, and restores the warning per branch and reload", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  f.current.setActiveToolsByName(["read", ...toolNames]);
  f.setPercent(90);
  await f.run("do", { task: "Exactly at threshold" });
  const beforeWarning = f.current.sessionManager.getLeafId()!;
  f.setPercent(90.1);
  const count = f.requests.length;
  const warning = await f.call("do", { task: "Above threshold" });
  assert.equal(warning.isError, false);
  assert.equal(f.requests.length, count, "warning must not start a worker");
  assert.equal((warning.details as { inheritContextWarning?: boolean }).inheritContextWarning, true);
  assert.match(JSON.stringify(warning.content), /90\.1%/);
  assert.match(JSON.stringify(warning.content), /Retry do/);
  const warnedBranch = f.current.sessionManager.getLeafId()!;
  await f.run("do", { task: "Explicit retry" });
  await f.current.reload();
  await f.run("do", { task: "Reload retains warning acknowledgment" });
  await f.current.navigateTree(beforeWarning, { summarize: false });
  const freshCount = f.requests.length;
  const newWarning = await f.call("do", { task: "New branch warns again" });
  assert.equal((newWarning.details as { inheritContextWarning?: boolean }).inheritContextWarning, true);
  assert.equal(f.requests.length, freshCount);
  await f.current.navigateTree(warnedBranch, { summarize: false });
  await f.run("do", { task: "Return to already warned branch" });
  f.current.setActiveToolsByName(["read", ...toolNames]);
  f.setPercent(99);
  await f.run("delegate", { task: "Standalone work at high context" });
  await f.run("fresh_look", { task: "Fresh work at high context" });
});

for (const name of toolNames) {
  test(`${name} publishes recovery before startup and preserves it through parent abort`, { timeout: 20_000 }, async (t) => {
    const f = await fixture(t);
    f.current.setActiveToolsByName(["read", ...toolNames]);
    const arrived = f.holdNext();
    const pending = f.call(name, { task: "Keep work recoverable" });
    await arrived;
    const file = f.launches.at(-1)!.sessionFile;
    const command = workerResumeCommand(file);
    assert.equal(f.updates[0].launches, 0, "receipt must precede host startup, not wait for native capture");
    const first = f.updates[0].result;
    assert.equal((first.details as { sessionCommand: string }).sessionCommand, command);
    assert.ok(!JSON.stringify(first.content).includes(command));
    assert.doesNotMatch(JSON.stringify(first.content), /To resume\/continue|enter a prompt to continue/);
    const saved = fs.readFileSync(file, "utf8");
    // Same SDK abort used by the parent's Escape key.
    await f.current.abort();
    const result = await pending;
    f.release();
    assert.equal(result.isError, true);
    assert.ok(JSON.stringify(result.content).includes(command));
    const notice = workerStoppedNotice(`${name}-${f.requests.at(-1)!.id}`);
    assert.ok(JSON.stringify(result.content).includes(JSON.stringify(notice).slice(1, -1)));
    assert.equal(fs.readFileSync(file, "utf8"), saved, "closing a worker must not delete or rewrite its session");
    assert.equal(f.closed.length, 1);
    const parent = SessionManager.open(f.current.sessionManager.getSessionFile()!);
    assert.ok(parent.getBranch().some((entry) => entry.type === "message"
      && entry.message.role === "toolResult" && JSON.stringify(entry.message.content).includes(command)),
    "recovery must survive reloading the parent, not just the live progress row");
  });
}

for (const name of ["do", "delegate"] as const) {
  test(`parent shutdown stops a running ${name} worker before its extensions shut down`, { timeout: 20_000 }, async (t) => {
    const f = await fixture(t);
    f.current.setActiveToolsByName(["read", ...toolNames]);
    const arrived = f.holdNext();
    const pending = f.call(name, { task: "Work still running at parent exit" });
    await arrived;
    const request = f.requests.at(-1)!;
    const worker = `${name}-${request.id}`;
    assert.ok(readTarget(worker), "the running worker is registered");
    // Pi's process exit: the runtime aborts and waits for the running tool before session_shutdown.
    await f.dispose();
    const result = await pending;
    f.release();
    assert.equal(f.closed.length, 1, "the worker is closed");
    assert.equal(f.closedAtShutdown(), 1, "worker cleanup finishes before session_shutdown");
    assert.equal(readTarget(worker), undefined, "the closed worker leaves no registry target");
    const lease = JSON.parse(fs.readFileSync(path.join(path.dirname(request.resultPath), "parent-task.json"), "utf8")) as { state: string };
    assert.notEqual(lease.state, "active", "the parent-task lease is ended");
    assert.equal(fs.existsSync(request.resultPath), false, "no result is published after the parent stopped");
    assert.equal(result.isError, true);
    const command = workerResumeCommand(f.launches.at(-1)!.sessionFile);
    assert.ok(JSON.stringify(result.content).includes(JSON.stringify(workerStoppedNotice(worker)).slice(1, -1)));
    const parent = SessionManager.open(f.current.sessionManager.getSessionFile()!);
    assert.ok(parent.getBranch().some((entry) => entry.type === "message"
      && entry.message.role === "toolResult" && JSON.stringify(entry.message.content).includes(command)),
    "the aborted tool result with recovery is persisted before the parent exits");
  });
}

/** The worker's name as the parent knows it, from its first tool result line. */
function workerName(result: { content: unknown }): string {
  const name = /Worker ((?:do|microdo|delegate|fresh_look)-[a-z0-9-]+)\./.exec(JSON.stringify(result.content))?.[1];
  assert.ok(name, JSON.stringify(result.content));
  return name;
}

for (const name of toolNames) {
  test(`do resumes a stopped ${name} in place with its stored launch, under a new request`, { timeout: 20_000 }, async (t) => {
    const f = await fixture(t);
    f.current.setActiveToolsByName(["read", ...toolNames]);
    const arrived = f.holdNext();
    const pending = f.call(name, { task: "Interrupted work" });
    await arrived;
    await f.current.abort();
    const stopped = await pending;
    f.release();
    assert.equal(stopped.isError, true);
    const worker = workerName(stopped);
    assert.ok(worker.startsWith(`${name}-`));
    const first = f.launches.at(-1)!;
    const firstRequest = f.requests.at(-1)!;
    const saved = fs.readFileSync(first.sessionFile, "utf8");
    if (name === "microdo") {
      await f.current.reload();
      await f.current.setModel(f.second.getModel());
    }

    // Above the warning threshold: resuming continues a session, and warns about nothing.
    f.setPercent(95);
    const count = f.launches.length;
    const resumed = await f.call("do", { resume: worker, task: "Finish it" });
    assert.equal(resumed.isError, false, JSON.stringify(resumed));
    assert.equal(f.launches.length, count + 1);
    const second = f.launches.at(-1)!;
    assert.equal(second.sessionFile, first.sessionFile, "the same conversation continues");
    assert.deepEqual(second.args, first.args);
    assert.equal(fs.readFileSync(first.sessionFile, "utf8"), saved, "nothing is forked or rewritten");
    assert.equal(workerName(resumed), worker);
    const request = f.requests.at(-1)!;
    assert.notEqual(request.id, firstRequest.id);
    assert.notEqual(request.resultPath, firstRequest.resultPath);
    assert.deepEqual(request.model, firstRequest.model);
    assert.equal(request.thinkingLevel, firstRequest.thinkingLevel);
    assert.equal(request.resultPolicy, name === "microdo" ? "brief" : "retrospective");
    assert.equal(JSON.stringify(resumed.content).includes("fixture retrospective"), name !== "microdo");
    assert.match(request.task, /Continue your existing work/);
    assert.match(request.task, /Finish it/);
    assert.match(JSON.stringify(resumed.content), /fixture result/);

    // A finished worker continues too, and the latest record still names it.
    const again = await f.call("do", { resume: worker, task: "One more thing" });
    assert.equal(again.isError, false, JSON.stringify(again));
    assert.equal(f.launches.at(-1)!.sessionFile, first.sessionFile);
    assert.equal(f.launches.length, count + 2);
  });
}

test("resume survives reloading the parent but belongs to its conversation branch", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  f.current.setActiveToolsByName(["read", ...toolNames]);
  const beforeWorker = f.current.sessionManager.getLeafId()!;
  const finished = await f.call("delegate", { task: "Finished work" });
  const worker = workerName(finished);
  const count = f.launches.length;
  await f.current.reload();
  assert.equal((await f.call("do", { resume: worker, task: "After reload" })).isError, false);
  assert.equal(f.launches.length, count + 1);
  await f.current.navigateTree(beforeWorker, { summarize: false });
  const unknown = await f.call("do", { resume: worker, task: "Other branch" });
  assert.equal(unknown.isError, true);
  assert.match(JSON.stringify(unknown.content), new RegExp(`Unknown worker '${worker}'`));
  assert.equal(f.launches.length, count + 1, "an unknown name starts nothing");
});

test("resume is only for do, without a model or target, and refuses a worker that still runs", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  f.current.setActiveToolsByName(["read", ...toolNames]);
  const worker = workerName(await f.call("do", { task: "Finished work" }));
  const count = f.launches.length;
  for (const [name, params] of [
    ["delegate", { resume: worker, task: "Wrong tool" }],
    ["fresh_look", { resume: worker, task: "Wrong tool" }],
    ["do", { resume: worker, task: "With target", remote: "box" }],
  ] as const) {
    assert.equal((await f.call(name, params)).isError, true);
  }
  await f.enable();
  const withAlt = await f.call("do", { resume: worker, task: "With model", alt: false });
  assert.equal(withAlt.isError, true);
  assert.match(JSON.stringify(withAlt.content), /cannot be combined with alt or remote/);
  assert.equal(f.launches.length, count);

  // A running worker holds its name's claim for its whole request.
  const release = claimName(worker);
  t.after(release);
  const live = await f.call("do", { resume: worker, task: "Too early" });
  assert.equal(live.isError, true);
  assert.match(JSON.stringify(live.content), /already being used/);
  assert.equal(f.launches.length, count);
});

test("on the Emacs host recovery is do({resume}) alone, without a shell command", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  f.current.setActiveToolsByName(["read", ...toolNames]);
  const bin = path.join(f.directory, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "emacsclient"), "#!/bin/sh\necho 'emacs refused' >&2\nexit 1\n", { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  t.after(() => { process.env.PATH = previousPath; });
  // Selection is frozen at first use, which is this worker call.
  process.env.PI_ORCHESTRATION_HOST = "emacs";
  process.env.PI_ORCHESTRATION_ENDPOINT = path.join(f.directory, "emacs.sock");
  const result = await f.call("do", { task: "Fails to start on Emacs" });
  assert.equal(result.isError, true);
  const content = JSON.stringify(result.content);
  assert.match(content, /emacs refused/);
  assert.match(content, /Its conversation is saved; continue it with do\(\{resume: \\"do-/);
  assert.doesNotMatch(content, /pi --session|To resume\/continue/);
  const starting = f.updates.at(-1)!.result.details as { sessionCommand?: string; savedConversations?: unknown; status: string };
  assert.equal(starting.status, "starting");
  assert.equal(starting.sessionCommand, undefined);
  assert.ok(starting.savedConversations);
});

test("provider/budget/token failures and failed startup retain model-visible recovery", { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  for (const message of ["Insufficient credits", "Context window exceeded", "Maximum output tokens reached", "Provider unavailable"]) {
    f.failResult(message);
    const result = await f.call("delegate", { task: "Recover failed work" });
    const command = workerResumeCommand(f.launches.at(-1)!.sessionFile);
    assert.equal(result.isError, true);
    assert.ok(JSON.stringify(result.content).includes(command));
    assert.ok(JSON.stringify(result.content).includes(message));
  }
  f.failStartup("startup rejected");
  const result = await f.call("delegate", { task: "Recover failed startup" });
  assert.equal(result.isError, true);
  assert.ok(JSON.stringify(result.content).includes(workerResumeCommand(f.launches.at(-1)!.sessionFile)));
  assert.match(JSON.stringify(result.content), /startup rejected/);
});
