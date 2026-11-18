// Real Pi/companion/router/CLI crossing with faux catalogs and no inference.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { agentCommand } from "./agent-cli.ts";
import { runtimeRequest } from "./request.ts";
import { isRecord } from "./protocol.ts";
import { startMux } from "./test/harness.ts";

const CATALOG = fileURLToPath(new URL("./test/model-catalog.ts", import.meta.url));

test("a running agent refreshes newly published faux models and selects OpenAI, not OpenRouter", { timeout: 20_000 }, async (t) => {
  const run = await startMux(t, { entries: 2, env: { PI_OFFLINE: "1" }, extensions: [CATALOG] });
  const settings = path.join(run.env.PI_CODING_AGENT_DIR!, "settings.json");
  const defaults = fs.readFileSync(settings, "utf8");
  const initial = await runtimeRequest(run.receipt, { type: "get_messages" });
  const list = await runtimeRequest(run.receipt, { type: "pimux_models", action: "list" });
  assert.equal(list.success, true, JSON.stringify(list.error));
  assert.ok(isRecord(list.data) && Array.isArray(list.data.models));
  assert.equal(list.data.models.some((model) => isRecord(model) && model.id === "gpt-6.2-sol"), false);
  fs.writeFileSync(path.join(run.dir, "catalog-published"), "faux catalog cache is now available");
  const selected = await agentCommand(["model", run.receipt.muxId, "openai/gpt-6.2-sol", "--timeout", "10000"], run.env);
  assert.equal(selected.exitCode, 0, JSON.stringify(selected.output));
  assert.ok(isRecord(selected.output) && isRecord(selected.output.model));
  assert.equal(selected.output.model.provider, "openai");
  assert.equal(selected.output.model.id, "gpt-6.2-sol");
  assert.deepEqual(Object.keys(selected.output.model).sort(), ["contextWindow", "id", "input", "name", "provider", "reasoning"]);
  const state = await runtimeRequest(run.receipt, { type: "get_state" });
  assert.ok(isRecord(state.data) && isRecord(state.data.model));
  assert.equal(state.data.model.provider, "openai");
  assert.equal(state.data.model.id, "gpt-6.2-sol");
  assert.equal(state.data.model.baseUrl, "https://faux-private-endpoint.invalid/v1", "existing native state contract stays unchanged");
  assert.deepEqual(state.data.model.headers, { "X-Faux-Secret": "synthetic-private-header" });
  const refreshed = await runtimeRequest(run.receipt, { type: "pimux_models", action: "list", force: true });
  assert.equal(refreshed.success, true);
  assert.ok(isRecord(refreshed.data) && Array.isArray(refreshed.data.models));
  assert.equal(refreshed.data.models.filter((model) => isRecord(model) && model.id === "gpt-6.2-sol").length, 2);
  const cliList = await agentCommand(["model", run.receipt.muxId, "--list"], run.env);
  assert.equal(cliList.exitCode, 0);
  const publicOutput = JSON.stringify([list, refreshed, selected.output, cliList.output]);
  for (const privateValue of ["https://faux-private-endpoint.invalid/v1", "X-Faux-Secret", "synthetic-private-header", "baseUrl", "headers"]) {
    assert.equal(publicOutput.includes(privateValue), false, "new responses and CLI output contain only public picker metadata");
  }
  assert.deepEqual((await runtimeRequest(run.receipt, { type: "get_messages" })).data, initial.data);
  assert.equal(fs.readFileSync(settings, "utf8"), defaults);
  assert.equal(run.first.records.some((record) => record.type === "agent_start"), false);
  const events = run.first.records.filter((record) => record.type === "pimux_model_changed");
  assert.ok(events.some((record) => isRecord(record.model) && record.model.provider === "openai"));
  assert.equal(run.discovery()?.muxId, run.receipt.muxId);
  assert.equal(run.discovery()?.piPid, run.receipt.piPid, "catalog refresh did not restart the agent");
});
