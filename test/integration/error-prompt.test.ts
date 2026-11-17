import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import {
  fauxAssistantMessage, fauxProvider, InMemoryCredentialStore,
  type AssistantMessage, type FauxResponseStep, type SimpleStreamOptions, type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, initTheme, ModelRuntime, SessionManager, SettingsManager,
  type ExtensionFactory, type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import errorPrompt, { CONTINUE_OPTION, CONTINUE_TEXT, REPLY_OPTION } from "../../packages/extensions/extensions/error-prompt.ts";
import { workerFrame, leaseWorkerRequest, parseWorkerResult, readWorkerStatus } from "../support/orchestration.ts";

initTheme("dark");

type Step = AssistantMessage | ((signal: AbortSignal | undefined) => Promise<AssistantMessage>);
interface Dialog {
  title: string;
  options: string[];
  signal: AbortSignal | undefined;
  answer: (choice: string | undefined) => void;
}

const failed = (errorMessage: string) => fauxAssistantMessage("", { stopReason: "error", errorMessage });
const REFUSAL = "Claude declined to respond (refusal: cyber): blocked";

/** Real Pi SDK session: the behaviour under test is Pi's ordering of retries, settlement and extension events. */
async function fixture(t: TestContext, options: { retry?: boolean; ui?: boolean; extensions?: ExtensionFactory[] } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-error-prompt-"));
  const agentDir = path.join(directory, "agent");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const provider = fauxProvider({ provider: "error-prompt-test", tokensPerSecond: 1_000_000 });
  const work: Step[] = [];
  const requests: TranscriptContext[] = [];
  const dispatch: FauxResponseStep = async (context: TranscriptContext, stream: SimpleStreamOptions | undefined) => {
    requests.push(context);
    const step = work.shift();
    assert.ok(step, "unexpected working request");
    return typeof step === "function" ? await step(stream?.signal) : step;
  };
  provider.setResponses(Array.from({ length: 50 }, () => dispatch));
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: path.join(agentDir, "models-store.json"), allowModelNetwork: false,
  });
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false }, retry: { enabled: options.retry === true, maxRetries: 2, baseDelayMs: 1 },
  });
  const blocked: Array<{ active: boolean; label?: string }> = [];
  const loader = new DefaultResourceLoader({
    cwd: directory, agentDir, settingsManager, noExtensions: true, noSkills: true,
    noContextFiles: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [(pi) => {
      pi.registerProvider(provider.provider);
      pi.events.on("herdr:blocked", (data) => blocked.push(data as { active: boolean; label?: string }));
    }, ...(options.extensions ?? []), errorPrompt],
  });
  await loader.reload();
  const created = await createAgentSession({
    cwd: directory, agentDir, modelRuntime, settingsManager, resourceLoader: loader,
    model: provider.getModel(), thinkingLevel: "off", tools: [],
    sessionManager: SessionManager.create(directory, path.join(directory, "sessions")),
  });
  const session = created.session;
  t.after(() => session.dispose());
  assert.deepEqual(created.extensionsResult.errors, []);

  const dialogs: Dialog[] = [];
  const notices: string[] = [];
  const errors: string[] = [];
  const uiContext: ExtensionUIContext = {
    ...session.extensionRunner.createContext().ui,
    select: (title, choices, dialog) => new Promise<string | undefined>((resolve) => {
      dialogs.push({ title, options: choices, signal: dialog?.signal, answer: resolve });
      dialog?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
    }),
    notify: (message) => { notices.push(message); },
  };
  await session.bindExtensions({
    mode: options.ui === false ? "print" : "rpc",
    ...(options.ui === false ? {} : { uiContext }),
    onError: (error) => errors.push(error.error),
  });
  await modelRuntime.setRuntimeApiKey(provider.provider.id, "fixture-key");
  await modelRuntime.getAvailable();
  t.after(() => assert.deepEqual(errors, []));

  async function settle(done: () => boolean = () => session.isIdle && work.length === 0) {
    for (let attempt = 0; attempt < 400; attempt++) {
      if (done() && session.isIdle) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (done() && session.isIdle) return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail("session did not settle");
  }
  return { session, work, requests, dialogs, notices, blocked, settle };
}

test("a terminal error asks while the session stays idle; Continue sends continue", async (t) => {
  const f = await fixture(t);
  f.work.push(failed(REFUSAL));
  await f.session.prompt("first");
  await f.settle(() => f.dialogs.length === 1);

  const dialog = f.dialogs[0]!;
  assert.equal(dialog.title, `Error: ${REFUSAL}`);
  assert.deepEqual(dialog.options, [CONTINUE_OPTION, REPLY_OPTION]);
  assert.equal(f.session.isIdle, true, "the open dialog must not hold the session unsettled");
  assert.deepEqual(f.blocked, [{ active: true, label: "Model error" }]);

  f.work.push(fauxAssistantMessage("recovered"));
  dialog.answer(CONTINUE_OPTION);
  await f.settle(() => f.work.length === 0);
  assert.equal(f.requests.length, 2);
  assert.ok(JSON.stringify(f.requests[1]!.messages).includes(`"${CONTINUE_TEXT}"`));
  assert.deepEqual(f.blocked.at(-1), { active: false });
  assert.equal(f.dialogs.length, 1);
});

test("a repeated refusal asks again and never loops by itself", async (t) => {
  const f = await fixture(t);
  f.work.push(failed(REFUSAL));
  await f.session.prompt("first");
  await f.settle(() => f.dialogs.length === 1);
  f.work.push(failed(REFUSAL));
  f.dialogs[0]!.answer(CONTINUE_OPTION);
  await f.settle(() => f.dialogs.length === 2);
  assert.equal(f.requests.length, 2);
  assert.equal(f.blocked.filter((event) => event.active).length, 2);
  assert.equal(f.blocked.filter((event) => !event.active).length, 1);
});

for (const [name, answer] of [["its reply option", REPLY_OPTION], ["cancelling", undefined]] as const) {
  test(`${name} leaves the conversation to the user`, async (t) => {
    const f = await fixture(t);
    f.work.push(failed("fixture permanent failure"));
    await f.session.prompt("first");
    await f.settle(() => f.dialogs.length === 1);
    f.dialogs[0]!.answer(answer);
    await f.settle(() => f.blocked.length === 2);
    assert.equal(f.requests.length, 1);
    assert.equal(f.session.isIdle, true);
  });
}

test("a typed prompt answers the question and releases the blocked state", async (t) => {
  const f = await fixture(t);
  f.work.push(failed(REFUSAL));
  await f.session.prompt("first");
  await f.settle(() => f.dialogs.length === 1);
  f.work.push(fauxAssistantMessage("answered"));
  await f.session.prompt("my own reply");
  await f.settle();
  assert.equal(f.dialogs[0]!.signal?.aborted, true);
  assert.deepEqual(f.blocked.at(-1), { active: false });
  assert.equal(f.requests.length, 2);
  assert.equal(JSON.stringify(f.requests[1]!.messages).includes(`"${CONTINUE_TEXT}"`), false);
});

test("Pi's own retries stay silent", async (t) => {
  const f = await fixture(t, { retry: true });
  f.work.push(failed("503 service unavailable"), fauxAssistantMessage("recovered"));
  await f.session.prompt("first");
  await f.settle();
  assert.equal(f.requests.length, 2);
  assert.equal(f.dialogs.length, 0);
});

test("exhausted retries ask once", async (t) => {
  const f = await fixture(t, { retry: true });
  f.work.push(failed("503 service unavailable"), failed("503 service unavailable"), failed("503 service unavailable"));
  await f.session.prompt("first");
  await f.settle(() => f.dialogs.length === 1);
  assert.equal(f.requests.length, 3);
  assert.equal(f.dialogs.length, 1);
});

test("the user's own abort does not ask", async (t) => {
  const f = await fixture(t);
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  f.work.push((signal) => new Promise((resolve) => {
    started();
    signal?.addEventListener("abort", () => resolve(failed("Operation aborted")), { once: true });
  }));
  const prompt = f.session.prompt("first");
  await running;
  await f.session.abort();
  await prompt;
  await f.settle();
  assert.equal(f.dialogs.length, 0);
});

test("a successful run and a run without UI do not ask", async (t) => {
  const f = await fixture(t);
  f.work.push(fauxAssistantMessage("fine"));
  await f.session.prompt("first");
  await f.settle();
  assert.equal(f.dialogs.length, 0);

  const headless = await fixture(t, { ui: false });
  headless.work.push(failed(REFUSAL));
  await headless.session.prompt("first");
  await headless.settle();
  assert.deepEqual(headless.blocked, []);
});

const FAUX_MODEL = { provider: "error-prompt-test", id: "faux-1" };

/** A worker fixture tears down like Pi's runtime, so the frame stops watching its lease before release. */
async function workerFixture(t: TestContext, worker: ReturnType<typeof leaseWorkerRequest>) {
  let shutdown: (() => Promise<unknown>) | undefined;
  t.after(() => shutdown?.());
  const f = await fixture(t, { extensions: [workerFrame] });
  shutdown = () => f.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  t.after(() => worker.release());
  return f;
}

test("a failed worker waits and Continue reaches the parent as user guidance", async (t) => {
  const worker = leaseWorkerRequest({ id: "failing-worker", task: "Fail.", tools: [], model: FAUX_MODEL, resultPolicy: "retrospective", thinkingLevel: "off" });
  const f = await workerFixture(t, worker);
  const { paths } = worker;
  f.work.push(failed(REFUSAL));
  await f.session.prompt(worker.prompt);
  await f.settle(() => f.dialogs.length === 1);
  assert.equal(readWorkerStatus(paths.statusPath)?.state, "waiting");
  assert.equal(f.dialogs[0]!.title, `Error: ${REFUSAL}`);

  f.work.push(fauxAssistantMessage("main result"), fauxAssistantMessage("retrospective"));
  f.dialogs[0]!.answer(CONTINUE_OPTION);
  await f.settle(() => fs.existsSync(paths.resultPath));
  const result = parseWorkerResult(fs.readFileSync(paths.resultPath, "utf8"), paths.resultPath, "failing-worker");
  assert.equal(result.isError, false);
  assert.equal(result.result, "main result");
  assert.deepEqual(result.guidance, [{ position: 1, text: CONTINUE_TEXT }]);
  assert.equal(f.dialogs.length, 1);
  assert.deepEqual(f.blocked, [{ active: true, label: "Model error" }, { active: false }]);
});

test("a failed worker retrospective ends the worker without asking", async (t) => {
  const worker = leaseWorkerRequest({ id: "retrospective-worker", task: "Finish.", tools: [], model: FAUX_MODEL, resultPolicy: "retrospective", thinkingLevel: "off" });
  const f = await workerFixture(t, worker);
  const { paths } = worker;
  f.work.push(fauxAssistantMessage("main result"), failed(REFUSAL));
  await f.session.prompt(worker.prompt);
  await f.settle(() => fs.existsSync(paths.resultPath));
  assert.equal(f.requests.length, 2);
  assert.equal(f.dialogs.length, 0);
  assert.deepEqual(f.blocked, []);
});
