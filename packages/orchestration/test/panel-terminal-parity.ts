import assert from "node:assert/strict";
import * as fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { processIdentityStatus } from "@phimacs/pimux/process-identity";
import { panelStatus, type PanelBinding } from "../panel-runtime.ts";

const execute = promisify(execFile);
const fixture = fileURLToPath(new URL("./panel-terminal-fixture.py", import.meta.url));
export const terminalArgv = (events: string): string[] => ["uv", "run", "--no-project", "--offline", "python", fixture, "--events", events];
export interface TerminalSize { rows: number; columns: number }
interface TerminalEvent extends TerminalSize { event: string; hex?: string; echo?: boolean; signal?: string }
export interface NativeTerminal {
  binding: PanelBinding;
  events: string;
  capture(): Promise<string>;
  resize(size: TerminalSize): Promise<void>;
  text(value: string): Promise<void>;
  keys(keys: string[]): Promise<void>;
}
function events(file: string): TerminalEvent[] {
  if (!fs.existsSync(file)) return [];
  const bytes = fs.readFileSync(file, "utf8");
  return bytes.slice(0, bytes.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map(line => JSON.parse(line) as TerminalEvent);
}
async function until(predicate: () => boolean | Promise<boolean>, message: string, timeoutMs = 2500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, message);
    await delay(15);
  }
}
export async function nativeTerminalSize(binding: PanelBinding): Promise<TerminalSize> {
  assert.ok(binding.process);
  const result = await execute("uv", ["run", "--no-project", "--offline", "python", fixture, "--size", `/proc/${binding.process.pid}/fd/0`], { timeout: 5000 });
  return JSON.parse(result.stdout) as TerminalSize;
}

/** Collect independent parity failures so the baseline demonstrates dimensions,
 * SIGWINCH and echo defects rather than stopping at the first missing size. */
export async function verifyTerminalParity(native: NativeTerminal, resized: TerminalSize): Promise<void> {
  const failures: string[] = [];
  const check = async (label: string, verify: () => void | Promise<void>): Promise<void> => {
    try { await verify(); } catch (error) { failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
  };
  await until(() => events(native.events).some(event => event.event === "echo-ready"), "terminal fixture reached canonical input");
  const initial = await nativeTerminalSize(native.binding);
  assert.ok(initial.rows > 0 && initial.columns > 0);
  assert.notDeepEqual(initial, { rows: 24, columns: 80 }, "native fixture must exercise nondefault geometry");
  const ready = events(native.events).find(event => event.event === "echo-ready")!;
  await check("initial ioctl size", () => assert.deepEqual({ rows: ready.rows, columns: ready.columns }, initial));
  await check("initial ECHO", () => assert.equal(ready.echo, true));
  await until(async () => (await native.capture()).includes("ECHO_READY"), "native terminal renders canonical output");
  await native.text("native_echo_42");
  await check("canonical native echo before Enter", () => until(async () => (await native.capture()).includes("native_echo_42"), "native terminal did not echo input before Enter", 1500));
  await native.keys(["Enter"]);
  await until(() => events(native.events).some(event => event.event === "raw-ready"), "raw fixture starts after native Enter");
  await check("initial fullscreen redraw", () => until(async () => {
    const screen = await native.capture();
    return screen.includes(`FULLSCREEN rows=${initial.rows} cols=${initial.columns}`) && screen.includes("MARK:initial");
  }, "native alternate screen does not match initial geometry", 1500));
  await native.text("x");
  await until(() => events(native.events).filter(event => event.event === "bytes").map(event => event.hex).join("") === "78", "raw native byte reaches child without Enter");
  await native.keys(["Up", "ctrl+c"]);
  await until(() => events(native.events).filter(event => event.event === "bytes").map(event => event.hex).join("") === "781b5b4103", "native arrows and raw Ctrl+C arrive unchanged");
  assert.equal(processIdentityStatus(native.binding.process!), "alive", "raw child consuming Ctrl+C must not kill the owner");
  assert.equal((await panelStatus(native.binding)).command, "running", "raw Ctrl+C must reach the child rather than signal the wrapper");
  await native.resize(resized);
  assert.deepEqual(await nativeTerminalSize(native.binding), resized, "native resize itself reached the outer PTY");
  await check("resize SIGWINCH and ioctl size", () => until(() => events(native.events).some(event => event.event === "resize"
    && event.signal === "SIGWINCH" && event.rows === resized.rows && event.columns === resized.columns),
  `inner terminal did not receive SIGWINCH/${JSON.stringify(resized)}; events=${JSON.stringify(events(native.events))}`, 1500));
  await check("resized fullscreen redraw", () => until(async () => {
    const screen = await native.capture();
    return screen.includes(`FULLSCREEN rows=${resized.rows} cols=${resized.columns}`) && screen.includes("MARK:winch")
      && !screen.includes(`FULLSCREEN rows=${initial.rows} cols=${initial.columns}`);
  }, "native alternate screen retained stale dimensions or lost the redraw", 1500));
  assert.deepEqual(failures, [], `Native panel parity failures:\n${failures.join("\n")}`);
}
