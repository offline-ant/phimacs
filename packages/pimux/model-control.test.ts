// In-process model control with a real registry and synthetic provider catalogs.
import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryCredentialStore, InMemoryModelsStore, fauxProvider, type ModelsRefreshOptions, type RefreshModelsContext } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { installModelControl } from "./model-control.ts";
import { MODELS_COMMAND, parseModelsAction, type CompanionRecord, type ModelsAction } from "./protocol.ts";

type Result = Extract<CompanionRecord, { kind: "models-result" }>;

async function fixture(timeoutMs = 1000) {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false });
  const refreshes: { provider: string; force?: boolean; allowNetwork: boolean }[] = [];
  let published = false;
  let fail = false;
  let hold: (() => Promise<void>) | undefined;
  for (const provider of ["openai", "openrouter"]) {
    const base = fauxProvider({ provider, models: [{ id: "old" }, { id: "gpt-6.2-sol" }] }).provider;
    const all = base.getModels().map((model) => ({ ...model, baseUrl: "https://faux-private-endpoint.invalid/v1",
      headers: { "X-Faux-Secret": "synthetic-private-header" } }));
    let current: typeof all = all.slice(0, 1);
    runtime.registerNativeProvider({ ...base, getModels: () => current, getAllModels: () => current,
      async refreshModels(context: RefreshModelsContext) {
        refreshes.push({ provider, force: context.force, allowNetwork: context.allowNetwork });
        await hold?.();
        if (fail) throw new Error("synthetic refresh failure");
        // A newly cached faux catalog can be restored without network access.
        if (published) await context.publish({ update: () => { current = all; } });
      },
    });
  }
  await runtime.refresh({ allowNetwork: false });
  refreshes.length = 0;
  const results: Result[] = [];
  let handler!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  let setCalls = 0;
  let auth = true;
  const state = { idle: true, queued: false, file: "/synthetic.jsonl", session: "one", leaf: "leaf", model: runtime.getModel("openai", "old") };
  const controller = new AbortController();
  const requested: ModelsRefreshOptions[] = [];
  const registry = new ModelRegistry(runtime);
  registry.refresh = async (options = {}) => {
    requested.push(options);
    // Unit tests observe requested network policy but only exercise cached faux catalogs.
    return runtime.refresh({ ...options, allowNetwork: false });
  };
  const ctx = {
    get model() { return state.model; },
    signal: controller.signal,
    isIdle: () => state.idle,
    hasPendingMessages: () => state.queued,
    modelRegistry: registry,
    sessionManager: { getSessionFile: () => state.file, getSessionId: () => state.session, getLeafId: () => state.leaf },
  } as unknown as ExtensionCommandContext;
  const pi = {
    registerCommand(name: string, command: { handler: typeof handler }) { assert.equal(name, MODELS_COMMAND); handler = command.handler; },
    async setModel(model: NonNullable<typeof state.model>) { setCalls++; if (auth) state.model = model; return auth; },
    getThinkingLevel: () => "high",
  } as unknown as ExtensionAPI;
  installModelControl(pi, (_ctx, record) => results.push(record as Result), timeoutMs);
  return {
    runtime, refreshes, requested, state, controller, results, calls: () => setCalls,
    publish: () => { published = true; }, fail: () => { fail = true; },
    hold: (fn: () => Promise<void>) => { hold = fn; }, noAuth: () => { auth = false; },
    async run(request: ModelsAction) {
      await handler(JSON.stringify({ requestId: "request", request }), ctx);
      return results.at(-1)!;
    },
  };
}

test("model request parsing accepts provider names and slash IDs but rejects whitespace", () => {
  for (const provider of ["deepseek", "mistral", "typesafe"]) {
    assert.deepEqual(parseModelsAction({ action: "set", provider, modelId: "vendor/new" }), { action: "set", provider, modelId: "vendor/new" });
  }
  for (const request of [{ action: "set", provider: "deep seek", modelId: "new" },
    { action: "set", provider: "deepseek", modelId: "new model" }, { action: "list", force: "yes" }]) assert.equal(parseModelsAction(request), undefined);
});

test("online force and offline cache policies reach the supported registry refresh API", { timeout: 5000 }, async () => {
  const offline = process.env.PI_OFFLINE;
  try {
    for (const enabled of [false, true]) {
      if (enabled) process.env.PI_OFFLINE = "1";
      else delete process.env.PI_OFFLINE;
      const f = await fixture();
      await f.run({ action: "list" });
      assert.equal(f.requested.at(-1)?.force, false);
      assert.equal(f.requested.at(-1)?.allowNetwork, !enabled);
      await f.run({ action: "list", force: true });
      assert.equal(f.requested.at(-1)?.force, true);
      await f.run({ action: "set", provider: "openai", modelId: "old" });
      assert.equal(f.requested.at(-1)?.allowNetwork, !enabled);
      assert.equal(f.requested.at(-1)?.force, true);
      assert.deepEqual(f.requested.at(-1)?.providers, ["openai"]);
    }
  } finally {
    if (offline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = offline;
  }
});

test("a newly published faux model appears on forced refresh and selects the exact provider", { timeout: 5000 }, async () => {
  const f = await fixture();
  const first = await f.run({ action: "list" });
  assert.equal(first.success, true);
  if (first.success && "models" in first.data) assert.ok(first.data.models.every((model) => model.id === "old"));
  assert.equal(f.calls(), 0);
  f.publish();
  const listed = await f.run({ action: "list", force: true });
  assert.equal(listed.success, true);
  if (listed.success && "models" in listed.data) assert.equal(listed.data.models.length, 4);
  for (const provider of ["openai", "openrouter"]) {
    const result = await f.run({ action: "set", provider, modelId: "gpt-6.2-sol" });
    assert.equal(result.success, true);
    const original = f.runtime.getModel(provider, "gpt-6.2-sol")!;
    if (result.success) assert.deepEqual(result.data, { model: { provider, id: original.id, name: original.name,
      reasoning: original.reasoning, input: original.input, contextWindow: original.contextWindow }, thinkingLevel: "high" });
    assert.equal(f.state.model?.provider, provider);
    assert.deepEqual(f.requested.at(-1)?.providers, [provider]);
    assert.equal(f.requested.at(-1)?.force, true);
    assert.equal(f.requested.at(-1)?.allowNetwork, process.env.PI_OFFLINE === undefined);
  }
});

test("model-control list and set return only public picker descriptors", { timeout: 5000 }, async () => {
  const f = await fixture();
  const original = f.runtime.getModel("openai", "old")!;
  assert.equal(original.baseUrl, "https://faux-private-endpoint.invalid/v1");
  assert.equal(original.headers?.["X-Faux-Secret"], "synthetic-private-header");
  const listed = await f.run({ action: "list" });
  const selected = await f.run({ action: "set", provider: "openai", modelId: "old" });
  assert.equal(listed.success, true);
  assert.equal(selected.success, true);
  const descriptor = { provider: "openai", id: original.id, name: original.name, reasoning: original.reasoning,
    input: original.input, contextWindow: original.contextWindow };
  if (listed.success && "models" in listed.data) assert.deepEqual(listed.data.models.find((model) => model.provider === "openai"), descriptor);
  if (selected.success) assert.deepEqual(selected.data, { model: descriptor, thinkingLevel: "high" });
  const output = JSON.stringify([listed, selected]);
  for (const privateValue of [original.baseUrl, "X-Faux-Secret", "synthetic-private-header", "headers", "baseUrl"]) {
    assert.equal(output.includes(privateValue), false, "request configuration is not picker metadata");
  }
});

test("set itself forces provider discovery; missing models and auth never fall back", { timeout: 5000 }, async () => {
  const f = await fixture();
  f.publish();
  assert.equal((await f.run({ action: "set", provider: "openai", modelId: "gpt-6.2-sol" })).success, true);
  const missing = await f.run({ action: "set", provider: "openai", modelId: "missing" });
  assert.equal(missing.success, false);
  if (!missing.success) assert.equal(missing.error.code, "model_unavailable");
  f.noAuth();
  const auth = await f.run({ action: "set", provider: "openrouter", modelId: "gpt-6.2-sol" });
  assert.equal(auth.success, false);
  assert.equal(f.state.model?.provider, "openai");
});

test("refresh failure, cancellation and deadlines return explicit errors without selecting", { timeout: 5000 }, async () => {
  const failed = await fixture();
  failed.fail();
  const failure = await failed.run({ action: "set", provider: "openai", modelId: "old" });
  assert.equal(failure.success, false);
  if (!failure.success) assert.equal(failure.error.code, "model_refresh_failed");
  assert.equal(failed.calls(), 0);
  const expired = await fixture(10);
  let release!: () => void;
  expired.hold(() => new Promise<void>((resolve) => { release = resolve; }));
  const timeout = await expired.run({ action: "set", provider: "openai", modelId: "old" });
  assert.equal(timeout.success, false);
  if (!timeout.success) assert.equal(timeout.error.code, "model_refresh_aborted");
  assert.equal(expired.calls(), 0);
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(expired.calls(), 0, "a provider finishing after the refresh deadline cannot execute a late switch");
  assert.equal(expired.results.length, 1, "a late refresh cannot publish a second command result");
  const cancelled = await fixture();
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  cancelled.hold(() => new Promise<void>((resolve) => { release = resolve; entered(); }));
  const operation = cancelled.run({ action: "set", provider: "openai", modelId: "old" });
  await waiting;
  cancelled.controller.abort();
  assert.equal((await operation).success, false);
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(cancelled.calls(), 0, "a cancelled refresh cannot execute a late switch");
  assert.equal(cancelled.results.length, 1);
});

test("busy, queued input and changed file/branch during refresh refuse the switch", { timeout: 5000 }, async () => {
  for (const mutation of ["idle", "queued", "file", "session", "leaf"] as const) {
    const f = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    f.hold(() => new Promise<void>((resolve) => { release = resolve; entered(); }));
    const operation = f.run({ action: "set", provider: "openai", modelId: "old" });
    await waiting;
    if (mutation === "idle") f.state.idle = false;
    else if (mutation === "queued") f.state.queued = true;
    else f.state[mutation] = "changed";
    release();
    const result = await operation;
    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.error.code, mutation === "idle" || mutation === "queued" ? "agent_working" : "stale_context");
    assert.equal(f.calls(), 0);
  }
});
