// Real SDK parent and detached child; only the disposable Emacs attachment is synthetic.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { lookupClaim } from "@phimacs/pimux/ownership";
import { listRuntimes, stopRuntime } from "@phimacs/pimux/runtime";
import delegateExtension from "../extensions/delegate.ts";
import { readTarget } from "../workers.ts";
import type { WorkerRequestFile, WorkerResultFile } from "../worker-frame.ts";

const tool = process.argv[2];
assert.ok(tool === "microdo" || tool === "do");
const directory = process.cwd();
const agentDir = process.env.PI_CODING_AGENT_DIR!;
const provider = fauxProvider({ provider: "orchestration-fixture", models: [{ id: "one", reasoning: true }], tokensPerSecond: 100_000 });
provider.setResponses([
  fauxAssistantMessage(fauxToolCall(tool, { task: "Update example.md" }), { stopReason: "toolUse" }),
  (context) => {
    const result = context.messages.findLast((message) => message.role === "toolResult");
    assert.ok(result?.role === "toolResult");
    assert.equal(result.isError, false, JSON.stringify(result.content));
    return fauxAssistantMessage("Parent finished");
  },
]);
const modelRuntime = await ModelRuntime.create({
  credentials: new InMemoryCredentialStore(), modelsPath: null,
  modelsStorePath: path.join(agentDir, "models-store.json"), allowModelNetwork: false,
});
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
let ownedMuxId: string | undefined;
const loader = new DefaultResourceLoader({
  cwd: directory, agentDir, settingsManager, noExtensions: true, noSkills: true,
  noContextFiles: true, noPromptTemplates: true, noThemes: true,
  extensionFactories: [(pi) => {
    pi.registerProvider(provider.provider);
    pi.on("before_agent_start", (_event, ctx) => {
      assert.equal(ctx.model?.provider, provider.provider.id, "parent inference must stay faux");
    });
    delegateExtension({ ...pi, exec: async (_command, args) => {
      const encoded = /pi-orchestration-dispatch "([A-Za-z0-9+/=]+)"/.exec(args.at(-1)!)?.[1];
      assert.ok(encoded, "only the test's synthetic Emacs attachment may use exec");
      const input = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as {
        operation: string; id: string; muxId?: string; spec?: { runtime: { muxId: string } };
      };
      let response: object;
      switch (input.operation) {
        case "start":
          ownedMuxId = input.spec!.runtime.muxId;
          response = { target: { id: input.id }, muxId: ownedMuxId }; break;
        case "state": response = { ready: true, state: "running", muxId: ownedMuxId }; break;
        case "close": case "task-finished": response = { success: true }; break;
        default: throw new Error(`Unexpected Emacs operation: ${input.operation}`);
      }
      return { code: 0, stdout: JSON.stringify(Buffer.from(JSON.stringify(response)).toString("base64")), stderr: "", killed: false, truncated: false };
    } });
  }],
});
await loader.reload();
const { session, extensionsResult } = await createAgentSession({
  cwd: directory, agentDir, modelRuntime, settingsManager, resourceLoader: loader,
  model: provider.getModel(), thinkingLevel: "off", tools: ["do", "microdo"],
  sessionManager: SessionManager.create(directory, path.join(directory, "sessions")),
});
const errors: string[] = [];
try {
  assert.deepEqual(extensionsResult.errors, []);
  await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.error) });
  await modelRuntime.setRuntimeApiKey(provider.provider.id, "offline-fixture");
  await modelRuntime.getAvailable();
  await session.prompt(`Run ${tool} now.`);
  assert.deepEqual(errors, []);
  const result = session.messages.findLast((message) => message.role === "toolResult");
  assert.ok(result?.role === "toolResult");
  assert.equal(result.isError, false, JSON.stringify(result.content));
  // Pi persists tool details as JSON rather than retaining the tool's result type.
  const details = result.details as unknown as {
    target: { name: string }; sessionFile: string; result: WorkerResultFile;
    artifacts: { requestPath: string; resultPath: string; retrospectiveMarkdownPath: string; artifactDir: string };
  };
  const request = JSON.parse(fs.readFileSync(details.artifacts.requestPath, "utf8")) as WorkerRequestFile;
  const final = JSON.parse(fs.readFileSync(details.artifacts.resultPath, "utf8")) as WorkerResultFile;
  const task = JSON.parse(fs.readFileSync(path.join(details.artifacts.artifactDir, "parent-task.json"), "utf8")) as { state: string };
  assert.deepEqual(final, details.result);
  // Pi can exit just before its detached wrapper releases the writer claim.
  const cleanupDeadline = performance.now() + 3_000;
  while (lookupClaim(details.sessionFile) || listRuntimes(process.env).length) {
    assert.ok(performance.now() < cleanupDeadline, "the actual child and its wrapper finish cleanup");
    await delay(10);
  }
  assert.equal(lookupClaim(details.sessionFile), undefined, "actual child exit releases its writer claim");
  assert.equal(readTarget(details.target.name), undefined, "completion removes the owned target");
  assert.equal(listRuntimes(process.env).length, 0, "the detached child exited before returning to the parent");
  assert.equal(task.state, "ended");
  console.log(JSON.stringify({
    resultPolicy: request.resultPolicy, result: final.result, retrospective: final.retrospective,
    retrospectiveArtifact: fs.existsSync(details.artifacts.retrospectiveMarkdownPath), childSession: details.sessionFile,
  }));
} finally {
  await session.abort();
  session.dispose();
  for (const runtime of listRuntimes(process.env)) await stopRuntime(runtime.muxId, { env: process.env });
}
