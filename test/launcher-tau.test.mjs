// Exercise the foreground launcher with real Tau and a disposable, absent pimux.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveHost } from "@phimacs/pimux/host-identity";

const launcher = path.resolve(import.meta.dirname, "../bin/phimacs");

test("service tau replaces the launcher, keeps its own arguments and never starts pimux", { timeout: 15_000 }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "phimacs-tau-launch-"));
  const state = path.join(home, "state");
  const mux = path.join(home, "mux");
  const pi = resolveHost().executable;
  const env = {
    HOME: home, PATH: process.env.PATH, LANG: "C.UTF-8", PHIMACS_PI: pi,
    PHIMACS_STATE_DIR: state, PIMUX_DIR: mux, PHIMACS_SERVER_NAME: "test-emacs",
    PHIMACS_EMACS: "/must-not-start-emacs", PHIMACS_PIMUX_SUPERVISOR_COMMAND: "/must-not-start-pimux",
    PI_ORCHESTRATION_TARGET: "foreign-parent", PIMUX_DISCOVERY: "foreign-writer",
    TAU_HOST: "127.0.0.1", TAU_PORT: "0", TAU_HTTP_PORT: "not-used-because-flag-wins",
  };
  const child = spawn(launcher, ["--local", "service", "tau", "--http-port", "0"], { env, stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    fs.rmSync(home, { recursive: true, force: true });
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const url = await new Promise((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(() => reject(new Error(`Tau did not start\n${stdout}\n${stderr}`)), 8_000);
    exited.then(([code, signal]) => {
      clearTimeout(timer);
      reject(new Error(`Tau exited before readiness (${signal ?? code})\n${stderr}`));
    }, error => { clearTimeout(timer); reject(error); });
    child.stdout.on("data", chunk => {
      stdout += chunk;
      const ready = /http:\/\/127\.0\.0\.1:(\d+)\r?\n/.exec(stdout);
      if (ready) { clearTimeout(timer); resolve(ready[0].trim()); }
    });
  });
  const selected = Object.fromEntries(fs.readFileSync(`/proc/${child.pid}/environ`, "utf8")
    .split("\0").filter(Boolean).map(pair => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]));
  assert.equal(selected.PHIMACS_PI, pi);
  assert.equal(selected.PHIMACS_SERVER_SOCKET, path.join(state, "sockets", "test-emacs"));
  assert.equal(selected.PIMUX_DIR, mux);
  assert.equal(selected.PI_ORCHESTRATION_TARGET, undefined);
  assert.equal(selected.PIMUX_DISCOVERY, undefined);

  const response = await fetch(`${url}/`, { signal: AbortSignal.timeout(3_000) });
  assert.equal(response.status, 200, "loopback is passwordless by default");
  assert.match(await response.text(), /src="app\.js"/);
  const agents = await fetch(`${url}/api/agents`, { signal: AbortSignal.timeout(3_000) });
  assert.equal(agents.status, 200);
  assert.deepEqual((await agents.json()).agents, [], "no agents are started by the frontend");
  assert.equal(fs.existsSync(path.join(mux, "service.sock")), false);
  assert.equal(fs.existsSync(state), false, "the frontend does not prepare service or Emacs state");
  child.kill("SIGTERM");
  assert.deepEqual(await exited, [0, null], stderr);
});
