import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createClaimTestEnvironment, lookupClaim } from "@phimacs/pimux/ownership";
import { processIdentityStatus } from "@phimacs/pimux/process-identity";
import { listRuntimes, startRuntime, stopRuntime } from "@phimacs/pimux/runtime";
import { createParentTask, parentTaskEnvironment } from "./parent-task.ts";
import { runtimeIdentity, runtimeRequest } from "@phimacs/pimux/request";
import { createWorkerArtifacts, readWorkerStatus, writeWorkerRequest } from "./worker-frame.ts";
import { waitForWorkerResult } from "./workers.ts";
import { startTestService } from "../pimux/test/harness.ts";

const PI = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
const FRAME = fileURLToPath(import.meta.resolve("@phimacs/orchestration/worker-frame"));
const FAUX = fileURLToPath(new URL("./test/lifecycle-fixture.ts", import.meta.url));

for (const phase of ["before-run", "active-run", "invalid-request"] as const) {
  test(`real worker cleanup during ${phase} settles its parent without a result or retrospective`, { timeout: 20_000 }, async (t) => {
    const sandbox = createClaimTestEnvironment();
    const artifacts = createWorkerArtifacts();
    const task = createParentTask(artifacts.artifactDir, `cancel-${phase}`);
    const env = { ...process.env, ...sandbox.env, ...parentTaskEnvironment(task),
      HOME: path.join(sandbox.root, "home"), TMPDIR: path.join(sandbox.root, "tmp"),
      PI_CODING_AGENT_DIR: path.join(sandbox.root, "agent"), PIMUX_DIR: path.join(sandbox.root, "mux"),
      PHIMACS_PI: PI, PHIMACS_MANAGED_CLAIM: "",
      PI_ORCHESTRATION_PLACEMENT: "worker", PI_ORCHESTRATION_HOST: "emacs",
      PI_ORCHESTRATION_ENDPOINT: path.join(sandbox.root, "no-frontend.sock"), PI_ORCHESTRATION_TARGET: "cancel-test" };
    for (const directory of [env.HOME, env.TMPDIR, env.PI_CODING_AGENT_DIR, env.PIMUX_DIR]) fs.mkdirSync(directory, { mode: 0o700 });
    await startTestService(t, { dir: sandbox.root, env });
    t.after(async () => {
      task.end();
      for (const runtime of listRuntimes(env)) {
        try { await stopRuntime(runtime.muxId, { env }); }
        catch (error) {
          if (!runtime.ownerIdentity || processIdentityStatus(runtime.ownerIdentity) !== "dead"
            || (runtime.piIdentity && processIdentityStatus(runtime.piIdentity) !== "dead")) {
            throw new Error(`Uncertain test cleanup; retained ${sandbox.root}: ${String(error)}`);
          }
        }
      }
      fs.rmSync(artifacts.artifactDir, { recursive: true, force: true });
      fs.rmSync(sandbox.root, { recursive: true, force: true });
    });
    writeWorkerRequest(artifacts, { id: task.parent.taskId, task: "[hold] explicit cancellation", tools: [],
      model: { provider: "orchestration-fixture", id: "one" }, thinkingLevel: "off", resultPolicy: "retrospective",
      resultPath: artifacts.resultPath, statusPath: artifacts.statusPath });
    // The worker reads its leased request at startup.
    if (phase === "invalid-request") {
      const request = JSON.parse(fs.readFileSync(artifacts.requestPath, "utf8"));
      delete request.resultPolicy;
      fs.writeFileSync(artifacts.requestPath, JSON.stringify(request));
    }
    const sessionFile = path.join(sandbox.root, "sessions", `${phase}.jsonl`);
    const trace = path.join(sandbox.root, "lifecycle-trace.jsonl");
    const start = () => startRuntime({ command: PI, cwd: sandbox.root, env, parent: task.parent,
      args: ["--mode", "rpc", "--session", sessionFile,
        "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates",
        "--extension", FAUX, "--extension", FRAME, "--provider", "orchestration-fixture", "--model", "one", "--thinking", "off"] });
    if (phase === "invalid-request") {
      // The worker stops itself while starting, so whether startup reports the
      // runtime first is a race; its exit releases the session claim either way.
      await start().then((receipt) => runtimeIdentity(receipt, env)).catch(() => undefined);
      const exitDeadline = Date.now() + 10_000;
      while (lookupClaim(sessionFile, { testRoot: sandbox.root })) {
        assert.ok(Date.now() < exitDeadline, "an invalid leased request stops the worker at startup");
        await delay(25);
      }
      assert.equal(JSON.parse(fs.readFileSync(task.file, "utf8")).state, "active");
      assert.equal(fs.existsSync(artifacts.resultPath), false);
      assert.doesNotMatch(fs.existsSync(trace) ? fs.readFileSync(trace, "utf8") : "", /"event":"request"/);
      return;
    }
    const receipt = await start();
    const identity = runtimeIdentity(receipt, env);
    const waiter = waitForWorkerResult({ exec: async () => assert.fail("no frontend is needed for task liveness") } as unknown as ExtensionAPI, {
      id: task.parent.taskId, target: { host: "emacs", endpoint: env.PI_ORCHESTRATION_ENDPOINT, id: receipt.muxId,
        kind: "pi", name: "cancel-native", sessionFile, runtime: receipt, process: identity },
      paths: artifacts, sessionFile, task: "[hold] explicit cancellation",
    }).then(() => assert.fail("Cancellation cannot produce successful completion"), (error: unknown) => error);
    if (phase === "active-run") {
      const reply = await runtimeRequest(receipt, { type: "prompt", message: fs.readFileSync(artifacts.promptPath, "utf8") });
      assert.equal(reply.success, true);
      const deadline = Date.now() + 15_000;
      while (!fs.readFileSync(trace, "utf8").includes('"event":"request"')) {
        assert.ok(Date.now() < deadline, "faux inference entered the task"); await delay(25);
      }
    }
    assert.equal(processIdentityStatus(identity), "alive");
    // Shutdown may beat its response. Observe exact exit, never replay input.
    await runtimeRequest(receipt, { type: "prompt", message: "/worker-cancel", streamingBehavior: "steer" }).catch(() => undefined);
    const error = await waiter;
    assert.match(String(error), /exited before writing a final result/);
    assert.equal(processIdentityStatus(identity), "dead");
    assert.equal(JSON.parse(fs.readFileSync(task.file, "utf8")).state, "ended");
    assert.equal(fs.existsSync(artifacts.resultPath), false);
    assert.equal(fs.existsSync(artifacts.retrospectiveMarkdownPath), false);
    if (phase === "active-run") {
      assert.equal(readWorkerStatus(artifacts.statusPath)?.state, "error");
      assert.match(readWorkerStatus(artifacts.statusPath)?.waitingReason ?? "", /cancelled by \/worker-cancel/);
    }
    const activity = fs.readFileSync(trace, "utf8");
    assert.doesNotMatch(activity, /"retrospective":true/);
    const claimDeadline = Date.now() + 5000;
    while (lookupClaim(sessionFile, { testRoot: sandbox.root })) {
      assert.ok(Date.now() < claimDeadline, "the detached owner released its claim after actual Pi exit");
      await delay(25);
    }
    task.end(); // Parent cleanup shares the already-terminal binding.
  });
}
