import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { processIdentityStatus, readProcessIdentity } from "@phimacs/pimux/process-identity";
import { once } from "node:events";
import { activatePanel, closePanel, PANEL_RUNTIME, createPanelBinding } from "../panel-runtime.ts";
import type { HostTarget } from "../host-types.ts";
import { createTmuxHost } from "./tmux.ts";
import { createHerdrHost } from "./herdr.ts";
import { pinNativeSocket, validateNativeSocket } from "./native-surface.ts";

const execute = promisify(execFile);
const api: Pick<ExtensionAPI, "exec"> = { async exec(command, args, options) {
  try { const response = await execute(command, args, options); return { stdout: response.stdout.toString(), stderr: response.stderr.toString(), code: 0, truncated: false, killed: false }; }
  catch (error) {
    const failure = error as Error & { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? failure.message, code: typeof failure.code === "number" ? failure.code : 1, truncated: failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: failure.killed === true };
  }
} };
async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!await predicate()) { assert.ok(Date.now() < deadline); await delay(10); }
}
async function tmuxFixture(): Promise<{ root: string; endpoint: string; parent: HostTarget; stop(): Promise<void> }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "panel-native-tmux-"));
  const endpoint = path.join(root, "server.sock");
  await execute("tmux", ["-S", endpoint, "-f", "/dev/null", "new-session", "-d", "-s", "fixture", "/bin/sh", "-c", "read value"]);
  const id = (await execute("tmux", ["-S", endpoint, "display-message", "-p", "#{pane_id}"])).stdout.trim();
  return { root, endpoint, parent: { host: "tmux", endpoint, id, name: "parent", kind: "pi" },
    stop: async () => { await execute("tmux", ["-S", endpoint, "kill-server"]).catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); } };
}

test("real tmux preserves finished panel identity/output and ordinary Close removes only its surface", async () => {
  const fixture = await tmuxFixture();
  const host = createTmuxHost(api, fixture.endpoint);
  let target: HostTarget | undefined;
  try {
    target = await host.start({ kind: "shell", name: "finished", cwd: fixture.root, argv: ["/bin/sh", "-c", "printf FINISHED"], placement: "worker", parent: fixture.parent });
    assert.equal(await host.state(target), "running");
    assert.equal(await host.read(target), "", "command remains held before owning activation");
    await activatePanel(target.panel!);
    await until(async () => await host.state(target!) === "exited");
    assert.match(await host.read(target), /FINISHED/);
    assert.equal(processIdentityStatus(target.panel!.process!), "alive");
    await host.close(target);
    assert.equal(processIdentityStatus(target.panel!.process!), "dead");
    const panes = (await execute("tmux", ["-S", fixture.endpoint, "list-panes", "-a", "-F", "#{pane_id}"])).stdout;
    assert.ok(!panes.split("\n").includes(target.id));
    assert.ok(panes.split("\n").includes(fixture.parent.id));
  } finally { if (target?.panel) { await closePanel(target.panel); fs.rmSync(target.panel.directory, { recursive: true, force: true }); } await fixture.stop(); }
});

test("real tmux creator death before activation cannot orphan unregistered commands", async () => {
  const fixture = await tmuxFixture();
  const creator = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
  await once(creator, "spawn");
  const host = createTmuxHost(api, fixture.endpoint, { ...PANEL_RUNTIME,
    create: options => createPanelBinding({ ...options, creator: readProcessIdentity(creator.pid!)! }) });
  let target: HostTarget | undefined;
  try {
    target = await host.start({ kind: "shell", name: "held", cwd: fixture.root, argv: ["/bin/sh", "-c", "touch MUST-NOT-RUN"], placement: "worker", parent: fixture.parent });
    const exited = once(creator, "close"); creator.kill(); await exited;
    await until(() => processIdentityStatus(target!.panel!.process!) === "dead");
    assert.equal(fs.existsSync(path.join(fixture.root, "MUST-NOT-RUN")), false);
    await host.close(target);
    assert.ok(!(await execute("tmux", ["-S", fixture.endpoint, "list-panes", "-a", "-F", "#{pane_id}"])).stdout.split("\n").includes(target.id));
  } finally {
    if (target?.panel) { await closePanel(target.panel); fs.rmSync(target.panel.directory, { recursive: true, force: true }); }
    if (creator.exitCode === null && creator.signalCode === null) { const exited = once(creator, "close"); creator.kill(); await exited; }
    await fixture.stop();
  }
});

test("replacing/respawning tmux surfaces never retargets text, keys or Close to the replacement", async () => {
  const fixture = await tmuxFixture();
  const host = createTmuxHost(api, fixture.endpoint);
  let target: HostTarget | undefined;
  try {
    target = await host.start({ kind: "shell", name: "original", cwd: fixture.root, argv: ["/bin/sh", "-c", "printf READY; read value"], placement: "worker", parent: fixture.parent });
    await activatePanel(target.panel!);
    await until(async () => (await host.read(target!)).includes("READY"));
    await execute("tmux", ["-S", fixture.endpoint, "respawn-pane", "-k", "-t", target.id, "/bin/sh", "-c", "read value; touch REPLACEMENT-WAS-MUTATED"]);
    await until(() => processIdentityStatus(target!.panel!.process!) === "dead");
    await assert.rejects(host.send(target, { kind: "text", text: "wrong", enter: true }));
    await assert.rejects(host.send(target, { kind: "keys", keys: ["ctrl+c"] }));
    await assert.rejects(host.close(target), /uncertain|cleanup/);
    assert.equal(fs.existsSync(path.join(fixture.root, "REPLACEMENT-WAS-MUTATED")), false);
    assert.ok((await execute("tmux", ["-S", fixture.endpoint, "list-panes", "-a", "-F", "#{pane_id}"])).stdout.split("\n").includes(target.id));
  } finally { if (target?.panel) { await closePanel(target.panel).catch(() => {}); fs.rmSync(target.panel.directory, { recursive: true, force: true }); } await fixture.stop(); }
});

test("replaced tmux server socket and reused pane IDs cannot receive old control input or closure", async () => {
  const fixture = await tmuxFixture();
  const host = createTmuxHost(api, fixture.endpoint);
  let target: HostTarget | undefined;
  try {
    target = await host.start({ kind: "shell", name: "old", cwd: fixture.root, argv: ["/bin/cat"], placement: "worker", parent: fixture.parent });
    await activatePanel(target.panel!);
    await execute("tmux", ["-S", fixture.endpoint, "kill-server"]);
    await until(() => processIdentityStatus(target!.panel!.process!) === "dead");
    await execute("tmux", ["-S", fixture.endpoint, "-f", "/dev/null", "new-session", "-d", "-s", "replacement", "/bin/sh", "-c", "read value"]);
    await execute("tmux", ["-S", fixture.endpoint, "new-window", "-d", "-t", "replacement", "/bin/sh", "-c", "read value"]);
    await assert.rejects(host.send(target, { kind: "text", text: "never", enter: true }));
    await assert.rejects(host.close(target), /uncertain|cleanup/);
    assert.ok((await execute("tmux", ["-S", fixture.endpoint, "list-panes", "-a", "-F", "#{pane_id}"])).stdout.split("\n").includes(target.id));
  } finally { if (target?.panel) { await closePanel(target.panel).catch(() => {}); fs.rmSync(target.panel.directory, { recursive: true, force: true }); } await fixture.stop(); }
});

test("Herdr allocates wrapper argv atomically; finished commands retain identity and Close uses native process exit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "panel-native-herdr-"));
  const endpoint = path.join(root, "server.sock");
  const methods: string[] = [];
  let child: ChildProcess | undefined;
  let removed = false;
  const server = net.createServer(socket => {
    let bytes = "";
    socket.on("data", chunk => {
      bytes += chunk;
      if (!bytes.includes("\n")) return;
      const request = JSON.parse(bytes) as { id: string; method: string; params: Record<string, unknown> };
      methods.push(request.method);
      let result: object;
      if (request.method === "layout.apply") {
        const leaf = request.params.root as { type: string; command: string[] };
        assert.equal(leaf.type, "pane");
        assert.match(leaf.command[1], /panel-runtime-owner\.js$/);
        child = spawn(leaf.command[0], leaf.command.slice(1), { stdio: "ignore" });
        child.once("close", () => { removed = true; });
        result = { layout: { root: { type: "pane", pane_id: "w1:p2" } } };
      } else if (request.method === "pane.get") result = { pane: request.params.pane_id === "w1:p1" ? { workspace_id: "w1" } : { pane_id: "w1:p2", terminal_id: "exact-terminal" } };
      else if (request.method === "pane.process_info") result = { process_info: { shell_pid: child!.pid } };
      else throw new Error(`Unexpected native mutation ${request.method}`);
      socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
    });
  });
  await new Promise<void>(resolve => server.listen(endpoint, resolve));
  const host = createHerdrHost({ exec: async () => { throw new Error("No reusable-alias CLI mutations permitted"); } }, endpoint);
  let target: HostTarget | undefined;
  try {
    target = await host.start({ kind: "shell", name: "complete", cwd: root, argv: ["/bin/sh", "-c", "printf HERDR_FINISHED"], placement: "worker", parent: { host: "herdr", endpoint, id: "w1:p1", name: "parent", kind: "pi" } });
    assert.equal(fs.existsSync(path.join(target.panel!.directory, "output.log")), false);
    await activatePanel(target.panel!);
    await until(async () => await host.state(target!) === "exited");
    assert.match(await host.read(target), /HERDR_FINISHED/);
    await host.close(target);
    await until(() => removed);
    assert.deepEqual(methods, ["pane.get", "layout.apply", "pane.get", "pane.process_info"]);
  } finally {
    if (target?.panel) { await closePanel(target.panel); fs.rmSync(target.panel.directory, { recursive: true, force: true }); }
    await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true });
  }
});

test("tampered native socket pins fail before mutating a replacement", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "panel-pin-"));
  const endpoint = path.join(root, "server.sock");
  const owned = path.join(root, "owned"); fs.mkdirSync(owned, { mode: 0o700 });
  const server = net.createServer(socket => socket.destroy());
  await new Promise<void>(resolve => server.listen(endpoint, resolve));
  try {
    const pin = pinNativeSocket(endpoint, owned);
    fs.unlinkSync(pin.path); fs.symlinkSync(endpoint, pin.path);
    assert.throws(() => validateNativeSocket(pin), /identity changed/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); }
});
