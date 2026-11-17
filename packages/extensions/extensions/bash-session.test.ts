import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import remoteExtension from "../../orchestration/extensions/remote.ts";
import { installSshStub, setSessionRemote } from "../../orchestration/test/ssh-stub.ts";
import bashExtension from "./bash.ts";

for (const remote of [false, true]) {
  for (const localFirst of [false, true]) {
    test(`SDK bash selects ${remote ? "SSH" : "local"} execution with ${localFirst ? "local" : "remote"} extension first`, { timeout: 20_000 }, async (t) => {
      const stub = installSshStub(t);
      const local = join(stub.root, "local");
      const agentDir = join(stub.root, "agent");
      const temporary = join(stub.root, "tmp");
      for (const directory of [local, agentDir, temporary]) mkdirSync(directory);
      const environment = {
        HOME: local,
        TMPDIR: temporary,
        PI_CODING_AGENT_DIR: agentDir,
        XDG_CONFIG_HOME: join(local, "config"),
        XDG_DATA_HOME: join(local, "data"),
        XDG_CACHE_HOME: join(local, "cache"),
        BASH_ENV: undefined,
        ENV: undefined,
      };
      const previous = new Map(Object.keys(environment).map((name) => [name, process.env[name]]));
      for (const [name, value] of Object.entries(environment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      t.after(() => {
        for (const [name, value] of previous) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      });
      setSessionRemote(t, remote ? `box:${stub.home}` : undefined);
      const faux = fauxProvider({ provider: "bash-session-faux", models: [{ id: "fixture" }], tokensPerSecond: 100_000 });
      const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(), modelsPath: null,
        modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false,
      });
      const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
      const loader = new DefaultResourceLoader({
        cwd: local, agentDir, settingsManager, noExtensions: true, noSkills: true,
        noContextFiles: true, noPromptTemplates: true, noThemes: true,
        extensionFactories: [
          (pi) => pi.registerProvider(faux.provider),
          ...(localFirst ? [bashExtension, remoteExtension] : [remoteExtension, bashExtension]),
        ],
      });
      await loader.reload();
      const { session, extensionsResult } = await createAgentSession({
        cwd: local, agentDir, modelRuntime, settingsManager, resourceLoader: loader,
        model: faux.getModel(), tools: ["bash"], sessionManager: SessionManager.inMemory(local),
      });
      try {
        assert.deepEqual(extensionsResult.errors, []);
        const errors: string[] = [];
        await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.error) });
        await modelRuntime.setRuntimeApiKey(faux.provider.id, "fixture-key");
        await modelRuntime.getAvailable();
        const tools = session.getAllTools().filter((tool) => tool.name === "bash");
        assert.equal(tools.length, 1, "only the matching local or remote extension owns bash");
        assert.match(tools[0]!.description, /Usually omit `timeout`; it defaults to 900 seconds \(15 minutes\)/);
        const parameters = tools[0]!.parameters as {
          required: string[];
          properties: { timeout: { type: string; description: string } };
        };
        assert.deepEqual(parameters.required, ["command"]);
        assert.equal(parameters.properties.timeout.type, "number");
        assert.equal(parameters.properties.timeout.description, "Timeout in seconds. Optional; defaults to 900 (15 minutes).");
        const timer = t.mock.method(globalThis, "setTimeout");
        for (const timeout of [undefined, 42]) {
          const args = { command: "pwd", ...(timeout === undefined ? {} : { timeout }) };
          faux.setResponses([
            fauxAssistantMessage(fauxToolCall("bash", args), { stopReason: "toolUse" }),
            fauxAssistantMessage("done"),
          ]);
          timer.mock.resetCalls();
          await session.prompt("Run the fixture command.");
          const result = session.messages.findLast((message) => message.role === "toolResult");
          assert.ok(result?.role === "toolResult");
          assert.equal(result.isError, false, JSON.stringify(result.content));
          assert.equal(result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim(), remote ? stub.home : local);
          assert.ok(timer.mock.calls.some((call) => call.arguments[1] === (timeout ?? 900) * 1000));
          if (timeout !== undefined) assert.ok(!timer.mock.calls.some((call) => call.arguments[1] === 900_000));
        }
        if (remote) {
          assert.ok(stub.scripts().some(({ destination, script }) => destination === "box" && script.includes("PI_REMOTE_EXIT")), "bash reached SSH's process-group runner");
        } else {
          assert.deepEqual(stub.scripts(), [], "local execution never called SSH");
        }
        assert.deepEqual(errors, []);
      } finally {
        session.dispose();
      }
    });
  }
}
