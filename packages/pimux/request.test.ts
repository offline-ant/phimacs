import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { acquireClaim, createClaimTestEnvironment, releaseClaim } from "./ownership.ts";
import { readProcessIdentity } from "./process-identity.ts";
import type { RuntimeReceipt } from "./runtime.ts";
import { runtimeIdentity, runtimeRequest } from "./request.ts";

async function peer(t: TestContext, accept: (socket: net.Socket, receipt: RuntimeReceipt) => void): Promise<RuntimeReceipt> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phimacs-rpc-peer-"));
  const receipt: RuntimeReceipt = { protocol: 2, operationId: randomUUID(), muxId: randomUUID(), socket: path.join(dir, "runtime.sock"), pid: process.pid,
    piPid: process.pid, sessionFile: path.join(dir, "session.jsonl"), state: "committed", outcome: "started" };
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => { sockets.add(socket); socket.on("error", () => undefined); socket.once("close", () => sockets.delete(socket)); accept(socket, receipt); });
  await new Promise<void>((resolve) => server.listen(receipt.socket, resolve));
  fs.chmodSync(receipt.socket, 0o600);
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); fs.rmSync(dir, { recursive: true, force: true }); });
  return receipt;
}
function send(socket: net.Socket, record: object): void { socket.write(`${JSON.stringify(record)}\n`); }
function hello(receipt: RuntimeReceipt): object { return { type: "pimux_hello", protocol: 2, muxId: receipt.muxId, piPid: receipt.piPid, capabilities: ["snapshot", "detached", "stop", "contextual-input"] }; }
function snapshot(receipt: RuntimeReceipt, generation = 1): object {
  return { type: "pimux_snapshot", generation, session: { file: receipt.sessionFile },
    inputContext: { sessionFile: receipt.sessionFile, leafId: `leaf-${generation}`, contextId: `context-${generation}` } };
}

test("sends once only after matching authoritative live boundary and restores request correlation", async (t) => {
  let requests = 0;
  const receipt = await peer(t, (socket, runtime) => {
    let live = false;
    socket.on("data", (chunk) => {
      assert.equal(live, true);
      requests++;
      const request = JSON.parse(chunk.toString()) as { id: string; type: string; pimuxContext: unknown };
      assert.equal(request.type, "prompt");
      assert.deepEqual(request.pimuxContext, { sessionFile: runtime.sessionFile, leafId: "leaf-2", contextId: "context-2" });
      send(socket, { type: "response", id: "another-client", success: false });
      send(socket, { type: "response", id: request.id, success: true, data: { accepted: true } });
    });
    send(socket, hello(runtime)); send(socket, snapshot(runtime));
    send(socket, { type: "pimux_gap", generation: 2 });
    send(socket, { type: "pimux_live", generation: 1 });
    setImmediate(() => { send(socket, snapshot(runtime, 2)); live = true; send(socket, { type: "pimux_live", generation: 2 }); });
  });
  assert.equal((await runtimeRequest(receipt, { type: "prompt", message: "synthetic" })).success, true);
  assert.equal(requests, 1);
});

test("wrong protocol/runtime/session refuses before any command", async (t) => {
  for (const invalid of ["protocol", "mux", "session", "capabilities"]) {
    let requests = 0;
    const receipt = await peer(t, (socket, runtime) => {
      socket.on("data", () => requests++);
      send(socket, { ...hello(runtime), ...(invalid === "protocol" ? { protocol: 1 } : {}), ...(invalid === "mux" ? { muxId: "other" } : {}), ...(invalid === "capabilities" ? { capabilities: [] } : {}) });
      send(socket, invalid === "session" ? { ...snapshot(runtime), session: { file: `${runtime.sessionFile}.other` } } : snapshot(runtime));
      send(socket, { type: "pimux_live", generation: 1 });
    });
    await assert.rejects(runtimeRequest(receipt, { type: "prompt" }), /mismatch|different conversation/);
    assert.equal(requests, 0);
  }
});

test("lost acknowledgement or cancellation after send is uncertain, never replayed", async (t) => {
  for (const cancel of [false, true]) {
    let requests = 0;
    const controller = new AbortController();
    const receipt = await peer(t, (socket, runtime) => {
      socket.on("data", () => { requests++; if (cancel) controller.abort(); else socket.end(); });
      send(socket, hello(runtime)); send(socket, snapshot(runtime)); send(socket, { type: "pimux_live", generation: 1 });
    });
    await assert.rejects(runtimeRequest(receipt, { type: "prompt" }, controller.signal), /may have been accepted; it was not replayed/);
    assert.equal(requests, 1);
  }
});

test("privacy, malformed records, and never-live peers fail boundedly without a prompt", async (t) => {
  const unsafe = await peer(t, () => undefined);
  fs.chmodSync(unsafe.socket, 0o666);
  await assert.rejects(runtimeRequest(unsafe, { type: "prompt" }), /private/);
  const malformed = await peer(t, (socket) => socket.write("invalid\n"));
  await assert.rejects(runtimeRequest(malformed, { type: "prompt" }), /Malformed/);
  const waiting = await peer(t, (socket, runtime) => { send(socket, hello(runtime)); send(socket, snapshot(runtime)); });
  await assert.rejects(runtimeRequest(waiting, { type: "prompt" }, undefined, 25), /timed out/);
});

test("attachment deadline does not become an extension-command task deadline", async (t) => {
  const receipt = await peer(t, (socket, runtime) => {
    socket.on("data", (chunk) => {
      const request = JSON.parse(chunk.toString()) as { id: string };
      const timer = setTimeout(() => send(socket, { type: "response", id: request.id, success: true }), 600);
      t.after(() => clearTimeout(timer));
    });
    send(socket, hello(runtime)); send(socket, snapshot(runtime)); send(socket, { type: "pimux_live", generation: 1 });
  });
  assert.equal((await runtimeRequest(receipt, { type: "prompt", message: "/await-human" }, undefined, 500)).success, true);
});

test("mutations require the snapshot context; observations can read a history-error snapshot", async (t) => {
  for (const type of ["prompt", "get_messages"]) {
    let requests = 0;
    const receipt = await peer(t, (socket, runtime) => {
      socket.on("data", (chunk) => {
        requests++;
        const request = JSON.parse(chunk.toString()) as { id: string; pimuxContext?: unknown };
        assert.equal(request.pimuxContext, undefined);
        send(socket, { type: "response", id: request.id, success: true });
      });
      send(socket, hello(runtime));
      send(socket, { ...snapshot(runtime), inputContext: null, historyError: "synthetic history failure" });
      send(socket, { type: "pimux_live", generation: 1 });
    });
    if (type === "prompt") {
      await assert.rejects(runtimeRequest(receipt, { type, message: "not dispatched" }), /no usable input context/);
      assert.equal(requests, 0);
    } else {
      assert.equal((await runtimeRequest(receipt, { type })).success, true);
      assert.equal(requests, 1);
    }
  }
});

test("model control requires its advertised capability before dispatch; lists need no input context", async (t) => {
  let oldRequests = 0;
  const old = await peer(t, (socket, runtime) => {
    socket.on("data", () => oldRequests++);
    send(socket, hello(runtime)); send(socket, snapshot(runtime)); send(socket, { type: "pimux_live", generation: 1 });
  });
  const unsupported = await runtimeRequest(old, { type: "pimux_models", action: "set", provider: "openai", modelId: "sol" });
  assert.equal(unsupported.success, false);
  assert.equal((unsupported.error as { code: string }).code, "unsupported_operation");
  assert.equal(oldRequests, 0);
  let requests = 0;
  const current = await peer(t, (socket, runtime) => {
    socket.on("data", (chunk) => {
      requests++;
      const request = JSON.parse(chunk.toString()) as { id: string; pimuxContext?: unknown };
      assert.equal(request.pimuxContext, undefined);
      send(socket, { type: "response", id: request.id, success: true, data: { models: [] } });
    });
    send(socket, { ...hello(runtime), capabilities: ["snapshot", "detached", "contextual-input", "models"] });
    send(socket, { ...snapshot(runtime), inputContext: null }); send(socket, { type: "pimux_live", generation: 1 });
  });
  assert.equal((await runtimeRequest(current, { type: "pimux_models", action: "list" })).success, true);
  assert.equal(requests, 1);
});

test("runtime Pi identity comes from the matching claim, not a numeric PID", () => {
  const environment = createClaimTestEnvironment();
  const identity = readProcessIdentity(process.pid)!;
  const file = path.join(environment.sessions, "runtime.jsonl");
  const receipt: RuntimeReceipt = { protocol: 2, muxId: randomUUID(), operationId: randomUUID(), socket: path.join(environment.root, "runtime.sock"), pid: process.pid,
    piPid: process.pid, sessionFile: file, state: "committed", outcome: "started" };
  const handle = acquireClaim(file, { kind: "rpc", id: receipt.muxId, wrapper: identity, pi: identity, protocol: 2, socket: receipt.socket }, { testRoot: environment.root });
  try {
    assert.deepEqual(runtimeIdentity(receipt, environment.env), identity);
    assert.throws(() => runtimeIdentity({ ...receipt, muxId: "different-owner" }, environment.env), /identity changed/);
    assert.throws(() => runtimeIdentity({ ...receipt, socket: `${receipt.socket}.other` }, environment.env), /identity changed/);
  } finally { releaseClaim(handle); fs.rmSync(environment.root, { recursive: true, force: true }); }
});
