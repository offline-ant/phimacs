import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { channel } from "node:diagnostics_channel";
import { Worker } from "node:worker_threads";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { readProcessIdentity, processIdentityStatus } from "@phimacs/pimux/process-identity";
import { createPanelBinding, panelWrapperArgv, waitPanelReady, activatePanel, sendPanel, panelStatus, closePanel, rollbackPanel, readPanelConfig, type PanelBinding } from "./panel-runtime.ts";
import { panelKeyBytes } from "./panel-runtime-owner.ts";

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!await predicate()) { assert.ok(Date.now() < deadline, "event arrived before deadline"); await delay(10); }
}
async function launch(argv: string[], creator = readProcessIdentity(process.pid)!): Promise<{ binding: PanelBinding; child: ChildProcess }> {
  const original = createPanelBinding({ argv, cwd: "/tmp", creator });
  const args = panelWrapperArgv(original);
  const child = spawn(args[0], args.slice(1), { stdio: "ignore" });
  return { binding: await waitPanelReady(original), child };
}
async function cleanup(binding: PanelBinding, child: ChildProcess): Promise<void> {
  try { await closePanel(binding); }
  finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "close"); child.kill(); await exited; }
    fs.rmSync(binding.directory, { recursive: true, force: true });
  }
}

test("persistent shell wrapper holds argv, owns a PTY, reports command exit, and closes finished output", async () => {
  const { binding, child } = await launch(["/bin/sh", "-c", "printf READY; read value; printf 'VALUE:%s\\n' \"$value\""]);
  try {
    assert.equal((await panelStatus(binding)).command, "held");
    assert.equal(fs.existsSync(readPanelConfig(binding).outputPath), false);
    await activatePanel(binding);
    const log = readPanelConfig(binding).outputPath;
    await until(() => fs.existsSync(log) && fs.readFileSync(log, "utf8").includes("READY"));
    await sendPanel(binding, { kind: "text", text: "literal Enter ctrl+c", enter: true });
    await until(async () => (await panelStatus(binding)).command === "exited");
    assert.match(fs.readFileSync(log, "utf8"), /VALUE:literal Enter ctrl\+c/);
    assert.equal(processIdentityStatus(binding.process!), "alive", "finished command keeps exact wrapper identity");
    await assert.rejects(sendPanel(binding, { kind: "text", text: "never sent", enter: true }), /exited/);
    await closePanel(binding);
    assert.equal(processIdentityStatus(binding.process!), "dead");
  } finally { await cleanup(binding, child); }
});

test("socket mutation admission binds exact wrapper identity and secret, never reusable native aliases", async () => {
  const { binding, child } = await launch(["/bin/sh", "-c", "printf STARTED"]);
  try {
    await assert.rejects(activatePanel({ ...binding, process: { ...binding.process!, startTime: "0" } }), /identity/);
    const config = readPanelConfig(binding);
    const result = await new Promise<string>((resolve, reject) => {
      const socket = net.createConnection(path.join(binding.directory, "control.sock"));
      socket.once("error", reject);
      socket.once("connect", () => socket.write(`${JSON.stringify({ id: binding.id, token: "not-the-token", process: binding.process, operation: "activate" })}\n`));
      let result = ""; socket.on("data", chunk => { result += chunk; }); socket.once("end", () => resolve(result));
    });
    assert.match(result, /identity mismatch/);
    assert.equal(fs.existsSync(config.outputPath), false);
    const resultPair = await Promise.allSettled([activatePanel(binding), activatePanel(binding)]);
    assert.equal(resultPair.filter(item => item.status === "fulfilled").length, 1, "concurrent activation launches exactly once");
  } finally { await cleanup(binding, child); }
});

test("panel owner preserves UTF-8 input split across native socket reads", { timeout: 20_000 }, async t => {
  const original = createPanelBinding({ argv: ["/bin/sh", "-c", "printf READY; IFS= read -r value; printf 'VALUE:%s\\n' \"$value\""], cwd: "/tmp" });
  const args = panelWrapperArgv(original);
  // Observe real socket delivery without replacing the owner or its parser.
  // The ASCII prefix produces a data event even when setEncoding holds the
  // incomplete UTF-8 character, so IPC can acknowledge the first read.
  const probe = `
    import { channel } from 'node:diagnostics_channel';
    import { pathToFileURL } from 'node:url';
    channel('net.server.socket').subscribe(({ socket }) => {
      socket.on('data', chunk => {
        if (chunk.toString().includes('"text":"split-')) process.send('fragment-read');
      });
    });
    await import(pathToFileURL(process.argv[1]).href);
  `;
  const child = spawn(args[0], ["--input-type=module", "--eval", probe, ...args.slice(1)], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  let binding = original;
  let socket: net.Socket | undefined;
  try {
    binding = await waitPanelReady(original);
    await activatePanel(binding);
    const config = readPanelConfig(binding);
    await until(() => fs.existsSync(config.outputPath) && fs.readFileSync(config.outputPath, "utf8").includes("READY"));
    const text = "split-€🦊漢字";
    const request = Buffer.from(`${JSON.stringify({ id: binding.id, token: config.token, process: binding.process,
      operation: "input", input: { kind: "text", text, enter: true } })}\n`);
    const split = request.indexOf(Buffer.from("€")) + 1;
    assert.ok(split > 1);
    socket = net.createConnection({ path: path.join(binding.directory, "control.sock"), signal: t.signal });
    socket.setEncoding("utf8");
    let receipt = "";
    const response = new Promise<string>((resolve, reject) => {
      socket!.once("error", reject);
      socket!.on("data", chunk => { receipt += chunk; });
      socket!.once("end", () => resolve(receipt));
    });
    const firstRead = once(child, "message", { signal: t.signal });
    await once(socket, "connect", { signal: t.signal });
    socket.write(request.subarray(0, split));
    assert.deepEqual(await firstRead, ["fragment-read", undefined]);
    socket.write(request.subarray(split));
    assert.equal((JSON.parse(await response) as { state: { id: string } }).state.id, binding.id);
    await until(async () => (await panelStatus(binding)).command === "exited");
    const received = fs.readFileSync(config.outputPath, "utf8").split(/\r?\n/).find(line => line.startsWith("VALUE:"));
    assert.equal(received, `VALUE:${text}`, "the PTY command receives the original Unicode input");
  } finally {
    socket?.destroy();
    await cleanup(binding, child);
  }
});

test("panel client preserves UTF-8 responses split across native socket reads", { timeout: 20_000 }, async t => {
  const binding = { ...createPanelBinding({ argv: ["/bin/sh"], cwd: "/tmp" }), process: readProcessIdentity(process.pid)! };
  const error = "split-🦊漢字";
  const response = Buffer.from(`${JSON.stringify({ error })}\n`);
  const split = response.indexOf(Buffer.from("🦊")) + 2;
  assert.ok(split > 2);
  let acknowledgeRead!: () => void;
  const firstRead = new Promise<void>(resolve => { acknowledgeRead = resolve; });
  const sockets = new Set<net.Socket>();
  const reads = channel("net.client.socket");
  const observe = (message: unknown): void => {
    const { socket } = message as { socket: net.Socket };
    socket.on("data", chunk => {
      if (chunk.toString().includes('"error":"split-')) acknowledgeRead();
    });
  };
  reads.subscribe(observe);
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.once("error", () => {});
    socket.once("data", () => {
      socket.write(response.subarray(0, split));
      // Wait for the public client's actual first read, not a timed delay or
      // write callback: the remaining bytes cannot coalesce with that read.
      void firstRead.then(() => socket.end(response.subarray(split)));
    });
  });
  try {
    server.listen(path.join(binding.directory, "control.sock"));
    await once(server, "listening", { signal: t.signal });
    fs.chmodSync(path.join(binding.directory, "control.sock"), 0o600);
    await assert.rejects(panelStatus(binding, t.signal), (failure: unknown) => failure instanceof Error && failure.message === error);
  } finally {
    reads.unsubscribe(observe);
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    fs.rmSync(binding.directory, { recursive: true, force: true });
  }
});

test("creator death before activation never executes user argv and cleans the held wrapper", async () => {
  const creator = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
  await once(creator, "spawn");
  const { binding, child } = await launch(["/bin/sh", "-c", "touch never"], readProcessIdentity(creator.pid!)!);
  try {
    const exited = once(creator, "close"); creator.kill(); await exited;
    await until(() => processIdentityStatus(binding.process!) === "dead");
    const state = await panelStatus(binding);
    assert.equal(state.closed, true);
    assert.equal(fs.existsSync(readPanelConfig(binding).outputPath), false);
  } finally { await cleanup(binding, child); }
});

test("creator death still cleans active work after a nonfatal resize error", { timeout: 20_000 }, async () => {
  const creator = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
  await once(creator, "spawn");
  const original = createPanelBinding({ argv: ["/bin/sh", "-c", "echo COMMAND:$$; read value"], cwd: "/tmp", creator: readProcessIdentity(creator.pid!)! });
  const args = panelWrapperArgv(original);
  const probe = `
    import { pathToFileURL } from 'node:url';
    process.on('message', () => {
      Object.defineProperty(process.stdout, 'isTTY', { value: true });
      process.stdout.getWindowSize = () => { throw new Error('Synthetic resize failure'); };
      process.stdout.emit('resize');
    });
    await import(pathToFileURL(process.argv[1]).href);
  `;
  const child = spawn(args[0], ["--input-type=module", "--eval", probe, ...args.slice(1)], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  let binding = original;
  try {
    binding = await waitPanelReady(original);
    await activatePanel(binding);
    const log = readPanelConfig(binding).outputPath;
    await until(() => fs.existsSync(log) && /COMMAND:\d+/.test(fs.readFileSync(log, "utf8")));
    const command = readProcessIdentity(Number(/COMMAND:(\d+)/.exec(fs.readFileSync(log, "utf8"))![1]))!;
    assert.ok(command);
    child.send("fail-resize");
    await until(async () => (await panelStatus(binding)).error?.includes("Synthetic resize failure") === true);
    assert.equal((await panelStatus(binding)).command, "running", "resize is diagnostic, not command termination");
    const exited = once(creator, "close"); creator.kill(); await exited;
    await until(() => processIdentityStatus(binding.process!) === "dead");
    assert.equal(processIdentityStatus(command), "dead");
    assert.equal((await panelStatus(binding)).closed, true);
  } finally {
    if (creator.exitCode === null && creator.signalCode === null) { const exited = once(creator, "close"); creator.kill(); await exited; }
    await cleanup(binding, child);
  }
});

test("cancelled bindings cannot activate, including wrappers that arrive after rollback", async () => {
  const binding = createPanelBinding({ argv: ["/bin/sh", "-c", "printf NEVER"], cwd: "/tmp" });
  await rollbackPanel(binding);
  const args = panelWrapperArgv(binding);
  const child = spawn(args[0], args.slice(1), { stdio: "ignore" });
  try {
    await once(child, "close");
    assert.equal(fs.existsSync(readPanelConfig(binding).outputPath), false);
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(activatePanel(binding, aborted.signal), /abort/i);
  } finally { fs.rmSync(binding.directory, { recursive: true, force: true }); }
});

test("Close settles the owned PTY command and descendants, not unrelated processes", async () => {
  const { binding, child } = await launch(["/bin/sh", "-c", "sleep 300 & echo CHILD:$!; wait"]);
  const unrelated = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
  await once(unrelated, "spawn");
  try {
    await activatePanel(binding);
    const log = readPanelConfig(binding).outputPath;
    await until(() => fs.existsSync(log) && /CHILD:\d+/.test(fs.readFileSync(log, "utf8")));
    const pid = Number(/CHILD:(\d+)/.exec(fs.readFileSync(log, "utf8"))![1]);
    const identity = readProcessIdentity(pid)!;
    await closePanel(binding);
    assert.equal(processIdentityStatus(identity), "dead");
    assert.equal(processIdentityStatus(readProcessIdentity(unrelated.pid!)!), "alive");
  } finally {
    const exited = once(unrelated, "close"); unrelated.kill(); await exited;
    await cleanup(binding, child);
  }
});

// A wrapper whose `process.kill` refuses `sleep` with EPERM, like descendants of
// another user (`su`'s shell), without needing a second account.
async function launchUnsignalableSleep(command: string): Promise<{ binding: PanelBinding; child: ChildProcess; sleep: NonNullable<ReturnType<typeof readProcessIdentity>> }> {
  const original = createPanelBinding({ argv: ["/bin/sh", "-c", command], cwd: "/tmp" });
  const args = panelWrapperArgv(original);
  const probe = `
    import * as fs from 'node:fs';
    import { pathToFileURL } from 'node:url';
    const kill = process.kill.bind(process);
    process.kill = (pid, signal) => {
      let comm = '';
      try { comm = fs.readFileSync('/proc/' + pid + '/comm', 'utf8').trim(); } catch {}
      if (comm === 'sleep') throw Object.assign(new Error('kill EPERM'), { code: 'EPERM', syscall: 'kill' });
      return kill(pid, signal);
    };
    await import(pathToFileURL(process.argv[1]).href);
  `;
  const child = spawn(args[0], ["--input-type=module", "--eval", probe, ...args.slice(1)], { stdio: "ignore" });
  const binding = await waitPanelReady(original);
  await activatePanel(binding);
  const log = readPanelConfig(binding).outputPath;
  await until(() => fs.existsSync(log) && /CHILD:\d+/.test(fs.readFileSync(log, "utf8")));
  const identity = readProcessIdentity(Number(/CHILD:(\d+)/.exec(fs.readFileSync(log, "utf8"))![1]))!;
  assert.ok(identity);
  return { binding, child, sleep: identity };
}

test("Close signals around an unsignalable descendant and awaits its hangup exit", { timeout: 20_000 }, async () => {
  const { binding, child, sleep } = await launchUnsignalableSleep("sleep 300 & echo CHILD:$!; wait");
  try {
    await closePanel(binding);
    assert.equal(processIdentityStatus(sleep), "dead");
    assert.equal(processIdentityStatus(binding.process!), "dead");
  } finally { await cleanup(binding, child); }
});

test("Close names a surviving unsignalable descendant, and a later Close succeeds", { timeout: 20_000 }, async () => {
  const { binding, child, sleep } = await launchUnsignalableSleep("trap '' HUP; sleep 300 & echo CHILD:$!; wait");
  try {
    await assert.rejects(closePanel(binding), new RegExp(`uncertain: ${sleep.pid} \\(not permitted to signal\\) still running`));
    assert.equal(processIdentityStatus(binding.process!), "alive", "failed cleanup retains the wrapper");
    process.kill(sleep.pid, "SIGKILL");
    await until(() => processIdentityStatus(sleep) === "dead");
    await closePanel(binding);
    assert.equal(processIdentityStatus(binding.process!), "dead");
  } finally {
    if (processIdentityStatus(sleep) === "alive") process.kill(sleep.pid, "SIGKILL");
    await cleanup(binding, child);
  }
});

test("status readers follow the owner's atomic republication instead of calling a replaced file unsafe", async () => {
  const binding = createPanelBinding({ argv: ["/bin/true"], cwd: "/tmp" });
  const file = path.join(binding.directory, "state.json");
  const exited = { ...readProcessIdentity(process.pid)!, startTime: "0" };
  const state = `${JSON.stringify({ schema: 1, id: binding.id, process: exited, command: "exited", closed: true })}\n`;
  fs.writeFileSync(file, state, { mode: 0o600 });
  // Republish exactly as the owner does: a complete private file renamed over the old one.
  const owner = new Worker(`const fs = require("node:fs"); const { workerData } = require("node:worker_threads");
    for (let index = 0;; index++) {
      const temporary = workerData.file + "." + index + ".tmp";
      fs.writeFileSync(temporary, workerData.state, { flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, workerData.file);
    }`, { eval: true, workerData: { file, state } });
  try {
    await once(owner, "online");
    for (let read = 0; read < 20_000; read++) assert.equal((await panelStatus(binding)).closed, true);
  } finally {
    await owner.terminate();
    fs.rmSync(binding.directory, { recursive: true, force: true });
  }
});

test("neutral terminal keys encode control, arrows and literal case", () => {
  assert.equal(["ctrl+c", "Escape", "Up", "alt+x", "Tab", "F5", "A", "Alt+X", "shift+b", "PageDown", "Enter"].map(panelKeyBytes).join(""), "\x03\x1b\x1b[A\x1bx\t\x1b[15~A\x1bXB\x1b[6~\r");
  assert.equal(panelKeyBytes("ctrl+up"), "\x1b[1;5A");
  assert.equal(panelKeyBytes("alt+shift+F5"), "\x1b[15;4~");
  assert.equal(panelKeyBytes("ctrl+backspace"), "\b");
  assert.throws(() => panelKeyBytes("hyper+x"), /Unsupported/);
});
