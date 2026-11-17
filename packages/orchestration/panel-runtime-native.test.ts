import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { HostTarget } from "./host-types.ts";
import { activatePanel, closePanel, createPanelBinding, PANEL_RUNTIME } from "./panel-runtime.ts";
import { readProcessIdentity, processIdentityStatus } from "@phimacs/pimux/process-identity";
import { createHerdrHost } from "./hosts/herdr.ts";
import { nativeRequest, pinNativeSocket } from "./hosts/native-surface.ts";

test("isolated real Herdr keeps completed panel output and closes through its wrapper's owning exit", { skip: process.env.PANEL_HERDR_NATIVE !== "1", timeout: 20_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "panel-herdr-real-"));
  const endpoint = path.join(root, "herdr.sock");
  const config = path.join(root, "config");
  const runtime = path.join(root, "run");
  for (const directory of [path.join(config, "herdr"), runtime]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(config, "herdr", "config.toml"), 'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\n');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(HERDR_|PI_|PHIMACS_)/.test(key)));
  Object.assign(env, { HOME: root, XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: runtime, HERDR_SOCKET_PATH: endpoint, SHELL: "/bin/sh" });
  const daemon = spawn(process.env.HERDR_BIN_PATH || "herdr", ["server"], { env, stdio: ["ignore", "ignore", "pipe"] });
  let diagnostic = "";
  daemon.stderr.on("data", chunk => { diagnostic += chunk; });
  const until = async (predicate: () => boolean | Promise<boolean>): Promise<void> => {
    const deadline = Date.now() + 5000;
    while (!await predicate()) { assert.ok(Date.now() < deadline, diagnostic || "native event arrived"); assert.equal(daemon.exitCode, null, diagnostic); await delay(20); }
  };
  let target: HostTarget | undefined;
  try {
    await until(() => fs.existsSync(endpoint));
    const directory = path.join(root, "pin"); fs.mkdirSync(directory, { mode: 0o700 });
    const socket = pinNativeSocket(endpoint, directory);
    const created = await nativeRequest(socket, "workspace.create", { cwd: root, label: "owned-native-test", focus: false });
    const parentId = (created.root_pane as { pane_id: string }).pane_id;
    const host = createHerdrHost({ exec: async () => { throw new Error("Native shell lifecycle must use owned control, not CLI pane input/close"); } }, endpoint);
    target = await host.start({ kind: "shell", name: "finished", cwd: root,
      argv: ["/bin/sh", "-c", "printf READY; read value; printf 'FINISHED:%s\\n' \"$value\""], placement: "worker",
      parent: { host: "herdr", endpoint, id: parentId, name: "parent", kind: "pi" } });
    await activatePanel(target.panel!);
    await until(async () => (await host.read(target!)).includes("READY"));
    await host.send(target, { kind: "text", text: "owned-input", enter: true });
    await until(async () => await host.state(target!) === "exited");
    assert.match(await host.read(target), /FINISHED:owned-input/);
    assert.ok((await nativeRequest(socket, "pane.get", { pane_id: target.id })).pane, "completed output remains in the native pane");
    await host.close(target);
    await until(async () => {
      try { await nativeRequest(socket, "pane.get", { pane_id: target!.id }); return false; }
      catch (error) { return /not found|not exist|unknown pane/i.test(String(error)); }
    });
    assert.ok((await nativeRequest(socket, "pane.get", { pane_id: parentId })).pane);
    fs.rmSync(target.panel!.directory, { recursive: true, force: true });
    target = undefined;
    const creator = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
    await once(creator, "spawn");
    try {
      const guarded = createHerdrHost({ exec: async () => { throw new Error("No alias mutation"); } }, endpoint,
        { ...PANEL_RUNTIME, create: options => createPanelBinding({ ...options, creator: readProcessIdentity(creator.pid!)! }) });
      target = await guarded.start({ kind: "shell", name: "held", cwd: root, argv: ["/bin/sh", "-c", "touch MUST-NOT-RUN"], placement: "worker",
        parent: { host: "herdr", endpoint, id: parentId, name: "parent", kind: "pi" } });
      const exited = once(creator, "close"); creator.kill(); await exited;
      await until(() => processIdentityStatus(target!.panel!.process!) === "dead");
      assert.equal(fs.existsSync(path.join(root, "MUST-NOT-RUN")), false, "creator death cannot activate unregistered Herdr work");
      await guarded.close(target);
    } finally {
      if (creator.exitCode === null && creator.signalCode === null) { const exited = once(creator, "close"); creator.kill(); await exited; }
    }
  } finally {
    if (target?.panel) { await closePanel(target.panel); fs.rmSync(target.panel.directory, { recursive: true, force: true }); }
    if (daemon.exitCode === null && daemon.signalCode === null) { const exited = once(daemon, "close"); daemon.kill(); await exited; }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
