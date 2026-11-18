import * as fs from "node:fs";
import * as net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { processIdentityStatus, readProcessIdentity, sameProcessIdentity, type ProcessIdentity } from "@phimacs/pimux/process-identity";
import { isProcessIdentity } from "./parent-task.ts";
import { panelFile, readPanelConfig, writePanelState, type PanelBinding, type PanelInput, type PanelState } from "./panel-runtime.ts";
import { validateNativeSocket } from "./hosts/native-surface.ts";
import { capturedArgv } from "./panel-output.ts";
import { serverGone } from "./hosts/server-socket.ts";

export function panelKeyBytes(key: string): string {
  const parts = key.split("+");
  const name = parts.pop()!;
  const modifiers = parts.map(part => part.toLowerCase());
  if (modifiers.some(part => !["ctrl", "control", "alt", "shift"].includes(part))) throw new Error(`Unsupported panel key: ${key}`);
  let value: string;
  const names: Record<string, string> = { enter: "\r", return: "\r", escape: "\x1b", esc: "\x1b", tab: "\t", space: " ", backspace: "\x7f", delete: "\x1b[3~", insert: "\x1b[2~", up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", home: "\x1b[H", end: "\x1b[F", pageup: "\x1b[5~", pagedown: "\x1b[6~" };
  const functions = ["OP", "OQ", "OR", "OS", "[15~", "[17~", "[18~", "[19~", "[20~", "[21~", "[23~", "[24~"];
  if (name.length === 1) value = modifiers.includes("shift") ? name.toUpperCase() : name;
  else if (/^f(?:[1-9]|1[012])$/i.test(name)) value = `\x1b${functions[Number(name.slice(1)) - 1]}`;
  else if (names[name.toLowerCase()]) value = names[name.toLowerCase()];
  else throw new Error(`Unsupported panel key: ${key}`);
  const control = modifiers.includes("ctrl") || modifiers.includes("control");
  const modifier = 1 + (modifiers.includes("shift") ? 1 : 0) + (modifiers.includes("alt") ? 2 : 0) + (control ? 4 : 0);
  if (modifier > 1 && /^\x1b\[[A-DFH]$/.test(value)) return `\x1b[1;${modifier}${value.at(-1)}`;
  if (modifier > 1 && /^\x1b\[\d+~$/.test(value)) return `${value.slice(0, -1)};${modifier}~`;
  if (modifier > 1 && /^\x1bO[P-S]$/.test(value)) return `\x1b[1;${modifier}${value.at(-1)}`;
  if (control && name.toLowerCase() === "backspace") value = "\b";
  else if (control && name.toLowerCase() === "enter") value = "\n";
  else if (control) {
    if (value.length !== 1 || !/^[\x20-\x7f]$/.test(value)) throw new Error(`Unsupported panel control chord: ${key}`);
    value = value === "?" ? "\x7f" : String.fromCharCode(value.toUpperCase().charCodeAt(0) & 31);
  } else if (modifiers.includes("shift") && value === "\t") value = "\x1b[Z";
  if (modifiers.includes("alt")) value = `\x1b${value}`;
  return value;
}
/** Parent PID and controlling terminal (`tty_nr`, 0 for none) of PID, or undefined once it is gone. */
function processLinks(pid: number): { parent: number; terminal: number } | undefined {
  let stat: string;
  try { stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  // Fields after the parenthesized command: state, ppid, pgrp, session, tty_nr.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return { parent: Number(fields[1]), terminal: Number(fields[4]) };
}
/** User name (else `uid N`) of PID's real user, or undefined once it is gone. */
function processUser(pid: number): string | undefined {
  let status: string;
  try { status = fs.readFileSync(`/proc/${pid}/status`, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const uid = /^Uid:\s+(\d+)/m.exec(status)?.[1];
  const entry = fs.readFileSync("/etc/passwd", "utf8").split("\n").find(line => line.split(":")[2] === uid);
  return entry?.split(":")[0] ?? `uid ${uid}`;
}
function descendants(identity: ProcessIdentity, owned: Map<number, ProcessIdentity>, terminals: Set<number>): void {
  if (processIdentityStatus(identity) !== "alive") return;
  try {
    const children = fs.readFileSync(`/proc/${identity.pid}/task/${identity.pid}/children`, "utf8").trim().split(/\s+/);
    if (processIdentityStatus(identity) !== "alive") return;
    for (const pid of children) {
      if (!pid) continue;
      const child = readProcessIdentity(Number(pid));
      const previous = child ? owned.get(child.pid) : undefined;
      if (child && (!previous || !sameProcessIdentity(previous, child))) {
        owned.set(child.pid, child);
        const terminal = processLinks(child.pid)?.terminal;
        if (terminal) terminals.add(terminal);
        descendants(child, owned, terminals);
      }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
async function runNative(command: string, args: string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", diagnostics = "";
    child.stdout.on("data", chunk => { output = (output + chunk.toString()).slice(-65536); });
    child.stderr.on("data", chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-65536); });
    const timer = setTimeout(() => child.kill(), 5000);
    child.once("error", reject);
    child.once("close", code => { clearTimeout(timer); if (code === 0) resolve(output); else reject(new Error(diagnostics || `Native panel cleanup exited ${code}`)); });
  });
}

export async function runPanelRuntime(binding: PanelBinding): Promise<void> {
  const config = readPanelConfig(binding);
  const identity = readProcessIdentity(process.pid);
  if (!identity) throw new Error("Cannot establish panel wrapper identity");
  const exact = { ...binding, process: identity };
  const nativeServer = config.native.kind === "tmux" ? readProcessIdentity(Number(process.env.TMUX?.split(",")[1])) : undefined;
  const state: PanelState = { schema: 1, id: binding.id, process: identity, command: "held", closed: false };
  let child: ChildProcess | undefined;
  let childIdentity: ProcessIdentity | undefined;
  let childClosed: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let cleanupFailed = false;
  let terminalFd: number | undefined;
  const terminalSize = (): { rows: number; columns: number } | undefined => {
    if (!process.stdout.isTTY) return undefined;
    const [columns, rows] = process.stdout.getWindowSize();
    if (![rows, columns].every(value => Number.isSafeInteger(value) && value > 0 && value <= 65535)) throw new Error("Native terminal dimensions are unavailable");
    return { rows, columns };
  };
  const releaseTerminal = (): void => {
    if (terminalFd === undefined) return;
    const fd = terminalFd;
    terminalFd = undefined;
    fs.closeSync(fd);
  };
  const owned = new Map<number, ProcessIdentity>();
  // Controlling terminals observed on owned processes: the panel PTY and the native terminal.
  const terminals = new Set<number>();
  const sockets = new Set<net.Socket>();
  let admission: Promise<void> = Promise.resolve();
  const mutate = (operation: () => Promise<void>): Promise<void> => {
    const result = admission.then(operation);
    admission = result.catch(() => {});
    return result;
  };
  const publish = (): void => writePanelState(exact, state);
  const cancelled = (): boolean => fs.existsSync(panelFile(binding, "cancelled"));
  const track = (): void => {
    if (childIdentity) descendants(childIdentity, owned, terminals);
    for (const process of [...owned.values()]) descendants(process, owned, terminals);
  };
  // A process escaped the panel when it is neither on a panel terminal nor
  // below this wrapper. Returns its user then, else undefined.
  const escapedUser = (owner: ProcessIdentity): string | undefined => {
    const user = processUser(owner.pid);
    const links = processLinks(owner.pid);
    if (!user || !links || terminals.has(links.terminal)) return undefined;
    for (let parent = links.parent; parent > 1;) {
      if (parent === identity.pid) return undefined;
      const next = processLinks(parent);
      if (!next) return undefined;
      parent = next.parent;
    }
    return processIdentityStatus(owner) === "alive" ? user : undefined;
  };
  const settleOwned = async (): Promise<void> => {
    track();
    if (childIdentity) owned.set(childIdentity.pid, childIdentity);
    // Descendants running as another user (such as `su`'s shell) cannot be
    // signalled. Children come first, so their signalable ancestors still are;
    // they then end on the PTY hangup and are awaited like the others. One that
    // survives detached (a disowned GUI app) has left the panel: Close reports
    // it instead of failing forever.
    const unsignalable = new Set<number>();
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      for (const process of [...owned.values()].reverse()) {
        const status = processIdentityStatus(process);
        if (status === "unknown") throw new Error(`Panel child ${process.pid} liveness is uncertain`);
        if (status === "alive") {
          try { globalThis.process.kill(process.pid, signal); }
          catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "EPERM") unsignalable.add(process.pid);
            else if (code !== "ESRCH") throw error;
          }
        }
      }
      const deadline = Date.now() + (signal === "SIGTERM" ? 250 : 2000);
      while ([...owned.values()].some(process => processIdentityStatus(process) !== "dead") && Date.now() < deadline) await delay(10);
      if ([...owned.values()].every(process => processIdentityStatus(process) === "dead")) break;
    }
    const escaped: string[] = [];
    const remaining = [...owned.values()].filter(process => {
      if (processIdentityStatus(process) === "dead") return false;
      const user = unsignalable.has(process.pid) ? escapedUser(process) : undefined;
      if (user) escaped.push(`${process.pid} (${user})`);
      return !user;
    });
    if (remaining.length) {
      throw new Error(`Panel child cleanup is uncertain: ${remaining.map(process =>
        unsignalable.has(process.pid) ? `${process.pid} (not permitted to signal)` : String(process.pid)).join(", ")} still running`);
    }
    if (childClosed) await childClosed;
    if (escaped.length) state.warning = `Left running outside the panel, not permitted to signal: ${escaped.join(", ")}`;
    else delete state.warning;
  };
  const closeNative = async (): Promise<void> => {
    if (config.native.kind !== "tmux") return;
    validateNativeSocket(config.native.socket);
    const pane = process.env.TMUX_PANE;
    if (!pane || !/^%\d+$/.test(pane)) throw new Error("Panel native pane identity is unavailable");
    // This process is alive throughout native admission: its PID cannot be
    // recycled between this check and tmux's atomic command queue condition.
    const condition = `#{&&:#{==:#{pane_pid},${identity.pid}},#{==:#{pane_dead},0}}`;
    let output: string;
    try {
      output = await runNative("tmux", ["-S", config.native.socket.path, "if-shell", "-F", "-t", pane,
        condition, `kill-pane -t ${pane} ; display-message -p owned-panel-closed`, "display-message -p owned-panel-changed"]);
    } catch (error) {
      if (nativeServer && processIdentityStatus(nativeServer) === "dead" && await serverGone(config.native.socket.path)) return;
      const panes = await runNative("tmux", ["-S", config.native.socket.path, "list-panes", "-a", "-F", "#{pane_id}\t#{pane_pid}"]);
      if (panes.trim().split("\n").every(line => /^%\d+\t\d*$/.test(line))
        && !panes.trim().split("\n").some(line => line === `${pane}\t${identity.pid}`)) return;
      throw error;
    }
    // A replacement is not ours to close. The exact old wrapper still exits
    // after its children settle; no mutation is sent to the new occupant.
    if (!["owned-panel-closed", "owned-panel-changed"].includes(output.trim())) throw new Error("Panel native close was not acknowledged");
  };
  const resizeTerminal = async (): Promise<void> => {
    const size = terminalSize();
    if (!size || terminalFd === undefined || state.command !== "running" || closing) return;
    const fd = terminalFd;
    try {
      await new Promise<void>((resolve, reject) => {
        // Inherit the held slave descriptor, never reopen a reusable /dev/pts
        // pathname. TIOCSWINSZ also delivers SIGWINCH to its foreground group.
        const resize = spawn("stty", ["rows", String(size.rows), "columns", String(size.columns)], { stdio: [fd, "ignore", "pipe"] });
        let diagnostic = "";
        resize.stderr!.on("data", chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-4096); });
        resize.once("error", reject);
        resize.once("close", code => code === 0 ? resolve() : reject(new Error(diagnostic || "Panel terminal resize failed")));
      });
    } catch (error) {
      if (child?.exitCode === null && child.signalCode === null) throw error;
    }
  };
  const resized = (): void => {
    void mutate(resizeTerminal).catch(error => {
      state.error = `Panel resize failed: ${error instanceof Error ? error.message : String(error)}`;
      publish();
      console.error(state.error);
    });
  };
  const holdScriptTerminal = async (): Promise<void> => {
    if (!terminalSize() || !childIdentity) return;
    const deadline = Date.now() + 2000;
    while (state.command === "running" && processIdentityStatus(childIdentity) === "alive") {
      const directory = `/proc/${childIdentity.pid}/fd`;
      let names: string[];
      try { names = fs.readdirSync(directory); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && processIdentityStatus(childIdentity) === "dead") return;
        throw error;
      }
      // Ghostel can inherit extra native slave descriptors through exec.
      // Pair script's own master tty-index with its slave, rather than taking
      // an arbitrary /dev/pts descriptor and accidentally resizing the outer TTY.
      const indices = new Set<string>();
      for (const name of names) {
        try {
          const index = /^tty-index:\s*(\d+)$/m.exec(fs.readFileSync(`/proc/${childIdentity.pid}/fdinfo/${name}`, "utf8"))?.[1];
          if (index) indices.add(index);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      if (indices.size > 1) throw new Error("Owned PTY master identity is ambiguous");
      const slave = indices.size === 1 ? `/dev/pts/${[...indices][0]}` : undefined;
      for (const name of names) {
        const source = `${directory}/${name}`;
        let fd: number | undefined;
        try {
          if (!slave || fs.readlinkSync(source) !== slave) continue;
          fd = fs.openSync(source, fs.constants.O_RDWR | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK);
          if (!fs.fstatSync(fd).isCharacterDevice() || processIdentityStatus(childIdentity) !== "alive") {
            fs.closeSync(fd); fd = undefined; continue;
          }
          terminalFd = fd;
          return;
        } catch (error) {
          if (fd !== undefined) fs.closeSync(fd);
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      if (Date.now() >= deadline) throw new Error("Owned PTY resize descriptor is unavailable");
      await delay(10);
    }
  };
  const terminate = (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      try {
        await settleOwned();
        releaseTerminal();
        process.stdout.removeListener("resize", resized);
        state.command = "exited";
        state.closed = true;
        delete state.error;
        publish();
        await closeNative();
        for (const socket of sockets) socket.end();
        server.close();
        clearInterval(monitor);
        process.stdin.pause();
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        setImmediate(() => process.exit(0));
      } catch (error) {
        cleanupFailed = true;
        state.closed = false;
        state.error = error instanceof Error ? error.message : String(error);
        publish();
        closing = undefined;
        throw error;
      }
    })();
    return closing;
  };
  const activate = async (): Promise<void> => {
    if (state.command !== "held" || closing) throw new Error("Panel is not awaiting activation");
    if (cancelled() || processIdentityStatus(config.creator) !== "alive") throw new Error("Panel creator/cancellation does not authorize activation");
    const argv = capturedArgv(config.argv, config.outputPath, process.platform, terminalSize());
    child = spawn(argv[0], argv.slice(1), { cwd: config.cwd, env: { ...process.env, ...config.env }, stdio: ["pipe", "pipe", "pipe"] });
    childClosed = new Promise<void>(resolve => {
      child!.once("error", error => { state.error = error.message; });
      child!.once("close", (code, signal) => {
        state.command = "exited"; state.code = code; state.signal = signal;
        releaseTerminal();
        try { publish(); } catch (error) { console.error(error); }
        resolve();
      });
    });
    child.stdout!.on("data", chunk => process.stdout.write(chunk));
    child.stderr!.on("data", chunk => process.stderr.write(chunk));
    child.stdin!.on("error", error => { if ((error as NodeJS.ErrnoException).code !== "EPIPE") console.error(error); });
    await new Promise<void>((resolve, reject) => { child!.once("spawn", resolve); child!.once("error", reject); });
    childIdentity = readProcessIdentity(child.pid!);
    if (!childIdentity) throw new Error("Panel command process identity is unavailable");
    owned.set(childIdentity.pid, childIdentity);
    track();
    state.command = "running";
    publish();
    await holdScriptTerminal();
    // Native resize may have arrived while script allocated its PTY. Apply the
    // latest size after acquiring its descriptor, before activation acknowledges.
    await resizeTerminal();
  };
  const input = async (value: PanelInput): Promise<void> => {
    if (closing || state.command !== "running" || !child?.stdin?.writable) throw new Error("Panel command has exited or is not active");
    let bytes: string;
    if (value?.kind === "text" && typeof value.text === "string" && typeof value.enter === "boolean") bytes = value.text + (value.enter ? "\r" : "");
    else if (value?.kind === "keys" && Array.isArray(value.keys) && value.keys.every(key => typeof key === "string")) bytes = value.keys.map(panelKeyBytes).join("");
    else throw new Error("Invalid panel input");
    if (Buffer.byteLength(bytes) > 1024 * 1024) throw new Error("Panel input exceeds its bound");
    await new Promise<void>((resolve, reject) => child!.stdin!.write(bytes, error => { if (error) reject(error); else resolve(); }));
  };
  const server = net.createServer(socket => {
    socket.setEncoding("utf8");
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    let bytes = "";
    socket.on("error", () => {});
    socket.on("data", chunk => {
      bytes += chunk;
      if (Buffer.byteLength(bytes) > 1024 * 1024) return socket.destroy();
      if (!bytes.includes("\n")) return;
      socket.removeAllListeners("data");
      void (async () => {
        try {
          const request = JSON.parse(bytes.slice(0, bytes.indexOf("\n"))) as { id: string; token: string; process: ProcessIdentity; operation: string; input: PanelInput };
          if (request.id !== config.id || request.token !== config.token || !isProcessIdentity(request.process) || !sameProcessIdentity(request.process, identity)) throw new Error("Panel control identity mismatch");
          if (request.operation === "activate") await mutate(activate);
          else if (request.operation === "input") await mutate(() => input(request.input));
          else if (request.operation === "close") {
            // A retried Close reports its own outcome, not the previous failure.
            if (state.error !== undefined) { delete state.error; publish(); }
            socket.end(`${JSON.stringify({ state })}\n`);
            await mutate(terminate); return;
          } else if (request.operation !== "status") throw new Error("Unsupported panel control operation");
          socket.end(`${JSON.stringify({ state })}\n`);
        } catch (error) { socket.end(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`); }
      })();
    });
  });
  const monitor = setInterval(() => {
    try {
      track();
      if (!cleanupFailed && (cancelled() || processIdentityStatus(config.creator) !== "alive")) void mutate(terminate).catch(error => console.error(error));
    } catch (error) { state.error = String(error); publish(); }
  }, 50);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(panelFile(binding, "control.sock"), () => { fs.chmodSync(panelFile(binding, "control.sock"), 0o600); resolve(); });
  });
  publish();
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdout.on("resize", resized);
  process.stdin.on("data", chunk => { if (state.command === "running" && child?.stdin?.writable) child.stdin.write(chunk); });
  for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"] as const) process.on(signal, () => { void mutate(terminate).catch(error => console.error(error)); });
  if (cancelled() || processIdentityStatus(config.creator) !== "alive") await mutate(terminate);
}
// Node runs the main module from its real path; compare real paths so a
// symlinked invocation does not silently skip the entry point.
if (process.argv[1] && fs.existsSync(process.argv[1]) && pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url) {
  let binding: PanelBinding | undefined;
  try { binding = JSON.parse(process.argv[2] ?? "null") as PanelBinding; await runPanelRuntime(binding); }
  catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (binding) {
      try { fs.appendFileSync(panelFile(binding, "runtime-error.log"), `${detail}\n`, { mode: 0o600 }); }
      catch (diagnostic) { console.error(`${detail}\n${String(diagnostic)}`); }
    }
    console.error(detail);
    // Startup has not admitted user argv; settle the failed owning process
    // rather than leaving its listening socket/creator monitor alive forever.
    setImmediate(() => process.exit(1));
  }
}
