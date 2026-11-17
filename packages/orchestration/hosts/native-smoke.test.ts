import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { ExtensionAPI, ExecOptions } from "@earendil-works/pi-coding-agent";
import { createClaimTestEnvironment, lookupClaim } from "@phimacs/pimux/ownership";
import { verifyHost } from "@phimacs/pimux/host-identity";
import type { HostTarget } from "../host-types.ts";
import { createHerdrHost } from "./herdr.ts";
import { createTmuxHost } from "./tmux.ts";
import { activatePanel } from "../panel-runtime.ts";

const exec = promisify(execFile);
const fixture = fileURLToPath(new URL("../test/terminal-fixture.ts", import.meta.url));
const PI = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
const native = process.env.PI_NATIVE_HOST_SMOKE;
const pi = {
  async exec(command: string, args: string[], options: ExecOptions = {}) {
    try {
      return { ...await exec(command, args, { timeout: options.timeout, signal: options.signal }), code: 0, killed: false };
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string; code?: number; killed?: boolean };
      return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? failure.message, code: failure.code ?? 1, killed: failure.killed ?? false };
    }
  },
} as unknown as ExtensionAPI;

for (const kind of ["tmux", "herdr"] as const) {
  test(`${kind} native Pi draft, startup prompt, process death and terminal keys`, {
    skip: !(native === "1" || native === kind) || (kind === "herdr" && (process.env.HERDR_ENV !== "1" || !process.env.HERDR_SOCKET_PATH)),
    timeout: 120_000,
  }, async () => {
    const sandbox = createClaimTestEnvironment();
    const dir = sandbox.root;
    const endpoint = kind === "tmux" ? path.join(dir, "tmux.sock") : process.env.HERDR_SOCKET_PATH!;
    const hostIdentity = verifyHost(PI);
    const isolated: Record<string, string> = { ...sandbox.env, HOME: path.join(dir, "home"), TMPDIR: path.join(dir, "tmp"),
      XDG_CONFIG_HOME: path.join(dir, "config"), XDG_DATA_HOME: path.join(dir, "data"), XDG_CACHE_HOME: path.join(dir, "cache"),
      PI_CODING_AGENT_DIR: path.join(dir, "agent"), PIMUX_DIR: path.join(dir, "mux"), PHIMACS_PI: hostIdentity.executable,
      PHIMACS_MANAGED_CLAIM: "",
      PHIMACS_PARENT_TASK: "", PHIMACS_PARENT_TASK_FILE: "", PI_ORCHESTRATION_TARGET: "", PI_ORCHESTRATION_PARENT: "" };
    for (const key of ["HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "PI_CODING_AGENT_DIR", "PIMUX_DIR"]) {
      fs.mkdirSync(isolated[key], { mode: 0o700 });
    }
    const previous = Object.fromEntries(Object.keys(isolated).map((key) => [key, process.env[key]]));
    Object.assign(process.env, isolated);
    let parent: HostTarget | undefined;
    let workspace: string | undefined;
    let tmuxStarted = false;
    const host = kind === "tmux" ? createTmuxHost(pi, endpoint) : createHerdrHost(pi, endpoint);
    const herdr = (args: string[]) => exec("env", [`HERDR_SOCKET_PATH=${endpoint}`, process.env.HERDR_BIN_PATH || "herdr", ...args]);
    const closeShell = async (target: HostTarget): Promise<void> => { await host.close(target); };
    const sessionFile = path.join(sandbox.sessions, "session.jsonl");
    try {
      if (kind === "tmux") {
        await exec("tmux", ["-S", endpoint, "new-session", "-d", "-s", "smoke", "-x", "110", "-y", "35"]);
        tmuxStarted = true;
        const pane = (await exec("tmux", ["-S", endpoint, "display-message", "-p", "-t", "smoke", "#{pane_id}"])).stdout.trim();
        parent = { host: kind, endpoint, id: pane, paneId: pane, name: "parent", kind: "pi" };
      } else {
        // Never split the caller's workspace: every surface belongs to this test.
        const args = ["workspace", "create", "--cwd", dir, "--label", `native-smoke-${randomUUID().slice(0, 8)}`, "--no-focus"];
        for (const [key, value] of Object.entries(isolated)) args.push("--env", `${key}=${value}`);
        const created = JSON.parse((await herdr(args)).stdout).result as { workspace: { workspace_id: string }; root_pane: { pane_id: string } };
        workspace = created.workspace.workspace_id;
        assert.ok(workspace);
        parent = { host: kind, endpoint, id: created.root_pane.pane_id, paneId: created.root_pane.pane_id, name: "parent", kind: "pi" };
      }
      fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd: dir })}\n`, { flag: "wx", mode: 0o600 });
      const report = path.join(dir, "report.json");
      const target = await host.start({ kind: "pi", name: `native-${randomUUID().slice(0, 8)}`, cwd: dir, sessionFile,
        args: ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "-e", fixture],
        env: { ...isolated, PI_NATIVE_REPORT: report }, prompt: "/native-report", placement: "interactive-fork", parent });
      try {
        for (let attempt = 0; attempt < 50 && !fs.existsSync(report); attempt++) await delay(100);
        assert.deepEqual(JSON.parse(fs.readFileSync(report, "utf8")), { draft: "", session: sessionFile });
        assert.deepEqual(lookupClaim(sessionFile, sandbox.options)?.owner.pi, target.process, "native startup owns the exact file before accepting input");
        fs.rmSync(report);
        assert.equal(await host.state(target), "running");
        await host.send(target, { kind: "text", text: "human draft unchanged", enter: false });
        await delay(200);
        await host.send(target, { kind: "prompt", text: "/native-report" });
        for (let attempt = 0; attempt < 50 && !fs.existsSync(report); attempt++) await delay(100);
        assert.deepEqual(JSON.parse(fs.readFileSync(report, "utf8")), { draft: "human draft unchanged", session: sessionFile });
        assert.ok((await host.read(target, 20)).includes("human draft unchanged"));
        await host.send(target, { kind: "prompt", text: "/native-exit" });
        for (let attempt = 0; attempt < 50 && await host.state(target) === "running"; attempt++) await delay(100);
        assert.notEqual(await host.state(target), "running");
      } finally { await host.close(target); }

      const shell = await host.start({ kind: "shell", name: `shell-${randomUUID().slice(0, 8)}`, cwd: dir,
        argv: ["/bin/sh", "-c", 'printf "NATIVE_READY\\n"; /bin/cat'], env: isolated, placement: "worker", parent });
      try {
        await activatePanel(shell.panel!);
        for (let attempt = 0; attempt < 30; attempt++) {
          if ((await host.read(shell, 30)).includes("NATIVE_READY")) break;
          await delay(100);
        }
        await host.send(shell, { kind: "text", text: "Enter literal text", enter: true });
        await delay(200);
        assert.ok((await host.read(shell, 30)).includes("Enter literal text"));
        await host.send(shell, { kind: "keys", keys: ["ctrl+c"] });
      } finally { await closeShell(shell); }

      const instant = await host.start({ kind: "shell", name: `instant-${randomUUID().slice(0, 8)}`, cwd: dir,
        argv: ["/bin/bash", "-c", 'false | true; printf "INSTANT_OUTPUT %s\\n" "${PIPESTATUS[0]}"'], env: isolated, placement: "worker", parent });
      try {
        await activatePanel(instant.panel!);
        const exitedBy = Date.now() + 5000;
        while (await host.state(instant) === "running") {
          assert.ok(Date.now() < exitedBy, "the released instant command exits");
          await delay(25);
        }
        assert.ok((await host.read(instant, 80)).includes("INSTANT_OUTPUT 1"), "argv runs verbatim in bash");
        assert.notEqual(await host.state(instant), "running");
      } finally { await closeShell(instant); }
    } finally {
      try {
        if (tmuxStarted) await exec("tmux", ["-S", endpoint, "kill-server"]);
        if (workspace) await herdr(["workspace", "close", workspace]);
        const deadline = Date.now() + 5000;
        while (lookupClaim(sessionFile, sandbox.options)) {
          assert.ok(Date.now() < deadline, `test-owned native writer did not exit; retained namespace ${dir}`);
          await delay(25);
        }
        fs.rmSync(dir, { recursive: true, force: true });
      } finally {
        for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      }
    }
  });
}
