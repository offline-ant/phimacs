import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import type { ExtensionAPI, ExecOptions } from "@earendil-works/pi-coding-agent";
import { createClaimTestEnvironment } from "@phimacs/pimux/ownership";
import { LineSplitter } from "@phimacs/pimux/jsonl";
import { processIdentityStatus } from "@phimacs/pimux/process-identity";
import { listRuntimes, stopRuntime } from "@phimacs/pimux/runtime";
import { startTestService } from "../../pimux/test/harness.ts";
import type { HostTarget } from "../host-types.ts";
import { createParentTask, parentTaskEnvironment } from "../parent-task.ts";
import { createWorkerArtifacts, writeWorkerRequest } from "../worker-frame.ts";
import { waitForWorkerResult } from "../workers.ts";
import { createEmacsHost, emacsOperation } from "./emacs.ts";

const execute = promisify(execFile);
const enabled = process.env.PI_CONTEXTUAL_NATIVE === "1";
const inputs = {
  pilish: fileURLToPath(new URL("../../../emacs/pilish", import.meta.url)),
  emacs: process.env.PHIMACS_TEST_EMACS_DIR,
};
const PI = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
const PIMUX = fileURLToPath(new URL("../bin/pimux", import.meta.resolve("@phimacs/pimux/runtime")));
const FRAME = fileURLToPath(import.meta.resolve("@phimacs/orchestration/worker-frame"));
const FORK_HERE = fileURLToPath(import.meta.resolve("@phimacs/orchestration/fork-here"));
const FAUX = fileURLToPath(new URL("../test/lifecycle-fixture.ts", import.meta.url));
const EMACS_FIXTURE = fileURLToPath(new URL("../test/contextual-native.el", import.meta.url));
const COMPANION = fileURLToPath(new URL("../emacs", import.meta.url));

async function until(predicate: () => boolean | Promise<boolean>, label: string, timeout = 20_000): Promise<void> {
  const deadline = performance.now() + timeout;
  while (!await predicate()) {
    assert.ok(performance.now() < deadline, label);
    await delay(25);
  }
}

const kind = "emacs";
test(`${kind}: contextual workers survive view loss, cancel with their task, and forks recover saved history`, {
    skip: enabled ? false : "Set PI_CONTEXTUAL_NATIVE=1 and PHIMACS_TEST_EMACS_DIR; skipped is not native evidence",
    timeout: 150_000,
  }, async t => {
    assert.ok(inputs.pilish && path.isAbsolute(inputs.pilish) && fs.existsSync(path.join(inputs.pilish, "pilish.el")));
    assert.ok(inputs.emacs && path.isAbsolute(inputs.emacs) && fs.existsSync(path.join(inputs.emacs, "elpa")));
    const sandbox = createClaimTestEnvironment();
    const env: Record<string, string> = Object.fromEntries(["PATH", "LANG", "LC_ALL", "SHELL", "TERM"].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
    Object.assign(env, sandbox.env, {
      HOME: path.join(sandbox.root, "home"), TMPDIR: path.join(sandbox.root, "tmp"),
      XDG_CONFIG_HOME: path.join(sandbox.root, "config"), XDG_CACHE_HOME: path.join(sandbox.root, "cache"),
      XDG_DATA_HOME: path.join(sandbox.root, "data"), XDG_RUNTIME_DIR: path.join(sandbox.root, "runtime"),
      PHIMACS_STATE_DIR: path.join(sandbox.root, "state"),
      PI_CODING_AGENT_DIR: path.join(sandbox.root, "agent"), PI_CODING_AGENT_SESSION_DIR: sandbox.sessions,
      PHIMACS_PI: PI, GDK_BACKEND: "x11", WAYLAND_DISPLAY: "",
      // An absent private bus: GTK on the owned display autolaunches nothing.
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(sandbox.root, "runtime/no-session-bus")}`,
      PI_CONTEXTUAL_PILISH: inputs.pilish, PHIMACS_TEST_EMACS_DIR: inputs.emacs,
      PI_CONTEXTUAL_ORCHESTRATION: COMPANION, PI_CONTEXTUAL_PIMUX: PIMUX,
    });
    for (const key of ["HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "PI_CODING_AGENT_DIR"]) fs.mkdirSync(env[key]!, { mode: 0o700 });
    fs.writeFileSync(path.join(env.PI_CODING_AGENT_DIR!, "settings.json"), JSON.stringify({
      packages: [], extensions: [FAUX], retry: { enabled: false }, compaction: { enabled: false },
    }), { mode: 0o600 });
    const previousTmp = process.env.TMPDIR;
    process.env.TMPDIR = env.TMPDIR;
    const tasks: ReturnType<typeof createParentTask>[] = [];
    const artifacts: ReturnType<typeof createWorkerArtifacts>[] = [];
    let frontend: ChildProcess | undefined;
    let display: ChildProcess | undefined;
    let logs = "";
    await startTestService(t, { dir: sandbox.root, env });
    t.after(async () => {
      for (const task of tasks) task.end();
      for (const runtime of listRuntimes(env)) {
        try { await stopRuntime(runtime.muxId, { env }); }
        catch (error) {
          assert.equal(runtime.piIdentity && processIdentityStatus(runtime.piIdentity), "dead", `Retained namespace ${sandbox.root}: ${String(error)}`);
        }
      }
      for (const child of [frontend, display]) {
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
          await until(() => child.exitCode !== null || child.signalCode !== null, "test-owned frontend/display exits");
        }
      }
      for (const item of artifacts) fs.rmSync(item.artifactDir, { recursive: true, force: true });
      fs.rmSync(sandbox.root, { recursive: true, force: true });
      if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp;
    });
    const exec: ExtensionAPI["exec"] = async (command: string, args: string[], options: ExecOptions = {}) => {
      try { return { ...await execute(command, args, { env, cwd: sandbox.root, timeout: options.timeout, signal: options.signal }), code: 0, truncated: false, killed: false }; }
      catch (error) {
        const failure = error as Error & { stdout?: string; stderr?: string; code?: number | string; killed?: boolean };
        return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? failure.message, code: typeof failure.code === "number" ? failure.code : 1, truncated: failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: failure.killed === true };
      }
    };
    const pi = { exec } as unknown as ExtensionAPI;
    display = spawn(process.env.PHIMACS_TEST_XVFB || "Xvfb", ["-displayfd", "1", "-screen", "0", "1024x768x24", "-nolisten", "tcp"], {
      env, stdio: ["ignore", "pipe", "pipe"],
    });
    display.stderr!.on("data", (chunk: Buffer) => { logs += chunk.toString(); });
    const displayLines = createInterface({ input: display.stdout! });
    const [displayNumber] = await once(displayLines, "line", { signal: AbortSignal.timeout(5000) });
    displayLines.close();
    assert.match(String(displayNumber), /^\d+$/, logs);
    env.DISPLAY = `:${displayNumber}`;
    const endpoint = path.join(sandbox.root, "emacs.sock");
    frontend = spawn("emacs", ["-Q", `--fg-daemon=${endpoint}`, "--load", EMACS_FIXTURE,
      "--eval", '(make-frame-on-display (getenv "DISPLAY") \'((visibility . nil)))'], { env, cwd: sandbox.root, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [frontend.stdout, frontend.stderr]) stream?.on("data", (chunk: Buffer) => { logs = (logs + chunk.toString()).slice(-128 * 1024); });
    await until(async () => {
      assert.equal(frontend!.exitCode, null, logs);
      if (!fs.existsSync(endpoint)) return false;
      try { return (await emacsOperation(exec, endpoint, { operation: "state", id: "readiness-probe" })).state === "missing"; }
      catch { return false; }
    }, "candidate frontend ready", 45_000).catch((error: unknown) => { t.diagnostic(logs); throw error; });
    const host = createEmacsHost(pi, endpoint);
    async function detach(target: HostTarget): Promise<void> {
      await emacsOperation(exec, endpoint, { operation: "close", id: target.id, muxId: target.runtime!.muxId, detachOnly: true });
    }
    const args = ["--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--extension", FAUX,
      "--provider", "orchestration-fixture", "--model", "one", "--thinking", "off"];
    const trace = (): string => fs.existsSync(path.join(sandbox.root, "lifecycle-trace.jsonl")) ? fs.readFileSync(path.join(sandbox.root, "lifecycle-trace.jsonl"), "utf8") : "";
    async function worker(label: string) {
      const files = createWorkerArtifacts(); artifacts.push(files);
      const lease = createParentTask(files.artifactDir, label); tasks.push(lease);
      writeWorkerRequest(files, { id: lease.parent.taskId, task: `[hold] ${label}`, tools: [],
        model: { provider: "orchestration-fixture", id: "one" }, thinkingLevel: "off", resultPolicy: "retrospective", resultPath: files.resultPath, statusPath: files.statusPath });
      const sessionFile = path.join(sandbox.sessions, `${label}.jsonl`);
      const target = await host.start({ kind: "pi", name: label, cwd: sandbox.root, sessionFile, placement: "worker",
        args: [...args, "--extension", FRAME], env: { ...env, ...parentTaskEnvironment(lease) }, prompt: fs.readFileSync(files.promptPath, "utf8") }, AbortSignal.timeout(45_000));
      await until(() => trace().split("\n").filter(Boolean).some(line => {
        const record = JSON.parse(line) as { event?: string; prompt?: string };
        return record.event === "request" && record.prompt?.endsWith(`[hold] ${label}`);
      }), "accepted worker command enters faux inference");
      return { target, files, lease, sessionFile };
    }
    const completed = await worker(`${kind}-complete`);
    await detach(completed.target);
    assert.equal(await host.state(completed.target), "running");
    fs.writeFileSync(path.join(sandbox.root, "release"), "continue authorized task");
    const result = await waitForWorkerResult(pi, { id: completed.lease.parent.taskId, task: "held", target: completed.target,
      paths: completed.files, sessionFile: completed.sessionFile, signal: AbortSignal.timeout(30_000) });
    assert.equal(result.result.result, `fixture result: [hold] ${kind}-complete`);
    assert.equal(result.result.retrospective, "fixture retrospective");
    completed.lease.end(); await host.close(completed.target);
    fs.rmSync(path.join(sandbox.root, "release"));
    const cancelled = await worker(`${kind}-cancel`);
    await detach(cancelled.target);
    cancelled.lease.end();
    await until(() => processIdentityStatus(cancelled.target.process!) === "dead", "parent task cancellation stops detached worker");
    assert.equal(fs.existsSync(cancelled.files.resultPath), false);
    await host.close(cancelled.target);

    const sessionFile = path.join(sandbox.sessions, `${kind}-fork.jsonl`);
    const spec = { kind: "pi" as const, name: `${kind}-fork`, cwd: sandbox.root, sessionFile, placement: "interactive-fork" as const, args, env };
    let fork = await host.start(spec, AbortSignal.timeout(45_000));
    const original = fork.runtime!;
    assert.equal((await host.read(fork)).includes("fixture result:"), false, "idle fork submits no work");
    await host.send(fork, { kind: "prompt", text: "first interactive prompt" });
    await until(async () => (await host.read(fork)).includes("fixture result: first interactive prompt"), "interactive answer");
    await detach(fork);
    fork = await host.start({ ...spec, runtime: original }, AbortSignal.timeout(45_000));
    assert.equal(fork.runtime!.muxId, original.muxId);
    await host.send(fork, { kind: "prompt", text: "reattached prompt" });
    await until(async () => (await host.read(fork)).includes("fixture result: reattached prompt"), "reattached answer");
    await host.close(fork);
    assert.equal(processIdentityStatus(fork.process!), "dead");
    fork = await host.start(spec, AbortSignal.timeout(45_000));
    assert.notEqual(fork.runtime!.muxId, original.muxId);
    assert.ok((await host.read(fork)).includes("first interactive prompt"), "explicit saved-session recovery preserves history");
    await host.send(fork, { kind: "prompt", text: "saved recovery prompt" });
    await until(async () => (await host.read(fork)).includes("fixture result: saved recovery prompt"), "saved recovery answer");
    await host.close(fork);
    assert.equal(processIdentityStatus(fork.process!), "dead");
    // Exercise the public command too, not just the host's fork placement.
    const owner = await host.start({ ...spec, name: `${kind}-public-owner`, args: [...args, "--extension", FORK_HERE],
      env: { ...env, PI_ORCHESTRATION_HOST: kind, PI_ORCHESTRATION_ENDPOINT: endpoint } }, AbortSignal.timeout(45_000));
    const observer = net.connect(owner.runtime!.socket);
    const notices: string[] = [];
    const observerLines = new LineSplitter(line => {
      const record = JSON.parse(line) as { type?: string; method?: string; message?: string };
      if (record.type === "extension_ui_request" && record.method === "notify") notices.push(record.message ?? "");
    }, 128 * 1024 * 1024, () => {});
    observer.on("data", (chunk: Buffer) => observerLines.push(chunk));
    observer.on("error", () => {});
    t.after(() => observer.destroy());
    const names = [`${kind}-public-idle`, `${kind}-public-prompted`];
    for (const [index, name] of names.entries()) {
      await host.send(owner, { kind: "prompt", text: `/fork-here ${name}${index ? " -- public fork prompt" : ""}` });
      // The parent's worker module was imported before this sandbox's TMPDIR
      // was set. Inspect only the child process's explicit test registry.
      const registered = path.join(env.TMPDIR!, "pi-orchestration-targets", `${name}.json`);
      await until(() => fs.existsSync(registered), "public fork command registers its target").catch(error => {
        t.diagnostic(`Public fork notices: ${JSON.stringify(notices)}; frontend: ${logs}`);
        for (const folder of ["logs", "operations"]) {
          const directory = path.join(env.PIMUX_DIR!, folder);
          for (const file of fs.readdirSync(directory)) t.diagnostic(`${folder}/${file}: ${fs.readFileSync(path.join(directory, file), "utf8").slice(-4000)}`);
        }
        throw error;
      });
      const child = (JSON.parse(fs.readFileSync(registered, "utf8")) as { target: HostTarget }).target;
      assert.equal(child.host, kind);
      assert.notEqual(child.runtime!.muxId, owner.runtime!.muxId);
      if (index) await until(async () => (await host.read(child)).includes("fixture result: public fork prompt"), "public prompted fork answer");
      else assert.equal((await host.read(child)).includes("fixture result: public fork prompt"), false);
      await host.close(child);
      fs.rmSync(registered);
    }
    observer.destroy();
    await host.close(owner);
    t.diagnostic("Passed real frontend attach, acknowledged contextual worker start, view-independent completion, parent cancellation, idle fork, reattach, saved recovery, public /fork-here idle/prompted commands and explicit stop.");
});
