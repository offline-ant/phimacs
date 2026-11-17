import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createClaimTestEnvironment, lookupClaim } from "@phimacs/pimux/ownership";
import { createPreparedSession, flushSessionFile } from "./context.ts";
import { workerResumeCommand } from "./worker-resume.ts";

const exec = promisify(execFile);
const PI = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));

function environment(t: test.TestContext) {
  const sandbox = createClaimTestEnvironment();
  const root = sandbox.root;
  const home = path.join(root, "home");
  const temporary = path.join(root, "tmp");
  fs.mkdirSync(home); fs.mkdirSync(temporary);
  const keys = ["PHIMACS_PI", "PHIMACS_TEST_ROOT", "PI_CODING_AGENT_DIR"];
  const previous = keys.map((key) => process.env[key]);
  process.env.PHIMACS_PI = PI;
  process.env.PHIMACS_TEST_ROOT = root;
  t.after(() => {
    keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { sandbox, root, env: { ...sandbox.env, HOME: home, TMPDIR: temporary, PATH: process.env.PATH, PI_OFFLINE: "1" } };
}

test("managed resume quotes paths and cannot execute an injected shell expression or PATH Pi", { timeout: 30_000 }, async (t) => {
  const { root, sandbox, env } = environment(t);
  const injected = path.join(root, "injected");
  const file = path.join(sandbox.sessions, `worker's $(touch ${injected}); session.jsonl`);
  const agentDir = path.join(root, "agent's config");
  fs.mkdirSync(agentDir);
  process.env.PI_CODING_AGENT_DIR = path.relative(process.cwd(), agentDir);
  const command = workerResumeCommand(file);
  const result = await exec("/bin/sh", ["-c", `${command} --help`], { env, timeout: 25_000, maxBuffer: 1024 * 1024 });
  assert.match(result.stdout, /Usage|Options|usage|pi -/);
  assert.equal(fs.existsSync(injected), false);
  assert.ok(command.includes(`'${process.execPath}'`));
  assert.match(command, /\/pimux' tui -- /);
  assert.ok(command.includes(`'${fs.realpathSync(PI)}'`));
  for (const key of ["PHIMACS_MANAGED_CLAIM", "PHIMACS_PARENT_TASK", "PHIMACS_PARENT_TASK_FILE", "PIMUX_DISCOVERY", "PI_ORCHESTRATION_HOST", "PI_ORCHESTRATION_ENDPOINT"]) assert.ok(command.includes(`-u ${key}`));
  assert.doesNotMatch(command, /worker-frame|--no-context|--provider|--model|PI_ORCHESTRATION_ENDPOINT=/);
  assert.equal(lookupClaim(file, sandbox.options), undefined, "help completion released the stopped writer claim");
  delete process.env.PI_CODING_AGENT_DIR;
  assert.doesNotMatch(workerResumeCommand(file), /PI_CODING_AGENT_DIR=/);
});

test("offered managed command restores normal resources, saved model/history/cwd and usable tools", { timeout: 30_000 }, async (t) => {
  const { root, sandbox, env } = environment(t);
  const cwd = path.join(root, "worker's project");
  const agentDir = path.join(root, "private agent");
  fs.mkdirSync(cwd); fs.mkdirSync(agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  fs.writeFileSync(path.join(cwd, "resume-proof.txt"), "correct worker cwd");
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ extensions: [
    fileURLToPath(new URL("./worker-frame.ts", import.meta.url)),
    fileURLToPath(new URL("./test/worker-resume-fixture.ts", import.meta.url)),
  ], compaction: { enabled: false }, retry: { enabled: false } }));
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "worker-resume-fixture": { apiKey: "offline-resume-fixture" } } }));
  const { session, sessionFile: file } = createPreparedSession(cwd);
  session.appendCustomEntry("pi-orchestration:delegate", { tool: "fresh_look", context: "clean" });
  session.appendModelChange("worker-resume-fixture", "resume");
  session.appendThinkingLevelChange("off");
  session.appendMessage({ role: "user", content: "saved worker progress", timestamp: Date.now() });
  session.appendSessionInfo("Human-renamed worker");
  flushSessionFile(session, file);
  const originalEntries = session.getEntries();
  const command = `${workerResumeCommand(file)} --mode json -p 'Continue the saved work'`;
  const execution = exec("/bin/sh", ["-c", command], { cwd: root, timeout: 25_000, maxBuffer: 1024 * 1024, env: {
    ...env, PI_NESTED: "3", PI_ORCHESTRATION_CONTROL: "/must-not-bind.sock", PI_ORCHESTRATION_TARGET: "old-worker",
    PI_ORCHESTRATION_ENDPOINT: "http://do-not-use.invalid", PHIMACS_MANAGED_CLAIM: "obsolete-capability",
    PHIMACS_PARENT_TASK: "obsolete-parent", PHIMACS_PARENT_TASK_FILE: "/must-not-read.json", PIMUX_DISCOVERY: "/must-not-publish.json",
  } });
  execution.child.stdin?.end();
  const { stdout, stderr } = await execution;
  assert.equal(stderr, "", stdout);
  assert.match(stdout, /resumed ordinary session/);
  assert.doesNotMatch(stdout, /retrospective|Could not start worker request/);
  assert.equal(lookupClaim(file, sandbox.options), undefined, "actual writer exited before reopening for verification");
  const resumed = SessionManager.open(file);
  assert.equal(resumed.getCwd(), cwd);
  assert.equal(resumed.getSessionName(), "Human-renamed worker", "ordinary resume must retain human-renamed titles");
  assert.deepEqual(resumed.getEntries().slice(0, originalEntries.length), originalEntries);
  assert.ok(resumed.getEntries().length > originalEntries.length);
});
