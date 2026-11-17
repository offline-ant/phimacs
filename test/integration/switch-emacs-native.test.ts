import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import test from "node:test";
import { createClaimTestEnvironment, lookupClaim } from "@phimacs/pimux/ownership";
import { processIdentityStatus, readProcessIdentity } from "@phimacs/pimux/process-identity";
import { startRuntime, stopRuntime, type RuntimeReceipt } from "@phimacs/pimux/runtime";
import { connectPeer, PI, startTestService, until, type SocketPeer } from "../../packages/pimux/test/harness.ts";
import { emacsHostFixture, requiredTestPath, switchExtension, switchNativeFixture } from "../support/assets.ts";

const exec = promisify(execFile);
const enabled = process.env.PI_SWITCH_EMACS_NATIVE === "1";
const lisp = (value: string): string => JSON.stringify(value);

interface View { buffer: string; muxId: string; piPid: number; input: string }

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await until(() => child.exitCode !== null || child.signalCode !== null, "test-owned child exited");
}

test("managed /switch emacs reuses one mux/Pi and cleans only a failed new attachment", { skip: !enabled, timeout: 180_000 }, async (t) => {
  const prepared = requiredTestPath("PHIMACS_TEST_EMACS_DIR");
  const pilish = path.resolve(import.meta.dirname, "../../emacs/pilish");
  for (const folder of [pilish, ...["elpa", "ghostel", "tree-sitter"].map(name => path.join(prepared, name))]) {
    assert.ok(fs.statSync(folder).isDirectory(), `Missing prepared test input: ${folder}`);
  }
  const isolation = createClaimTestEnvironment();
  const directory = isolation.root;
  const agent = path.join(directory, "agent");
  const home = path.join(directory, "home");
  const temporary = path.join(directory, "tmp");
  const socketDirectory = path.join(directory, "emacs");
  const socket = path.join(socketDirectory, "server");
  for (const folder of [agent, home, temporary, socketDirectory]) fs.mkdirSync(folder, { mode: 0o700 });
  fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({
    defaultProvider: "switch-native-fixture", defaultModel: "one", compaction: { enabled: false }, retry: { enabled: false },
  }), { mode: 0o600 });
  const sessionFile = path.join(isolation.sessions, "managed.jsonl");
  fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd: directory })}\n`, { mode: 0o600 });
  const env: NodeJS.ProcessEnv = { ...process.env, ...isolation.env, HOME: home, TMPDIR: temporary,
    PHIMACS_STATE_DIR: path.join(directory, "state"), PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: isolation.sessions,
    PHIMACS_PI: PI, ALTERNATE_EDITOR: "false", GDK_BACKEND: "x11", DISPLAY: "", WAYLAND_DISPLAY: "",
    // An absent private bus: GTK on the owned display autolaunches nothing.
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(directory, "no-session-bus")}`,
    PI_EMACS_ELPA: path.join(prepared, "elpa"), PI_EMACS_PILISH: pilish,
    PI_EMACS_GHOSTEL_MODULE: path.join(prepared, "ghostel"), PI_EMACS_GRAMMARS: path.join(prepared, "tree-sitter") };
  for (const key of Object.keys(env)) {
    if (key.startsWith("PI_ORCHESTRATION_") || key.startsWith("PHIMACS_PARENT_") || key === "PHIMACS_MANAGED_CLAIM"
      || key === "PIMUX_DISCOVERY" || key === "PI_REMOTE" || key === "PI_NESTED" || key === "EMACSLOADPATH"
      || key === "XAUTHORITY") delete env[key];
  }
  env.PI_ORCHESTRATION_HOST = "emacs";
  env.PI_ORCHESTRATION_ENDPOINT = socket;
  let display: ChildProcess | undefined;
  let daemon: ChildProcess | undefined;
  let service: ChildProcess | undefined;
  let receipt: RuntimeReceipt | undefined;
  let peer: SocketPeer | undefined;
  let diagnostic = "";
  t.after(async () => {
    peer?.socket.destroy();
    const errors: unknown[] = [];
    if (receipt) { try { await stopRuntime(receipt.muxId, { env }); } catch (error) { errors.push(error); } }
    for (const child of [daemon, service, display]) { try { await stopChild(child); } catch (error) { errors.push(error); } }
    if (!errors.length) fs.rmSync(directory, { recursive: true, force: true });
    if (errors.length) throw new AggregateError(errors, `Owned switch fixture cleanup failed; evidence retained at ${directory}`);
  });
  display = spawn(process.env.PHIMACS_TEST_XVFB || "Xvfb", ["-displayfd", "1", "-screen", "0", "1024x768x24", "-nolisten", "tcp"], {
    env, stdio: ["ignore", "pipe", "pipe"],
  });
  display.stderr!.on("data", chunk => { diagnostic += chunk.toString(); });
  const displayNumber = await new Promise<string>((resolve, reject) => {
    const input = createInterface({ input: display!.stdout! });
    input.once("line", line => { input.close(); /^\d+$/.test(line) ? resolve(line) : reject(new Error(`Invalid Xvfb display: ${line}`)); });
    display!.once("error", reject);
    display!.once("exit", () => reject(new Error(`Owned Xvfb exited before readiness: ${diagnostic}`)));
  });
  env.DISPLAY = `:${displayNumber}`;
  const pimux = path.resolve(import.meta.dirname, "../../packages/pimux/bin/pimux");
  daemon = spawn("emacs", ["-Q", `--fg-daemon=${socket}`, `--init-directory=${path.join(directory, "emacs-init")}`,
    "-l", emacsHostFixture,
    "--eval", `(progn (setq native-comp-jit-compilation nil pilish-essential-grammar-action 'warn)
      (pilish-configure-runtime :pi-executable ${lisp(PI)} :pimux-executable ${lisp(pimux)})
      (make-frame-on-display (getenv "DISPLAY") '((visibility . nil))))`], { env, cwd: directory, stdio: ["ignore", "pipe", "pipe"] });
  daemon.stdout!.on("data", chunk => { diagnostic += chunk.toString(); });
  daemon.stderr!.on("data", chunk => { diagnostic += chunk.toString(); });
  await until(() => { assert.equal(daemon!.exitCode, null, diagnostic); return fs.existsSync(socket); }, "private Emacs server ready", 60_000);
  const emacs = async (expression: string): Promise<string> => {
    const result = await exec("emacsclient", ["--alternate-editor=false", "--socket-name", socket, "--eval", expression], { env, timeout: 10_000 });
    return result.stdout.trim();
  };
  const views = async (): Promise<View[]> => {
    const result = await emacs(`(json-encode (vconcat (delq nil (mapcar
      (lambda (buffer) (when (eq (buffer-local-value 'major-mode buffer) 'pilish-chat-mode)
        (let* ((runtime (pilish-session-runtime buffer)) (input (pilish-session-input-buffer buffer)))
          (list :buffer (buffer-name buffer) :muxId (plist-get runtime :mux-id) :piPid (plist-get runtime :pi-pid)
                :input (if (buffer-live-p input) (with-current-buffer input (buffer-string)) ""))))) (buffer-list)))))`);
    return JSON.parse(JSON.parse(result) as string) as View[];
  };
  service = await startTestService(t, { dir: directory, env });
  receipt = await startRuntime({ command: PI, cwd: directory, env, args: ["--mode", "rpc", "--session", sessionFile,
    "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--provider", "switch-native-fixture", "--model", "one",
    "-e", switchExtension, "-e", switchNativeFixture] });
  peer = await connectPeer(receipt);
  const identity = readProcessIdentity(receipt.piPid)!;
  const token = lookupClaim(sessionFile, isolation.options)!.token;
  const bytes = fs.readFileSync(sessionFile, "utf8");
  const attach = async (expected: RegExp): Promise<void> => {
    const mark = peer!.mark();
    const response = await peer!.request({ type: "prompt", message: "/switch emacs" });
    assert.equal(response.success, true);
    const notice = await peer!.waitFor(record => record.type === "extension_ui_request" && typeof record.message === "string" && expected.test(record.message), "switch result notification", mark);
    assert.match(String(notice.message), expected);
  };
  await attach(/attached buffer/);
  const first = (await views())[0]!;
  assert.equal(first.muxId, receipt.muxId);
  assert.equal(first.piPid, receipt.piPid);
  await emacs(`(with-current-buffer (pilish-session-input-buffer (get-buffer ${lisp(first.buffer)})) (insert "keep this draft"))`);
  await attach(/attached buffer/);
  assert.deepEqual(await views(), [{ ...first, input: "keep this draft" }], "repeat attachment reuses the existing view and draft");
  assert.equal(processIdentityStatus(identity), "alive");
  assert.equal(lookupClaim(sessionFile, isolation.options)!.token, token);
  assert.equal(fs.readFileSync(sessionFile, "utf8"), bytes);

  // Dispose only the view, then make a new attachment fail before readiness.
  await emacs(`(pilish-disconnect-session (get-buffer ${lisp(first.buffer)}))`);
  assert.deepEqual(await views(), []);
  await emacs(`(progn (defun pi-switch-test-unavailable (runtime)
    (when runtime (plist-put (copy-sequence runtime) :state "unavailable")))
    (advice-add 'pilish-session-runtime :filter-return #'pi-switch-test-unavailable))`);
  await attach(/Emacs switch failed/);
  await emacs("(advice-remove 'pilish-session-runtime #'pi-switch-test-unavailable)");
  assert.deepEqual(await views(), [], "failed startup disposes only its newly allocated view");
  assert.equal(processIdentityStatus(identity), "alive", "failed attachment does not stop the source Pi");
  assert.equal(lookupClaim(sessionFile, isolation.options)!.token, token);
  assert.equal(fs.readFileSync(sessionFile, "utf8"), bytes);
  await attach(/attached buffer/);
  assert.equal((await views())[0]!.piPid, receipt.piPid, "explicit retry still attaches the original Pi");
  const trace = fs.readFileSync(path.join(directory, "switch-trace.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as { event: string });
  assert.deepEqual(trace.map(entry => entry.event), ["start"], "switching neither reloads nor runs inference");
});
