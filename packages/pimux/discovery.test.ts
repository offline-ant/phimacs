import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { redactEndpoint } from "./endpoint.ts";
import { type DiscoveryRecord, listDiscovery, orchestrationIdentity, reclaimStale, writeDiscovery } from "./discovery.ts";
import { ensurePrivateDirectory } from "./private-files.ts";

function record(muxId: string, pid: number, piPid: number | null = pid): DiscoveryRecord {
  return {
    protocol: 1, muxId, socket: `/x/${muxId}.sock`, pid, piPid, cwd: "/", startedAt: "", updatedAt: "", status: "idle", blocked: null,
    session: null, model: null, thinkingLevel: null, placement: "root", orchestration: null, parent: null,
  };
}

test("the discovery directory must be private", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pimux-dir-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, "mux");
  ensurePrivateDirectory(dir);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  fs.chmodSync(dir, 0o755);
  assert.throws(() => ensurePrivateDirectory(dir), /mode 0700/);
});

test("stale entries are reclaimed only when their socket refuses connections and no owner lives", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pimux-reclaim-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Live: a listening socket.
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(path.join(dir, "live.sock"), resolve));
  t.after(() => server.close());
  writeDiscovery(path.join(dir, "live.json"), record("live", process.pid));
  // Socket files nobody listens on (a killed wrapper's leftovers).
  const abandoned = async (name: string): Promise<void> => {
    const listener = spawn(process.execPath, ["-e",
      `require("node:net").createServer().listen(${JSON.stringify(path.join(dir, `${name}.sock`))}, () => console.log("ready"))`]);
    await new Promise((resolve) => listener.stdout.once("data", resolve));
    listener.kill("SIGKILL");
    await new Promise((resolve) => listener.on("exit", resolve));
  };
  const exited = spawn(process.execPath, ["-e", ""]);
  await new Promise((resolve) => exited.on("exit", resolve));
  const dead = exited.pid!;
  await abandoned("dead");
  writeDiscovery(path.join(dir, "dead.json"), record("dead", dead));
  // A refused socket proves nothing while its wrapper or its Pi still runs.
  await abandoned("wrapper");
  writeDiscovery(path.join(dir, "wrapper.json"), record("wrapper", process.pid, dead));
  await abandoned("orphan");
  writeDiscovery(path.join(dir, "orphan.json"), record("orphan", dead, process.pid));
  // A wrapper killed before listening, and ones still starting or orphaning their Pi.
  writeDiscovery(path.join(dir, "early.json"), record("early", dead, null));
  writeDiscovery(path.join(dir, "starting.json"), record("starting", process.pid, null));
  writeDiscovery(path.join(dir, "early-orphan.json"), record("early-orphan", dead, process.pid));
  assert.deepEqual((await reclaimStale(dir)).sort(), ["dead", "early"]);
  assert.deepEqual(listDiscovery(dir).map((entry) => entry.muxId).sort(), ["early-orphan", "live", "orphan", "starting", "wrapper"]);
  assert.equal(fs.existsSync(path.join(dir, "dead.sock")), false);
  assert.equal(fs.existsSync(path.join(dir, "orphan.sock")), true);
  assert.equal(fs.statSync(path.join(dir, "live.json")).mode & 0o777, 0o600);
});

test("orchestration identity comes from the environment without URL credentials", () => {
  assert.equal(redactEndpoint("http://example:secret@127.0.0.1:3001"), "http://127.0.0.1:3001/");
  assert.equal(redactEndpoint("/tmp/emacs1000/example"), "/tmp/emacs1000/example");
  assert.deepEqual(orchestrationIdentity({
    PI_ORCHESTRATION_HOST: "emacs", PI_ORCHESTRATION_ENDPOINT: "/tmp/e", PI_ORCHESTRATION_TARGET: "uuid-1",
    PI_ORCHESTRATION_PARENT: JSON.stringify({ host: "web", endpoint: "http://u:p@h:1", id: "root", name: "root" }),
  }), {
    orchestration: { host: "emacs", endpoint: "/tmp/e", id: "uuid-1" },
    parent: { host: "web", endpoint: "http://h:1/", id: "root", name: "root" },
  });
  assert.deepEqual(orchestrationIdentity({ PI_ORCHESTRATION_PARENT: "" }), { orchestration: null, parent: null });
  assert.deepEqual(orchestrationIdentity({ PI_ORCHESTRATION_PARENT: "{bad" }), { orchestration: null, parent: null });
});
