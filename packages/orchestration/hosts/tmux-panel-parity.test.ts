import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HostTarget } from "../host-types.ts";
import { activatePanel } from "../panel-runtime.ts";
import { terminalArgv, verifyTerminalParity, type TerminalSize } from "../test/panel-terminal-parity.ts";
import { createTmuxHost } from "./tmux.ts";

const execute = promisify(execFile);
const api: Pick<ExtensionAPI, "exec"> = {
  async exec(command, args, options) {
    try {
      const result = await execute(command, args, options);
      return { stdout: result.stdout.toString(), stderr: result.stderr.toString(), code: 0, truncated: false, killed: false };
    } catch (error) {
      const failure = error as Error & { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };
      return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? failure.message, code: typeof failure.code === "number" ? failure.code : 1, truncated: failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: failure.killed === true };
    }
  },
};

test("disposable tmux preserves native geometry, SIGWINCH, fullscreen redraw and raw keyboard bytes", { timeout: 20_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "panel-tmux-parity-"));
  const endpoint = path.join(directory, "server.sock");
  const tmux = async (args: string[]): Promise<string> => (await execute("tmux", ["-S", endpoint, ...args], { timeout: 5000 })).stdout;
  let target: HostTarget | undefined;
  const host = createTmuxHost(api, endpoint);
  let started = false;
  try {
    await tmux(["-f", "/dev/null", "new-session", "-d", "-s", "parity", "-x", "111", "-y", "36", "/bin/sh", "-c", "read value"]);
    started = true;
    const parentId = (await tmux(["display-message", "-p", "-t", "parity", "#{pane_id}"])).trim();
    const events = path.join(directory, "terminal-events.jsonl");
    target = await host.start({ kind: "shell", name: "terminal-parity", cwd: directory, argv: terminalArgv(events),
      placement: "worker", parent: { host: "tmux", endpoint, id: parentId, name: "parent", kind: "pi" } });
    assert.ok(target.panel?.process);
    const id = target.id;
    await tmux(["set-option", "-w", "-t", id, "window-size", "manual"]);
    await tmux(["resize-window", "-t", id, "-x", "111", "-y", "36"]);
    await activatePanel(target.panel);
    await verifyTerminalParity({
      binding: target.panel,
      events,
      capture: () => tmux(["capture-pane", "-p", "-t", id]),
      resize: async (size: TerminalSize) => { await tmux(["resize-window", "-t", id, "-x", String(size.columns), "-y", String(size.rows)]); },
      text: async value => { await tmux(["send-keys", "-t", id, "-l", "--", value]); },
      keys: async keys => { await tmux(["send-keys", "-t", id, ...keys.map(key => key.replace(/^ctrl\+/, "C-"))]); },
    }, { rows: 41, columns: 129 });
  } finally {
    const failures: unknown[] = [];
    try { if (target) await host.close(target); } catch (error) { failures.push(error); }
    try { if (started) await tmux(["kill-server"]); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, `Native parity cleanup uncertain; retained ${directory}`);
    if (target?.panel) fs.rmSync(target.panel.directory, { recursive: true, force: true });
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
