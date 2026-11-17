import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test, { after, before } from "node:test";
import type { ExecOptions, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { capturedArgv, GDB_COMMAND, PROMPT_INTEGRATION } from "../panel-output.ts";
import { removeTarget } from "../workers.ts";
import panelsExtension from "./panels.ts";
import waitExtension from "./wait.ts";

const run = promisify(execFile);
function has(command: string): boolean {
  try { execFileSync("/bin/sh", ["-c", `command -v ${command}`], { stdio: "ignore" }); return true; }
  catch { return false; }
}
const fishMajor = has("fish") ? Number(/(\d+)\./.exec(execFileSync("fish", ["--version"], { encoding: "utf8" }))?.[1] ?? 0) : 0;
/** Herdr runs the same tests natively when explicitly requested from inside a Herdr pane. */
const herdr = process.env.PI_NATIVE_HOST_SMOKE === "1" && process.env.HERDR_ENV === "1" && !!process.env.HERDR_SOCKET_PATH && !!process.env.HERDR_PANE_ID;
/** PI_NATIVE_HOST_SMOKE=emacs runs them on ghostel panels in a disposable Emacs daemon. */
const emacs = process.env.PI_NATIVE_HOST_SMOKE === "emacs";
const emacsFixture = fileURLToPath(new URL("../test/emacs-host.el", import.meta.url));
/** A short panel-send grace keeps tests of running commands quick. */
const GRACE_MS = 1500;
const skip = process.platform !== "linux" || !has("script") || (emacs ? !has("emacs") : !herdr && !has("tmux"))
  ? "requires Linux, tmux, Herdr or Emacs, and util-linux script" : false;

interface Structured { output: string; truncated: boolean; state: string; exit_code?: number; matched_line?: string; wall_time_seconds: number; warning?: string; name?: string; host?: string }
interface Result { content: Array<{ type: string; text: string }>; structuredContent: Structured }
type Execute = (id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, update: undefined, ctx: ExtensionContext) => Promise<Result>;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-wait-test-"));
const endpoint = herdr ? process.env.HERDR_SOCKET_PATH! : path.join(dir, emacs ? "emacs.sock" : "tmux.sock");
const agentDir = path.join(dir, "agent");
const envKeys = ["PI_ORCHESTRATION_HOST", "PI_ORCHESTRATION_ENDPOINT", "TMUX_PANE", "TMUX", "PI_CODING_AGENT_DIR", "HERDR_ENV"];
const previous = envKeys.map((key) => process.env[key]);
const tools = new Map<string, Execute>();
const names: string[] = [];
const pi = {
  registerTool: (tool: { name: string; execute: Execute }) => tools.set(tool.name, tool.execute),
  registerCommand: () => undefined,
  async exec(command: string, args: string[], options: ExecOptions = {}) {
    try {
      return { ...await run(command, args, { timeout: options.timeout, signal: options.signal }), code: 0, killed: false };
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string; code?: number; killed?: boolean };
      return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? failure.message, code: typeof failure.code === "number" ? failure.code : 1, killed: failure.killed ?? false };
    }
  },
} as unknown as ExtensionAPI;
const notifications: string[] = [];
const ctx = { cwd: dir, isProjectTrusted: () => false, hasUI: true, ui: { notify: (text: string) => notifications.push(text) } } as unknown as ExtensionContext;
const call = (tool: string, params: Record<string, unknown>, signal?: AbortSignal) => tools.get(tool)!("call", params, signal, undefined, ctx);

before(async () => {
  if (skip) return;
  fs.mkdirSync(agentDir);
  if (herdr) {
    Object.assign(process.env, { PI_ORCHESTRATION_HOST: "herdr", PI_ORCHESTRATION_ENDPOINT: endpoint, PI_CODING_AGENT_DIR: agentDir });
    panelsExtension(pi, GRACE_MS);
    waitExtension(pi);
    return;
  }
  if (emacs) {
    await run("emacs", ["-Q", `--daemon=${endpoint}`, "-l", emacsFixture], { timeout: 60_000 });
    Object.assign(process.env, { PI_ORCHESTRATION_HOST: "emacs", PI_ORCHESTRATION_ENDPOINT: endpoint, PI_CODING_AGENT_DIR: agentDir });
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
    delete process.env.HERDR_ENV;
    panelsExtension(pi, GRACE_MS);
    waitExtension(pi);
    return;
  }
  await run("tmux", ["-S", endpoint, "-f", "/dev/null", "new-session", "-d", "-s", "wait", "-x", "120", "-y", "30"]);
  const pane = (await run("tmux", ["-S", endpoint, "display-message", "-p", "-t", "wait", "#{pane_id}"])).stdout.trim();
  Object.assign(process.env, { PI_ORCHESTRATION_HOST: "tmux", PI_ORCHESTRATION_ENDPOINT: endpoint, TMUX_PANE: pane, PI_CODING_AGENT_DIR: agentDir });
  delete process.env.TMUX;
  delete process.env.HERDR_ENV;
  panelsExtension(pi, GRACE_MS);
  waitExtension(pi);
});
after(async () => {
  for (const name of names) await call("panel-close", { name }).catch(() => removeTarget(name));
  if (!skip && emacs) await run("emacsclient", ["--socket-name", endpoint, "--eval", "(kill-emacs)"]).catch(() => undefined);
  else if (!skip && !herdr) await run("tmux", ["-S", endpoint, "kill-server"]).catch(() => undefined);
  envKeys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
  fs.rmSync(dir, { recursive: true, force: true });
});

let next = 0;
async function panel(command: string): Promise<string> {
  const name = `wait-test-${process.pid % 10000}-${next++}`;
  names.push(name);
  await call("panel-start", { name, command });
  return name;
}

/** A new shell may print its first prompt before or during the wait. */
async function prompted(name: string): Promise<void> {
  const ready = await call("wait", { panel: name, timeoutSeconds: 20 });
  assert.ok(["prompt", "idle"].includes(ready.structuredContent.state), ready.content[0].text);
}

/** The fields codemode scripts receive, without the elapsed time and panel identity. */
function fields(result: Result): Omit<Structured, "wall_time_seconds" | "name" | "host"> {
  const { wall_time_seconds: elapsed, name: _name, host: _host, ...rest } = result.structuredContent;
  assert.equal(typeof elapsed, "number");
  return rest;
}

test("bash with the integration file reports finished commands, their status, and idle prompts", { skip, timeout: 60_000 }, async () => {
  const name = await panel(`exec bash --rcfile ${PROMPT_INTEGRATION.bash} -i`);
  await prompted(name);

  const idle = await call("wait", { panel: name, timeoutSeconds: 20 });
  assert.equal(idle.structuredContent.state, "idle", "an idle shell answers immediately as idle");
  assert.deepEqual([idle.structuredContent.name, idle.structuredContent.host], [name, herdr ? "herdr" : emacs ? "emacs" : "tmux"],
    "panel waits name their panel and host");

  const quick = await call("panel-send", { name, text: "printf 'one\\ttab\\n\\ntwo\\n'; (exit 4)" });
  assert.deepEqual(fields(quick), { output: "one\ttab\n\ntwo", truncated: false, state: "finished", exit_code: 4 },
    "only the command's own output, without its echoed line or the next prompt");
  assert.equal(quick.structuredContent.name, name);
  assert.equal(quick.content[0].text, "one\ttab\n\ntwo\n\nExit code 4.", "the payload comes first, without an identity header");
  const read = await call("panel-read", { name });
  assert.equal(read.structuredContent.state, "idle", "panel-read tells an idle shell from a running command");
  const after = await call("wait", { panel: name, match: "never", timeoutSeconds: 20 });
  assert.deepEqual(fields(after), { output: "", truncated: false, state: "idle", exit_code: 4 },
    "a later wait, even with match, answers immediately as idle with the last exit code, without repeating output");
  assert.match(after.content[0].text, /^Already idle at the prompt \(last exit code 4\) after \d+s\.$/);

  const empty = await call("panel-send", { name, text: "true" });
  assert.deepEqual(fields(empty), { output: "", truncated: false, state: "finished", exit_code: 0 });
  assert.equal(empty.content[0].text, "(no output)");

  const slow = await call("panel-send", { name, text: "echo begun; sleep 2.5; echo slept" });
  assert.deepEqual(fields(slow), { output: "begun", truncated: false, state: "running" }, "output so far, not the screen");
  assert.match(slow.content[0].text, /^begun\n\nStill running after \d+(\.\d)?s; use wait to follow it\.$/);
  assert.equal((await call("panel-read", { name })).structuredContent.state, "running");
  const startedAt = Date.now();
  const finished = await call("wait", { panel: name, timeoutSeconds: 20 });
  assert.deepEqual(fields(finished), { output: "slept", truncated: false, state: "prompt", exit_code: 0 },
    "only output panel-send did not already return");
  assert.ok(Date.now() - startedAt >= 500, "the wait lasted until the command finished");

  // The steps start after the grace, so panel-send returns none of them.
  const steps = await call("panel-send", { name, text: "sleep 2; for i in 1 2 3; do echo step-$i; sleep 0.8; done" });
  assert.deepEqual([steps.structuredContent.state, steps.structuredContent.output], ["running", ""]);
  const first = await call("wait", { panel: name, match: "^step-2$", timeoutSeconds: 20 });
  assert.deepEqual(fields(first), { output: "step-1\nstep-2", truncated: false, state: "matched", matched_line: "step-2" });
  const second = await call("wait", { panel: name, match: "^step-", timeoutSeconds: 20 });
  assert.deepEqual(fields(second), { output: "step-3", truncated: false, state: "matched", matched_line: "step-3" }, "a later wait continues after the previous match");
  assert.equal((await call("wait", { panel: name, timeoutSeconds: 20 })).structuredContent.state, "prompt");

  assert.equal((await call("panel-send", { name, text: "sleep 2; printf 'x-1\\nx-2\\n'; sleep 3" })).structuredContent.state, "running");
  const one = await call("wait", { panel: name, match: "^x-1$", timeoutSeconds: 20 });
  assert.deepEqual([one.structuredContent.state, one.structuredContent.output], ["matched", "x-1"]);
  const two = await call("wait", { panel: name, match: "^x-2$", timeoutSeconds: 20 });
  assert.deepEqual([two.structuredContent.state, two.structuredContent.output], ["matched", "x-2"],
    "a line that arrived with the previous match is still output for the next wait");
  assert.equal((await call("wait", { panel: name, timeoutSeconds: 20 })).structuredContent.state, "prompt");

  const quiet = await call("panel-send", { name, text: "stty -echo; read answer; stty echo; timeout 1 tail -f /dev/null; echo first; echo second" });
  assert.equal(quiet.structuredContent.state, "running");
  assert.equal((await call("panel-send", { name, keys: ["a", "Enter"] })).structuredContent.output, "", "unechoed keys print nothing");
  const answered = await call("wait", { panel: name, timeoutSeconds: 20 });
  assert.deepEqual([answered.structuredContent.state, answered.structuredContent.output], ["prompt", "first\nsecond"],
    "keys start no command, so no first line is dropped as an echoed command line");

  assert.equal((await call("panel-send", { name, text: "sleep 30" })).structuredContent.state, "running");
  const keys = await call("panel-send", { name, keys: ["ctrl+c"] });
  assert.equal(keys.structuredContent.state, "sent", "keys are not followed as a command");
  const interrupted = await call("wait", { panel: name, timeoutSeconds: 20 });
  assert.ok(["prompt", "idle"].includes(interrupted.structuredContent.state), interrupted.content[0].text);
  assert.equal(interrupted.structuredContent.exit_code, 130);
  assert.doesNotMatch(interrupted.structuredContent.output, /\^C/, "without the keys' output panel-send returned");
});

test("gdb with the integration file reports its prompt after commands and when the program stops", { skip: skip || ((!has("gdb") || !has("cc")) && "requires gdb and cc"), timeout: 60_000 }, async () => {
  const source = path.join(dir, "stop.c");
  fs.writeFileSync(source, "#include <unistd.h>\nint stop_here(int n) { return n; }\nint main(void) { usleep(2500000); return stop_here(7); }\n");
  const binary = path.join(dir, "stop");
  execFileSync("cc", ["-g", "-O0", "-o", binary, source]);
  const name = await panel(`exec ${GDB_COMMAND} ${binary}`);
  await prompted(name);

  const set = await call("panel-send", { name, text: "break stop_here" });
  assert.deepEqual([set.structuredContent.state, set.structuredContent.exit_code], ["finished", undefined], set.content[0].text);
  assert.match(set.structuredContent.output, /^Breakpoint 1 at .*stop\.c, line 2\.$/, "only the command's output, without its echoed line or the next prompt");

  const started = await call("panel-send", { name, text: "run" });
  assert.equal(started.structuredContent.state, "running", started.content[0].text);
  assert.doesNotMatch(started.structuredContent.output, /^run$/m, "without the echoed line");
  const stopped = await call("wait", { panel: name, timeoutSeconds: 20 });
  assert.equal(stopped.structuredContent.state, "prompt", stopped.content[0].text);
  assert.match(stopped.structuredContent.output, /Breakpoint 1, stop_here \(n=7\)/);

  const printed = await call("panel-send", { name, text: "print n * 2" });
  assert.equal(printed.structuredContent.state, "finished", printed.content[0].text);
  assert.equal(printed.content[0].text, "$1 = 14");
});

test("fish reports its prompt without configuration", { skip: skip || (fishMajor < 4 && "requires fish 4+"), timeout: 60_000 }, async () => {
  const name = await panel("exec fish --no-config -i");
  await prompted(name);
  const sent = await call("panel-send", { name, text: "sleep 0.5; false" });
  assert.deepEqual(fields(sent), { output: "", truncated: false, state: "finished", exit_code: 1 }, sent.content[0].text);
  assert.equal(sent.content[0].text, "Exit code 1.");
  const finished = await call("wait", { panel: name, timeoutSeconds: 20 });
  assert.deepEqual([finished.structuredContent.state, finished.structuredContent.exit_code], ["idle", 1]);
  const empty = await call("panel-send", { name, text: "" });
  assert.deepEqual(fields(empty), { output: "", truncated: false, state: "finished" }, "an empty line ends at the next prompt");
  assert.equal(empty.content[0].text, "(no output)");
});

test("a nested marked shell, as over ssh, ends the line that starts it and reports its own commands", { skip: skip || (fishMajor < 4 && "requires fish 4+"), timeout: 60_000 }, async () => {
  const name = await panel("exec fish --no-config -i");
  await prompted(name);
  const login = await call("panel-send", { name, text: `bash --rcfile ${PROMPT_INTEGRATION.bash} -i` });
  assert.equal(login.structuredContent.state, "finished", "the nested shell's first prompt ends the line");
  const inner = await call("panel-send", { name, text: "printf 'α\\nβ\\n'" });
  assert.deepEqual(fields(inner), { output: "α\nβ", truncated: false, state: "finished", exit_code: 0 }, inner.content[0].text);
  assert.equal(inner.content[0].text, "α\nβ");
  const logout = await call("panel-send", { name, text: "exit 3" });
  assert.deepEqual([logout.structuredContent.state, logout.structuredContent.exit_code], ["finished", 3], "the outer shell reports the nested shell's exit");
});

test("text sent into an unmarked program warns once to the user and in every result, until marks return", { skip: skip || (fishMajor < 4 && "requires fish 4+"), timeout: 60_000 }, async () => {
  const name = await panel("exec fish --no-config -i");
  await prompted(name);
  const inner = await call("panel-send", { name, text: "bash --norc --noprofile -i" });
  assert.equal(inner.structuredContent.state, "running", "an unmarked program never reports its prompt");
  assert.doesNotMatch(inner.content[0].text, /Warning:/, "the marked shell received the command");
  for (const text of ["echo one", "echo two"]) {
    const sent = await call("panel-send", { name, text });
    assert.equal(sent.structuredContent.state, "sent");
    assert.match(sent.structuredContent.output, new RegExp(`^${text.split(" ")[1]}$`, "m"), "output since the input");
    assert.match(sent.structuredContent.warning ?? "", /^Warning: Input goes to `bash --norc --noprofile -i`, which shows no OSC 133 prompt marks/);
    assert.ok(sent.content[0].text.endsWith(`\n\n${sent.structuredContent.warning}`), "the model sees the warning after the output");
  }
  assert.equal(notifications.length, 1, "the user is told once per running program");
  const keys = await call("panel-send", { name, keys: ["ctrl+u"] });
  assert.doesNotMatch(keys.content[0].text, /Warning:/, "keys are not commands to wait for");
  assert.equal(keys.structuredContent.warning, undefined);
  await call("panel-send", { name, text: "exit" });
  await prompted(name);
  const back = await call("panel-send", { name, text: "true" });
  assert.equal(back.structuredContent.state, "finished");
  assert.doesNotMatch(back.content[0].text, /Warning:/);
});

test("command panels end on exit with status and match output printed before the wait", { skip, timeout: 60_000 }, async () => {
  const server = await panel("echo listening on 8080; sleep 30");
  await delay(800);
  const listening = await call("wait", { panel: server, match: "listening on \\d+", timeoutSeconds: 20 });
  assert.equal(listening.structuredContent.state, "matched", "output since the panel started counts");
  assert.match(listening.structuredContent.output, /listening on 8080$/);

  const build = await panel("echo compiling; sleep 1; echo done; exit 3");
  const exited = await call("wait", { panel: build, match: "^FAIL", timeoutSeconds: 20 });
  assert.deepEqual([exited.structuredContent.state, exited.structuredContent.exit_code], ["exited", 3]);
  assert.match(exited.structuredContent.output, /compiling\ndone$/, "new output without the capture trailer");
  assert.match(exited.content[0].text, /done\n\nExited with code 3 after \d+s\.$/);
  const again = await call("wait", { panel: build, timeoutSeconds: 20 });
  assert.deepEqual([again.structuredContent.state, again.structuredContent.output], ["exited", ""], "an exited panel answers immediately");
  await assert.rejects(call("panel-send", { name: build, text: "echo again" }), /The command of panel '[^']+' exited with status 3; its output is no longer captured/);
  await assert.rejects(call("panel-send", { name: build, keys: ["ctrl+c"] }), /exited with status 3/);
  const read = await call("panel-read", { name: build });
  assert.match(read.content[0].text, /^(?![\s\S]*\[tmux\])[\s\S]*done/, "an exited panel's screen stays readable, without an identity header");
  assert.deepEqual([read.structuredContent.state, read.structuredContent.name], ["exited", build], "panel-read tells an exited panel from an idle shell");
  assert.match(read.structuredContent.output, /done/);
});

test("shells without prompt marks time out with an explanation instead of guessing", { skip, timeout: 60_000 }, async () => {
  const name = await panel("exec bash --norc --noprofile -i");
  await delay(500);
  await call("panel-send", { name, text: "echo hi" });
  const result = await call("wait", { panel: name, timeoutSeconds: 1 });
  assert.equal(result.structuredContent.state, "timeout");
  assert.match(result.structuredContent.warning ?? "", /Input goes to the panel's command, which has shown no OSC 133 prompt marks/);
  assert.match(result.content[0].text, /Timed out after 1s\.\n\nWarning: Input goes to the panel's command/);
  assert.match(result.content[0].text, new RegExp(PROMPT_INTEGRATION.bash.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("files match appended lines only, and pids end on exit", { skip, timeout: 30_000 }, async () => {
  const file = path.join(dir, "build.log");
  fs.writeFileSync(file, "FAIL old run\n");
  setTimeout(() => fs.appendFileSync(file, "pass a\nFAIL new run\n"), 300);
  const matched = await call("wait", { file: "build.log", match: "^FAIL", timeoutSeconds: 10 });
  assert.deepEqual(fields(matched), { output: "pass a\nFAIL new run", truncated: false, state: "matched", matched_line: "FAIL new run" }, "only appended lines, through the match");
  await assert.rejects(call("wait", { file, timeoutSeconds: 1 }), /needs match/);
  await assert.rejects(call("wait", { file: "missing.log", match: "x", timeoutSeconds: 1 }), /does not exist: .*missing\.log\. If a panel or process creates it, wait on that panel .* or pid instead/);
  await assert.rejects(call("wait", { file, match: "(", timeoutSeconds: 1 }), /Invalid match regex/);
  await assert.rejects(call("wait", { file, pid: 1, match: "x", timeoutSeconds: 1 }), /exactly one/);

  const child = spawn("sleep", ["0.5"]);
  const exited = await call("wait", { pid: child.pid, timeoutSeconds: 10 });
  assert.deepEqual(fields(exited), { output: "", truncated: false, state: "exited" }, "pid waits have no panel name or host");
  assert.equal("name" in exited.structuredContent, false);
  assert.match(exited.content[0].text, /^Exited after \d+s\.$/);
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 200);
  await assert.rejects(call("wait", { pid: process.pid, timeoutSeconds: 10 }, abort.signal), /abort/i);
});

test("the capture relay preserves the command's SHELL and exit status", { skip, timeout: 30_000 }, async () => {
  const log = path.join(dir, "relay.log");
  fs.writeFileSync(log, "");
  const argv = capturedArgv(["/bin/sh", "-c", 'printf "shell=%s\\n" "${SHELL-unset}"; exit 5'], log);
  const withShell = await run(argv[0], argv.slice(1), { env: { ...process.env, SHELL: "/usr/bin/fish" } }).catch((error: { code: number }) => error);
  assert.equal((withShell as { code: number }).code, 5);
  assert.match(fs.readFileSync(log, "utf8"), /shell=\/usr\/bin\/fish/);
  const env = { ...process.env };
  delete env.SHELL;
  await run(argv[0], argv.slice(1), { env }).catch(() => undefined);
  assert.match(fs.readFileSync(log, "utf8"), /shell=unset/);
});
