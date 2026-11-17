import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { ExecOptions, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { processIdentityStatus, readProcessIdentity, type ProcessIdentity } from "@phimacs/pimux/process-identity";
import type { HostTarget } from "../host-types.ts";
import { PANEL_RUNTIME, activatePanel, savedPanelState } from "../panel-runtime.ts";
import { createEmacsHost } from "./emacs.ts";
import { terminalArgv, verifyTerminalParity, type TerminalSize } from "../test/panel-terminal-parity.ts";

// Native checks require an explicit prepared Emacs directory. Pilish always
// comes from this checkout, never a sibling or a personal package/cache.
const packages = process.env.PHIMACS_TEST_EMACS_DIR;
const pilish = fileURLToPath(new URL("../../../emacs/pilish", import.meta.url));
const enabled = !!packages;
const execute = promisify(execFile);
const companion = fileURLToPath(new URL("../emacs/", import.meta.url));
const creatorFixture = fileURLToPath(new URL("../test/panel-native-creator.ts", import.meta.url));

async function until(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, label);
    await delay(15);
  }
}

async function nativeFixture() {
  assert.ok(packages && path.isAbsolute(packages), "PHIMACS_TEST_EMACS_DIR must name an absolute prepared Emacs directory");
  assert.ok(fs.existsSync(path.join(pilish, "pilish.el")), "in-repository Pilish source is required");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "phimacs-emacs-panel-"));
  fs.chmodSync(directory, 0o700);
  const socket = path.join(directory, "server");
  const namespaces = {
    HOME: path.join(directory, "home"), TMPDIR: path.join(directory, "tmp"),
    PHIMACS_STATE_DIR: path.join(directory, "state"),
    XDG_CONFIG_HOME: path.join(directory, "config"), XDG_CACHE_HOME: path.join(directory, "cache"),
    XDG_STATE_HOME: path.join(directory, "xdg-state"), XDG_DATA_HOME: path.join(directory, "data"),
    XDG_RUNTIME_DIR: path.join(directory, "runtime"), PI_CODING_AGENT_DIR: path.join(directory, "agent"),
    PI_CODING_AGENT_SESSION_DIR: path.join(directory, "sessions"), PIMUX_DIR: path.join(directory, "mux"),
  };
  for (const folder of Object.values(namespaces)) fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  // Without a session bus GTK autolaunches one (plus accessibility services) on
  // the owned display, outside fixture ownership. Select an absent private bus.
  const bus = `unix:path=${path.join(namespaces.XDG_RUNTIME_DIR, "no-session-bus")}`;
  const env: NodeJS.ProcessEnv = { ...process.env, ...namespaces, DBUS_SESSION_BUS_ADDRESS: bus, GDK_BACKEND: "x11", ALTERNATE_EDITOR: "false",
    PHIMACS_MANAGED_CLAIM: "", PHIMACS_PARENT_TASK: "", PHIMACS_PARENT_TASK_FILE: "",
    PI_ORCHESTRATION_HOST: "", PI_ORCHESTRATION_ENDPOINT: "", PI_ORCHESTRATION_TARGET: "" };
  for (const key of ["DISPLAY", "WAYLAND_DISPLAY", "EMACSLOADPATH"]) delete env[key];
  // PGTK's server request handling requires an initialized display on Emacs 32.
  // The frame lives on a test-owned X server, never a user's desktop.
  const displayServer = spawn("Xvfb", ["-displayfd", "1", "-screen", "0", "1024x768x24", "-nolisten", "tcp"], { env, stdio: ["ignore", "pipe", "pipe"] });
  const display = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => { displayServer.kill(); reject(new Error("Isolated display readiness timed out")); }, 5000);
    displayServer.once("error", error => { clearTimeout(timer); reject(error); });
    displayServer.stdout!.on("data", chunk => {
      output += chunk.toString();
      if (output.includes("\n")) {
        clearTimeout(timer);
        const number = output.trim();
        if (/^\d+$/.test(number)) resolve(`:${number}`); else reject(new Error("Invalid isolated display receipt"));
      }
    });
  });
  const stopDisplay = async (): Promise<void> => {
    if (displayServer.exitCode === null && displayServer.signalCode === null) {
      const closed = once(displayServer, "close"); displayServer.kill("SIGTERM"); await closed;
    }
  };
  env.DISPLAY = display;
  const loadPaths = [pilish, companion];
  // Dependencies come from the prepared Emacs directory (scripts/emacs-packages.mjs);
  // the candidates above stay out of package activation.
  const setup = `(progn (require 'package) (setq package-user-dir ${JSON.stringify(path.join(packages, "elpa"))} package-load-list '((pilish nil) all) load-prefer-newer t native-comp-jit-compilation nil ghostel-module-directory ${JSON.stringify(path.join(packages, "ghostel/"))} treesit-extra-load-path (list ${JSON.stringify(path.join(packages, "tree-sitter"))})) (package-initialize) (require 'pi-orchestration))`;
  const daemonFile = path.join(directory, "daemon.pid");
  try {
    await execute("emacs", ["-Q", `--daemon=${socket}`, ...loadPaths.flatMap(load => ["-L", load]),
      "--eval", `(with-temp-file ${JSON.stringify(daemonFile)} (insert (number-to-string (emacs-pid))))`], { env, timeout: 10_000 });
    await execute("emacsclient", ["--socket-name", socket, "--create-frame", "--no-wait", "--display", display], { env, timeout: 10_000 });
    await execute("emacsclient", ["--socket-name", socket, "--eval", setup], { env, timeout: 10_000 });
  }
  catch (error) {
    if (fs.existsSync(daemonFile)) {
      const identity = readProcessIdentity(Number(fs.readFileSync(daemonFile, "utf8")));
      if (identity && processIdentityStatus(identity) === "alive") {
        process.kill(identity.pid, "SIGTERM");
        await until(() => processIdentityStatus(identity) === "dead", "failed disposable daemon exits");
      }
    }
    await stopDisplay();
    throw error;
  }
  const evaluate = async <T>(form: string): Promise<T> => {
    const result = await execute("emacsclient", ["--socket-name", socket, "--eval", `(json-encode ${form})`], { env, timeout: 5000 });
    return JSON.parse(JSON.parse(result.stdout.trim()) as string) as T;
  };
  const daemon = readProcessIdentity(Number(fs.readFileSync(daemonFile, "utf8")));
  assert.ok(daemon, "disposable daemon identity is known");
  const api: Pick<ExtensionAPI, "exec"> = {
    async exec(command: string, args: string[], options: ExecOptions = {}) {
      try {
        const result = await execute(command, args, { env, timeout: Math.min(options.timeout ?? 5000, 10_000), signal: options.signal });
        return { ...result, code: 0, truncated: false, killed: false };
      } catch (error) {
        const failure = error as Error & { stdout?: string; stderr?: string; code?: number | string; killed?: boolean };
        return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? failure.message,
          code: typeof failure.code === "number" ? failure.code : 1, truncated: failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: failure.killed ?? false };
      }
    },
  };
  const host = createEmacsHost(api, socket);
  const targets: HostTarget[] = [];
  const start = async (name: string, argv: string[], creator?: ProcessIdentity): Promise<HostTarget> => {
    const selected = creator ? createEmacsHost(api, socket, undefined, {
      ...PANEL_RUNTIME, create: options => PANEL_RUNTIME.create({ ...options, creator }),
    }) : host;
    const target = await selected.start({ kind: "shell", name, cwd: directory, argv,
      outputPath: path.join(directory, `${name}.log`), env: namespaces, placement: "worker" });
    targets.push(target);
    return target;
  };
  const exists = (target: HostTarget): Promise<boolean> => evaluate(`(if (gethash ${JSON.stringify(target.id)} pi-orchestration--targets) t :json-false)`);
  const buffer = (target: HostTarget): Promise<string | null> => evaluate(`(buffer-name (plist-get (gethash ${JSON.stringify(target.id)} pi-orchestration--targets) :buffer))`);
  const cleanup = async (): Promise<void> => {
    const failures: unknown[] = [];
    for (const target of targets) {
      try { await host.close(target); }
      catch (error) { failures.push(error); }
    }
    try {
      await execute("emacsclient", ["--socket-name", socket, "--eval", "(kill-emacs 0)"], { env, timeout: 5000 });
      await until(() => processIdentityStatus(daemon) === "dead", "disposable daemon exits");
    } catch (error) { failures.push(error); }
    try { await stopDisplay(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, `Native fixture cleanup uncertain; retained ${directory}`);
    for (const target of targets) if (target.panel) fs.rmSync(target.panel.directory, { recursive: true, force: true });
    fs.rmSync(directory, { recursive: true, force: true });
  };
  return { directory, socket, env, namespaces, bus, host, start, exists, buffer, evaluate, cleanup };
}

const nativeOptions = { skip: !enabled, timeout: 20_000 };

test("isolated Emacs panel holds work, owns input, preserves completed output and closes normally", nativeOptions, async () => {
  const fixture = await nativeFixture();
  try {
    const names = Object.keys(fixture.namespaces).map(key => JSON.stringify(key)).join(" ");
    assert.deepEqual(await fixture.evaluate(`(mapcar (lambda (name) (cons name (getenv name))) (list ${names}))`),
      fixture.namespaces, "the Emacs process receives only fixture-owned state and resource namespaces");
    assert.equal(await fixture.evaluate(`(getenv "DBUS_SESSION_BUS_ADDRESS")`), fixture.bus,
      "the Emacs process selects the absent private session bus");
    const marker = path.join(fixture.directory, "started");
    const target = await fixture.start("interactive", ["/bin/sh", "-c",
      'printf started > "$1"; printf "PANEL_READY\\n"; IFS= read -r line; printf "RECEIVED:%s\\n" "$line"', "panel-fixture", marker]);
    assert.ok(target.panel?.process);
    assert.equal(savedPanelState(target.panel)?.command, "held");
    assert.equal(fs.existsSync(marker), false, "Ghostel allocation cannot run unregistered argv");
    assert.equal(await fixture.exists(target), true);
    const buffer = await fixture.buffer(target);
    await activatePanel(target.panel);
    await until(async () => (await fixture.host.read(target)).includes("PANEL_READY"), "activated command is ready");
    await fixture.host.send(target, { kind: "text", text: "owned input", enter: true });
    await until(async () => await fixture.host.state(target) === "exited", "command completion is separate from wrapper exit");
    assert.match(await fixture.host.read(target), /RECEIVED:owned input/);
    assert.equal(processIdentityStatus(target.panel.process), "alive", "finished output retains its identity-bearing owner");
    assert.equal(await fixture.evaluate(`(pi-orchestration-panel-command-state (plist-get (gethash ${JSON.stringify(target.id)} pi-orchestration--targets) :buffer))`), "exited");
    assert.equal(await fixture.exists(target), true);
    await fixture.host.close(target);
    assert.equal(processIdentityStatus(target.panel.process), "dead");
    assert.equal(await fixture.exists(target), false);
    assert.equal(await fixture.evaluate(`(if (get-buffer ${JSON.stringify(buffer)}) t :json-false)`), false);
  } finally { await fixture.cleanup(); }
});

test("isolated Ghostel preserves native geometry, SIGWINCH, fullscreen redraw and raw keyboard bytes", nativeOptions, async () => {
  const fixture = await nativeFixture();
  try {
    const events = path.join(fixture.directory, "terminal-events.jsonl");
    const target = await fixture.start("terminal-parity", terminalArgv(events));
    assert.ok(target.panel?.process);
    const inBuffer = (form: string): string => `(with-current-buffer (plist-get (gethash ${JSON.stringify(target.id)} pi-orchestration--targets) :buffer) ${form})`;
    const resize = async (size: TerminalSize): Promise<void> => {
      await fixture.evaluate(inBuffer(`(progn (set-window-buffer (selected-window) (current-buffer)) (let ((inhibit-read-only t) (inhibit-modification-hooks t)) (ghostel--set-size-with-cell-dims ghostel--term ${size.rows} ${size.columns}) (ghostel--redraw ghostel--term t t)) nil)`));
    };
    await fixture.evaluate("(progn (set-frame-size (car (visible-frame-list)) 117 42) nil)");
    await resize({ rows: 35, columns: 111 });
    await activatePanel(target.panel);
    await verifyTerminalParity({
      binding: target.panel,
      events,
      capture: () => fixture.evaluate<string>(inBuffer("(ghostel--copy-all-text ghostel--term)")),
      resize,
      text: async value => { await fixture.evaluate(inBuffer(`(progn (ghostel-send-string ${JSON.stringify(value)}) nil)`)); },
      keys: async keys => {
        for (const key of keys) {
          const [name, modifiers] = key === "ctrl+c" ? ["c", "ctrl"] : [key === "Enter" ? "return" : key.toLowerCase(), ""];
          await fixture.evaluate(inBuffer(`(progn (ghostel-send-key ${JSON.stringify(name)} ${JSON.stringify(modifiers)}) nil)`));
        }
      },
    }, { rows: 41, columns: 129 });
  } finally { await fixture.cleanup(); }
});

test("isolated Emacs sidebar Close uses panelControl to close a completed panel", nativeOptions, async () => {
  const fixture = await nativeFixture();
  try {
    const target = await fixture.start("finished", ["/bin/sh", "-c", "printf 'FINISHED_PANEL\\n'"]);
    assert.ok(target.panel?.process);
    await activatePanel(target.panel);
    await until(async () => await fixture.host.state(target) === "exited", "native command finishes");
    assert.equal(processIdentityStatus(target.panel.process), "alive");
    const buffer = await fixture.buffer(target);
    await fixture.evaluate(`(progn (setq pi-panel-native-close-result nil) (pi-orchestration-stop-target ${JSON.stringify(target.id)} (lambda (error) (setq pi-panel-native-close-result (list :done t :error error)))) nil)`);
    await until(async () => !!await fixture.evaluate("(plist-get pi-panel-native-close-result :done)"), "sidebar Close callback settles");
    assert.equal(await fixture.evaluate("(plist-get pi-panel-native-close-result :error)"), null);
    assert.equal(processIdentityStatus(target.panel.process), "dead");
    assert.equal(await fixture.exists(target), false);
    assert.equal(await fixture.evaluate(`(if (get-buffer ${JSON.stringify(buffer)}) t :json-false)`), false);
  } finally { await fixture.cleanup(); }
});

test("isolated Emacs creator death before activation never starts unregistered work", nativeOptions, async () => {
  const fixture = await nativeFixture();
  const creator = spawn(process.execPath, [creatorFixture], { env: fixture.env, stdio: ["pipe", "ignore", "ignore"] });
  await once(creator, "spawn");
  try {
    const identity = readProcessIdentity(creator.pid!);
    assert.ok(identity);
    const marker = path.join(fixture.directory, "never-started");
    const target = await fixture.start("held", ["/bin/sh", "-c", 'printf orphan > "$1"', "panel-fixture", marker], identity);
    assert.ok(target.panel?.process);
    assert.equal(savedPanelState(target.panel)?.command, "held");
    const exited = once(creator, "close");
    creator.kill("SIGTERM");
    await exited;
    await until(() => savedPanelState(target.panel!)?.closed === true
      && processIdentityStatus(target.panel!.process!) === "dead", "held wrapper cleans itself after exact creator death");
    assert.equal(fs.existsSync(marker), false);
    await fixture.host.close(target);
    assert.equal(await fixture.exists(target), false);
  } finally {
    if (creator.exitCode === null && creator.signalCode === null) {
      const exited = once(creator, "close"); creator.kill("SIGTERM"); await exited;
    }
    await fixture.cleanup();
  }
});
