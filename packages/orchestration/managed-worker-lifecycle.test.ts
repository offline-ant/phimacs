import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createClaimTestEnvironment, lookupClaim } from "@phimacs/pimux/ownership";
import { listRuntimes, stopRuntime } from "@phimacs/pimux/runtime";
import { processIdentityStatus } from "@phimacs/pimux/process-identity";
import { createWorkerArtifacts, writeWorkerRequest } from "./worker-frame.ts";
import { runEphemeralWorker, readTarget, removeTarget, claimName } from "./workers.ts";
import { readWorkerTask } from "./worker-task.ts";
import { startTestService } from "../pimux/test/harness.ts";

const PI = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
const FRAME = fileURLToPath(import.meta.resolve("@phimacs/orchestration/worker-frame"));
const FAUX = fileURLToPath(new URL("./test/lifecycle-fixture.ts", import.meta.url));

for (const outcome of ["result", "cancel", "cleanup-error"] as const) {
  test(`real detached worker survives frontend loss and ends through its parent task: ${outcome}`, { timeout: 30_000 }, async (t) => {
    const fixture = createClaimTestEnvironment();
    const root = fixture.root;
    const temporary = path.join(root, "tmp");
    const home = path.join(root, "home");
    const agent = path.join(root, "agent");
    const mux = path.join(root, "mux");
    const state = path.join(root, "state");
    for (const directory of [temporary, home, agent, mux, state]) fs.mkdirSync(directory, { mode: 0o700 });
    const changes: NodeJS.ProcessEnv = { ...fixture.env, TMPDIR: temporary, HOME: home, PI_CODING_AGENT_DIR: agent, PIMUX_DIR: mux, PHIMACS_STATE_DIR: state,
      PHIMACS_PI: PI, PHIMACS_MANAGED_CLAIM: "", PHIMACS_PARENT_TASK: "", PHIMACS_PARENT_TASK_FILE: "",
      PI_ORCHESTRATION_HOST: "emacs", PI_ORCHESTRATION_ENDPOINT: path.join(root, "fake-emacs.sock"), PI_ORCHESTRATION_TARGET: "parent" };
    const frontend = outcome === "cleanup-error" ? net.createServer(client => client.destroy()) : undefined;
    if (frontend) await new Promise<void>(resolve => frontend.listen(changes.PI_ORCHESTRATION_ENDPOINT!, resolve));
    const previous = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]]));
    Object.assign(process.env, changes);
    const hostKey = Symbol.for("pi-ant.orchestration.host");
    const previousHost = Reflect.get(globalThis, hostKey);
    Reflect.deleteProperty(globalThis, hostKey);
    const abort = new AbortController();
    const name = `managed-${outcome}-${process.pid}`;
    let detached = false;
    let uiCallsAfterDetach = 0;
    let ownedId: string | undefined;
    let taskAcknowledged = false;
    let taskAcknowledgementError: unknown;
    let service: ChildProcess | undefined;
    t.after(async () => {
      abort.abort();
      for (const item of listRuntimes(process.env)) await stopRuntime(item.muxId, { env: process.env }).catch(() => undefined);
      removeTarget(name);
      if (frontend) await new Promise<void>(resolve => frontend.close(() => resolve()));
      // The owned service outlives its runtimes' stop and ends before its state is removed.
      if (service && service.exitCode === null && service.signalCode === null) {
        const exited = once(service, "exit");
        service.kill("SIGTERM");
        await exited;
      }
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      if (previousHost === undefined) Reflect.deleteProperty(globalThis, hostKey);
      else Reflect.set(globalThis, hostKey, previousHost);
      fs.rmSync(root, { recursive: true, force: true });
    });
    const pi = { exec: async (_command: string, args: string[]) => {
      const expression = args.at(-1)!;
      const encoded = /pi-orchestration-dispatch "([A-Za-z0-9+/=]+)"/.exec(expression)?.[1];
      assert.ok(encoded);
      const input = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
      let response: object;
      if (input.operation === "task-finished") {
        taskAcknowledged = true;
        try {
          assert.equal(input.muxId, ownedId);
          if (outcome === "cleanup-error") {
            assert.match(input.error, /live native cleanup failure/);
            assert.equal(readWorkerTask(ownedId!, process.env)?.state, "failed");
            assert.match(readWorkerTask(ownedId!, process.env)?.error ?? "", /live native cleanup failure/);
            assert.ok(readTarget(name), "failed native cleanup retains its target");
          } else {
            assert.equal(input.error, undefined);
            assert.equal(readWorkerTask(ownedId!, process.env)?.state, "complete", "equal-client evidence precedes frontend notification");
            assert.equal(readTarget(name), undefined, "registry cleanup precedes acknowledgement");
          }
          claimName(name)();
          assert.equal(listRuntimes(process.env).length, 0, "actual exit precedes task acknowledgement");
        } catch (error) { taskAcknowledgementError = error; }
        response = { success: true };
      } else if (input.operation === "start") {
        ownedId = input.spec.runtime.muxId;
        response = { target: { id: input.id }, muxId: ownedId };
      } else if (input.operation === "state" && !detached) {
        response = { ready: true, state: "running", muxId: ownedId };
        detached = true;
      } else if (input.operation === "close" && outcome === "cleanup-error") {
        uiCallsAfterDetach++;
        response = { error: "live native cleanup failure" };
      } else { uiCallsAfterDetach++; throw new Error("Disposable frontend disconnected"); }
      return { code: 0, stdout: JSON.stringify(Buffer.from(JSON.stringify(response)).toString("base64")), stderr: "", killed: false };
    } } as unknown as ExtensionAPI;
    // Runtime starts go through the running service; this fixture owns one.
    service = await startTestService(t, { dir: root, env: { ...process.env } });
    const artifacts = createWorkerArtifacts();
    writeWorkerRequest(artifacts, { id: name, task: "[hold] managed lifecycle", tools: [], model: { provider: "orchestration-fixture", id: "one" },
      thinkingLevel: "off", resultPolicy: "retrospective", resultPath: artifacts.resultPath, statusPath: artifacts.statusPath });
    const sessionFile = path.join(root, "sessions", `${outcome}.jsonl`);
    const work = runEphemeralWorker(pi, { id: name, name, cwd: root, sessionFile, paths: artifacts, task: "[hold] managed lifecycle",
      args: ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--extension", FAUX, "--extension", FRAME,
        "--provider", "orchestration-fixture", "--model", "one", "--thinking", "off"], signal: abort.signal });
    // Observe the real faux request, not just a listening socket/start response.
    const observed = work.then((result) => ({ result }), (error: unknown) => ({ error }));
    const deadline = Date.now() + 15_000;
    const trace = path.join(root, "lifecycle-trace.jsonl");
    while (!readTarget(name) || !fs.existsSync(trace) || !fs.readFileSync(trace, "utf8").includes('"event":"request"')) {
      const early = await Promise.race([observed, delay(25).then(() => undefined)]);
      if (early) assert.fail(`Worker settled before faux request: ${"error" in early ? String(early.error) : JSON.stringify(early)}`);
      assert.ok(Date.now() < deadline, "faux request reached its owned task");
    }
    const owned = lookupClaim(sessionFile);
    assert.ok(owned?.owner.pi);
    assert.equal(processIdentityStatus(owned.owner.pi), "alive");
    assert.equal(owned.owner.id, ownedId);
    assert.equal(detached, true);
    const task = readWorkerTask(ownedId!, process.env);
    assert.equal(task?.state, "pending", "runtime exit alone cannot finish the parent task");
    assert.equal(task?.parent.taskId, name);
    assert.deepEqual(task?.worker, owned.owner.pi);
    if (outcome !== "cancel") fs.writeFileSync(path.join(root, "release"), "continue");
    else abort.abort();
    const settled = await observed;
    if (outcome !== "cancel") {
      assert.ok("result" in settled, JSON.stringify(settled));
      assert.match(settled.result.result.result, /fixture result: \[hold\] managed lifecycle/);
      assert.equal(settled.result.result.retrospective, "fixture retrospective");
      if (outcome === "cleanup-error") assert.match(settled.result.result.result, /live native cleanup failure/);
    } else { assert.ok("error" in settled); assert.match(String(settled.error), /abort/i); }
    assert.equal(processIdentityStatus(owned.owner.pi), "dead");
    assert.equal(lookupClaim(sessionFile), undefined);
    assert.equal(JSON.parse(fs.readFileSync(path.join(artifacts.artifactDir, "parent-task.json"), "utf8")).state, "ended");
    if (outcome !== "cleanup-error") assert.equal(readTarget(name), undefined);
    assert.ok(uiCallsAfterDetach >= 1, "UI cleanup is best effort after authoritative runtime cleanup");
    assert.equal(taskAcknowledged, true, "Close observes final task cleanup, not dispatch acceptance");
    if (taskAcknowledgementError) throw taskAcknowledgementError;
  });
}
