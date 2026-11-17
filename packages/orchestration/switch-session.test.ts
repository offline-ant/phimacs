import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices,
  initTheme, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type AgentSessionRuntime, type CreateAgentSessionRuntimeFactory, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { registerSwitch } from "./extensions/switch.ts";
import type { SwitchSource } from "./switch-destinations.ts";

initTheme("dark");

async function fixture(t: TestContext, options: { muxId?: string; failure?: boolean } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-switch-sdk-"));
  const agentDir = path.join(directory, "agent");
  const sessionDir = path.join(agentDir, "sessions", "fixture");
  fs.mkdirSync(sessionDir, { recursive: true });
  const provider = fauxProvider({ provider: "switch-sdk-fixture", models: [{ id: "one", reasoning: true }], tokensPerSecond: 1_000_000 });
  let inferenceCalls = 0;
  provider.setResponses(Array.from({ length: 8 }, () => () => { inferenceCalls++; return fauxAssistantMessage("faux answer"); }));
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: path.join(agentDir, "models-store.json"), allowModelNetwork: false,
  });
  const settingsManager = SettingsManager.inMemory({ defaultProvider: provider.provider.id, defaultModel: "one", compaction: { enabled: false }, retry: { enabled: false } });
  const notices: string[] = [];
  const errors: string[] = [];
  const prepared: SwitchSource[] = [];
  const lifecycle: string[] = [];
  let runtime: AgentSessionRuntime;
  const extension: ExtensionFactory = (pi) => {
    pi.registerProvider(provider.provider);
    pi.on("session_start", () => { lifecycle.push("start"); });
    pi.on("session_before_switch", () => { lifecycle.push("before-switch"); });
    pi.on("session_shutdown", () => { lifecycle.push("shutdown"); });
    registerSwitch(pi, {
      environment: () => ({ HOME: directory, PI_CODING_AGENT_DIR: agentDir, HERDR_ENV: "1" }),
      runtime: () => options.muxId,
      prepare: async (_kind, source) => {
        prepared.push(source);
        return { start: async () => { if (options.failure) throw new Error("attachment uncertain"); return "Emacs fixture attached"; } };
      },
    });
  };
  const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime, settingsManager,
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true, extensionFactories: [extension] },
    });
    const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent,
      model: sessionManager.getEntries().length === 0 ? provider.getModel() : undefined, tools: ["read", "bash"],
    });
    assert.deepEqual(created.extensionsResult.errors, []);
    return { ...created, services, diagnostics: services.diagnostics };
  };
  runtime = await createAgentSessionRuntime(createRuntime, { cwd: directory, agentDir, sessionManager: SessionManager.create(directory, sessionDir) });
  async function bind(session: AgentSession): Promise<void> {
    const baseUi = session.extensionRunner.createContext().ui;
    await session.bindExtensions({ mode: "rpc", uiContext: { ...baseUi, notify: (message) => { notices.push(message); } },
      shutdownHandler: () => { lifecycle.push("stop"); }, onError: (error) => { errors.push(error.error); },
      commandContextActions: {
        waitForIdle: () => runtime.session.waitForIdle(), newSession: (opts) => runtime.newSession(opts),
        switchSession: (file, opts) => runtime.switchSession(file, opts), fork: (id, opts) => runtime.fork(id, opts),
        navigateTree: async () => ({ cancelled: true }), reload: () => runtime.session.reload(),
      },
    });
  }
  runtime.setRebindSession(bind);
  await bind(runtime.session);
  await modelRuntime.setRuntimeApiKey(provider.provider.id, "fixture-key");
  await modelRuntime.getAvailable();
  await runtime.session.prompt("persist the original conversation");
  const original = runtime.session.sessionFile!;
  t.after(async () => { await runtime.dispose(); fs.rmSync(directory, { recursive: true, force: true }); assert.deepEqual(errors, []); });
  return { runtime, original, notices, prepared, lifecycle, inferenceCalls: () => inferenceCalls };
}

for (const command of ["/switch emacs", "/switch herdr"]) {
  test(`real Pi SDK: ${command} cannot open a destination while an unfreezable source remains loaded`, async (t) => {
    const f = await fixture(t);
    const source = f.runtime.session;
    const bytes = fs.readFileSync(f.original, "utf8");
    const leaf = source.sessionManager.getLeafId();
    await source.prompt(command);
    assert.equal(f.runtime.session, source, "no same-file reload masquerades as writer release");
    assert.equal(source.sessionManager.getLeafId(), leaf);
    assert.equal(fs.readFileSync(f.original, "utf8"), bytes);
    assert.deepEqual(f.prepared, []);
    assert.deepEqual(f.lifecycle, ["start"]);
    assert.equal(f.inferenceCalls(), 1);
    assert.match(f.notices.at(-1)!, /No claim was released and no destination was opened/);
  });
}

test("real Pi SDK: shared attachment preserves selected branch/model/thinking/tools without appending transfer entries", async (t) => {
  const f = await fixture(t, { muxId: "same-runtime" });
  const source = f.runtime.session;
  const leaf = source.sessionManager.getLeafId()!;
  await source.prompt("abandoned branch");
  source.sessionManager.branch(leaf);
  source.refreshContext();
  source.setThinkingLevel("high");
  source.setActiveToolsByName(["read"]);
  const selectedLeaf = source.sessionManager.getLeafId();
  const bytes = fs.readFileSync(f.original, "utf8");
  const calls = f.inferenceCalls();
  await source.prompt("/switch emacs");
  assert.equal(f.runtime.session, source);
  assert.equal(f.prepared.length, 1);
  assert.deepEqual(f.prepared[0]!.runtime, { protocol: 2, muxId: "same-runtime" });
  assert.equal(source.sessionManager.getLeafId(), selectedLeaf);
  assert.equal(source.thinkingLevel, "high");
  assert.deepEqual(source.getActiveToolNames(), ["read"]);
  assert.equal(fs.readFileSync(f.original, "utf8"), bytes);
  assert.deepEqual(f.lifecycle, ["start"]);
  assert.equal(f.inferenceCalls(), calls);
});

test("real Pi SDK: uncertain attachment leaves the original context usable with no fallback writer", async (t) => {
  const f = await fixture(t, { muxId: "same-runtime", failure: true });
  const source = f.runtime.session;
  const bytes = fs.readFileSync(f.original, "utf8");
  await source.prompt("/switch emacs");
  assert.equal(f.runtime.session, source);
  assert.equal(fs.readFileSync(f.original, "utf8"), bytes);
  assert.deepEqual(f.lifecycle, ["start"]);
  assert.match(f.notices.at(-1)!, /attachment uncertain/);
  await source.prompt("explicit new user message");
  assert.equal(f.inferenceCalls(), 2, "only explicit user work runs, not inferred transfer retries");
});
