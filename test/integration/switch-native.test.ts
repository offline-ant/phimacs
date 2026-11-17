import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { createClaimTestEnvironment } from "@phimacs/pimux/ownership";
import { processIdentityStatus, readProcessIdentity } from "@phimacs/pimux/process-identity";
import { PI, until } from "../../packages/pimux/test/harness.ts";
import { switchExtension, switchNativeFixture } from "../support/assets.ts";

interface Trace { event: string; pid: number; file: string; sessionId: string; namespaces: Record<string, string> }

test("unmanaged RPC refuses Emacs and Herdr before destination preparation and keeps its source usable", { timeout: 20_000 }, async (t) => {
  const isolation = createClaimTestEnvironment();
  const directory = isolation.root;
  const home = path.join(directory, "home");
  const agent = path.join(directory, "agent");
  const temporary = path.join(directory, "tmp");
  const namespaces = {
    HOME: home, TMPDIR: temporary, PHIMACS_STATE_DIR: path.join(directory, "state"),
    XDG_CONFIG_HOME: path.join(directory, "config"), XDG_CACHE_HOME: path.join(directory, "cache"),
    XDG_STATE_HOME: path.join(directory, "xdg-state"), XDG_DATA_HOME: path.join(directory, "data"),
    XDG_RUNTIME_DIR: path.join(directory, "runtime"), PI_CODING_AGENT_DIR: agent,
    PI_CODING_AGENT_SESSION_DIR: isolation.sessions, PIMUX_DIR: path.join(directory, "mux"),
  };
  for (const folder of Object.values(namespaces)) fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({
    defaultProvider: "switch-native-fixture", defaultModel: "one", defaultThinkingLevel: "high",
    compaction: { enabled: false }, retry: { enabled: false },
  }), { mode: 0o600 });
  const sessionFile = path.join(isolation.sessions, "unmanaged.jsonl");
  fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd: directory })}\n`, { mode: 0o600 });
  const launcher = path.join(directory, "unexpected-launcher");
  const launched = path.join(directory, "destination-prepared");
  fs.writeFileSync(launcher, `#!/bin/sh\nprintf prepared > '${launched}'\nexit 1\n`, { mode: 0o700 });
  const env: NodeJS.ProcessEnv = { ...process.env, ...isolation.env, ...namespaces,
    PHIMACS_PI: PI, PHIMACS_EMACS_LAUNCHER: launcher };
  for (const key of Object.keys(env)) {
    if (key.startsWith("PI_ORCHESTRATION_") || key.startsWith("PHIMACS_PARENT_") || key === "PHIMACS_MANAGED_CLAIM"
      || key === "PIMUX_DISCOVERY" || key === "PI_REMOTE" || key === "PI_NESTED") delete env[key];
  }
  const source = spawn(process.execPath, [PI, "--mode", "rpc", "--session", sessionFile,
    "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates",
    "--provider", "switch-native-fixture", "--model", "one", "--thinking", "high",
    "-e", switchExtension, "-e", switchNativeFixture], { cwd: directory, env, stdio: ["pipe", "pipe", "pipe"] });
  const records: Record<string, unknown>[] = [];
  let diagnostic = "";
  source.stderr.on("data", chunk => { diagnostic += chunk.toString(); });
  createInterface({ input: source.stdout }).on("line", line => {
    try { records.push(JSON.parse(line) as Record<string, unknown>); } catch { diagnostic += line; }
  });
  t.after(async () => {
    if (source.exitCode === null && source.signalCode === null) source.kill("SIGTERM");
    await until(() => source.exitCode !== null || source.signalCode !== null, `owned unmanaged Pi exited: ${diagnostic}`);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const trace = (): Trace[] => {
    const file = path.join(directory, "switch-trace.jsonl");
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Trace) : [];
  };
  const started = await until(() => trace().find(entry => entry.event === "start"), `unmanaged source startup: ${diagnostic}`);
  assert.deepEqual(started.namespaces, namespaces, "the Pi process receives only fixture-owned state and resource namespaces");
  const identity = readProcessIdentity(source.pid!)!;
  const request = async (id: string, message: string): Promise<void> => {
    source.stdin.write(`${JSON.stringify({ type: "prompt", id, message })}\n`);
    const response = await until(() => records.find(record => record.type === "response" && record.id === id), `response to ${message}: ${diagnostic}`);
    assert.equal(response.success, true, String(response.error));
  };
  // Add an in-memory marker without inference, then preserve the file bytes.
  await request("mark", "/switch-smoke-mark original");
  await until(() => trace().find(entry => entry.event === "marked"), "original branch marker recorded");
  const bytes = fs.readFileSync(sessionFile, "utf8");
  for (const destination of ["emacs", "herdr"]) {
    const mark = records.length;
    await request(destination, `/switch ${destination}`);
    await until(() => records.slice(mark).find(record => record.type === "extension_ui_request"
      && typeof record.message === "string" && record.message.includes("No claim was released and no destination was opened")), `${destination} refusal`);
    assert.equal(processIdentityStatus(identity), "alive");
    assert.equal(fs.existsSync(launched), false, "no destination launcher was invoked");
    assert.equal(fs.readFileSync(sessionFile, "utf8"), bytes);
  }
  await request("state", "/switch-smoke-state");
  await until(() => trace().find(entry => entry.event === "state" && entry.pid === source.pid), "unchanged source still handles explicit commands");
  assert.deepEqual(trace().map(entry => entry.event), ["start", "marked", "state"]);
  assert.equal(fs.readFileSync(sessionFile, "utf8"), bytes);
});
