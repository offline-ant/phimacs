// Exercise the public worker tools through actual detached Pi children with faux-only inference.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { createClaimTestEnvironment } from "@phimacs/pimux/ownership";
import { listRuntimes, stopRuntime } from "@phimacs/pimux/runtime";
import { startTestService } from "../pimux/test/harness.ts";

const exec = promisify(execFile);
const PI = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
const FRAME = fileURLToPath(new URL("./worker-frame.ts", import.meta.url));
const FAUX = fileURLToPath(new URL("./test/lifecycle-fixture.ts", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./test/microdo-child-fixture.ts", import.meta.url));
const enabled = process.env.PI_MICRODO_CHILD === "1";

interface ChildRequest {
  event: string;
  pid: number;
  session: string;
  retrospective?: boolean;
  summary?: boolean;
  prompt?: string;
}

for (const tool of ["microdo", "do"] as const) {
  test(`${tool} completes through a real child with ${tool === "microdo" ? "one main request only" : "its normal retrospective"}`, {
    skip: enabled ? false : "Set PI_MICRODO_CHILD=1 for the bounded actual-child integration lane",
    timeout: 45_000,
  }, async (t) => {
    const sandbox = createClaimTestEnvironment();
    const { root } = sandbox;
    const temporary = path.join(root, "tmp");
    const home = path.join(root, "home");
    const agentDir = path.join(root, "agent");
    const mux = path.join(root, "mux");
    for (const directory of [temporary, home, agentDir, mux]) fs.mkdirSync(directory, { mode: 0o700 });
    const env: NodeJS.ProcessEnv = {
      ...process.env, ...sandbox.env, TMPDIR: temporary, HOME: home, PI_CODING_AGENT_DIR: agentDir,
      PIMUX_DIR: mux, PHIMACS_PI: PI, PI_OFFLINE: "1", PI_NESTED: "0",
    };
    delete env.PI_REMOTE;
    for (const name of Object.keys(env)) {
      if (/^(PI_ORCHESTRATION_|PHIMACS_PARENT_TASK|PHIMACS_MANAGED_CLAIM|PIMUX_DISCOVERY)/.test(name)) delete env[name];
    }
    Object.assign(env, {
      PI_ORCHESTRATION_HOST: "emacs", PI_ORCHESTRATION_ENDPOINT: path.join(root, "fake-emacs.sock"),
      PI_ORCHESTRATION_TARGET: "fixture-parent",
    });
    await startTestService(t, { dir: root, env });
    t.after(async () => {
      for (const runtime of listRuntimes(env)) await stopRuntime(runtime.muxId, { env });
      fs.rmSync(root, { recursive: true, force: true });
    });
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
      extensions: [FRAME, FAUX], packages: [], compaction: { enabled: false }, retry: { enabled: false },
    }));
    fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
      providers: { "orchestration-fixture": { apiKey: "offline-fixture" } },
    }));
    // Import orchestration only inside this subprocess, after TMPDIR is set, so
    // its module-scoped target registry cannot point at the user's registry.
    const execution = exec(process.execPath, [FIXTURE, tool], { cwd: root, env, timeout: 40_000, maxBuffer: 1024 * 1024 });
    execution.child.stdin?.end();
    const { stdout, stderr } = await execution;
    assert.equal(stderr, "", stdout);
    const result = JSON.parse(stdout.trim()) as {
      resultPolicy: string; result: string; retrospective?: string; retrospectiveArtifact: boolean; childSession: string;
    };
    const trace = fs.readFileSync(path.join(root, "lifecycle-trace.jsonl"), "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as ChildRequest);
    const requests = trace.filter((event) => event.event === "request");
    assert.equal(requests.length, tool === "microdo" ? 1 : 2);
    assert.equal(requests.filter((event) => !event.retrospective && !event.summary).length, 1);
    assert.equal(requests.filter((event) => event.retrospective).length, tool === "microdo" ? 0 : 1);
    assert.ok(requests.every((event) => event.pid !== execution.child.pid && event.pid !== process.pid), "requests execute in the actual child, not either test parent");
    assert.ok(requests.every((event) => event.session === result.childSession));
    assert.equal(result.result, "fixture result: Update example.md");
    assert.equal(result.resultPolicy, tool === "microdo" ? "brief" : "retrospective");
    assert.equal(result.retrospective, tool === "microdo" ? undefined : "fixture retrospective");
    assert.equal(result.retrospectiveArtifact, tool !== "microdo");
    if (tool === "microdo") assert.match(requests[0]!.prompt!, /at most three sentences/);
    assert.equal(listRuntimes(env).length, 0, "no owned runtime survives completion");
  });
}
