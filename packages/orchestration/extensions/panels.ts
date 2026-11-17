import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DEFAULT_MAX_LINES, getAgentDir, getShellConfig, SettingsManager, truncateTail, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveCwd } from "../context.ts";
import { publicTarget } from "../endpoint.ts";
import { getHost, hostForTarget } from "../host.ts";
import type { Host, HostTarget } from "../host-types.ts";
import { capturedExitStatus, commandOutput, createPanelOutput, outputSince, promptReporting, promptWarning, readCursor, recordInput, recordKeys, removePanelOutput, scanOutput, GDB_COMMAND, PROMPT_INTEGRATION, writeCursor } from "../panel-output.ts";
import { renderToolCall } from "../tool-call.ts";
import { claimNameForOperation, listTargets, readTarget, removeTarget, saveTarget, settledTarget, validateName } from "../workers.ts";
import { formatRemoteLocation, resolveRemoteLocation, sessionRemote } from "../remote-session.ts";
import { remoteTerminalArgv } from "../ssh.ts";
import { ownPanel, panelOwner } from "../panel-lifetime.ts";
import { PanelStartError } from "../panel-runtime.ts";

const DEFAULT_LINES = 500;
/** Terminals answer input asynchronously; settle briefly so the returned snapshot shows the effect. */
const SETTLE_MS = 250;
/** How long a line typed at a shell prompt may run before panel-send returns without its result. */
const COMMAND_GRACE_MS = 5000;
const POLL_MS = 100;
const nameSchema = Type.String({ description: "Registered panel name, not a native pane or buffer ID." });
const panelFields = { name: Type.String(), host: Type.String() };

const startOutputSchema = Type.Object({ ...panelFields, cwd: Type.String() });
const readOutputSchema = Type.Object({
  output: Type.String(),
  truncated: Type.Boolean(),
  state: Type.Union([Type.Literal("running"), Type.Literal("idle"), Type.Literal("exited")]),
  ...panelFields,
});
const sendOutputSchema = Type.Object({
  output: Type.String({ description: "Output since the input." }),
  truncated: Type.Boolean(),
  state: Type.Union([Type.Literal("finished"), Type.Literal("running"), Type.Literal("exited"), Type.Literal("sent")], {
    description: "sent: not followed (keys, or input to a running program or unmarked shell).",
  }),
  exit_code: Type.Optional(Type.Integer()),
  wall_time_seconds: Type.Number(),
  warning: Type.Optional(Type.String()),
  ...panelFields,
});

interface Bounded { output: string; truncated: boolean }

function bounded(text: string, lines?: number): Bounded {
  const result = truncateTail(text, { maxLines: lines });
  return { output: result.content, truncated: result.truncated };
}

/** The payload first, then only the notes the model needs. */
function modelText(output: string, notes: Array<string | undefined>): string {
  return [output, ...notes].filter(Boolean).join("\n\n") || "(no output)";
}

const truncationNote = (result: Bounded): string | undefined =>
  result.truncated ? "Output truncated to its last lines." : undefined;

/**
 * Where a panel runs: locally in the bash tool's shell, or, in a session whose
 * tools run over SSH, in a remote bash login shell at the remote directory.
 */
async function panelLaunch(command: string, folder: string | undefined, ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">, signal?: AbortSignal): Promise<{ cwd: string; argv: string[]; label: string }> {
  const remote = sessionRemote();
  if (!remote) {
    const cwd = resolveCwd(ctx.cwd, folder);
    return { cwd, argv: panelArgv(command, ctx), label: cwd };
  }
  const session = await remote.location(signal);
  const location = folder === undefined ? session : await resolveRemoteLocation({ destination: session.destination, path: session.cwd }, folder, signal);
  return { cwd: ctx.cwd, argv: remoteTerminalArgv(location.destination, location.cwd, command), label: formatRemoteLocation(location) };
}

/** Run a panel command in the shell Pi's bash tool resolves, as a login shell when that is bash. */
export function panelArgv(command: string, ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): string[] {
  const shellPath = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() }).getShellPath();
  const config = getShellConfig(shellPath);
  if (config.commandTransport === "stdin") throw new Error(`Panels cannot run commands through ${config.shell}, which reads commands from stdin`);
  return [config.shell, ...(path.basename(config.shell) === "bash" ? ["-l"] : []), ...config.args, command];
}

/** A panel started earlier in the same tool batch may still be registering. */
async function requirePanel(name: string, signal?: AbortSignal): Promise<HostTarget> {
  const target = await settledTarget(validateName(name), signal);
  if (!target) throw new Error(`No panel named '${name}'. Use /panels to list panels.`);
  return target;
}

type CommandProgress =
  | { kind: "finished"; end: number; status?: number }
  | { kind: "exited"; status?: number }
  | { kind: "running" };

/** Follow a line typed at a shell prompt until its command ends, the panel's command exits, or the grace runs out. */
async function followCommand(log: string, input: number, graceMs: number, signal?: AbortSignal): Promise<CommandProgress> {
  const deadline = Date.now() + graceMs;
  let offset = input;
  for (;;) {
    const scan = scanOutput(log, offset, undefined, input);
    offset = scan.next;
    if (scan.found?.outcome.kind === "prompt") {
      const { status } = scan.found.outcome;
      return { kind: "finished", end: scan.found.end, ...(status !== undefined ? { status } : {}) };
    }
    if (scan.exitStatus !== undefined) return { kind: "exited", status: scan.exitStatus };
    if (scan.more) continue;
    if (Date.now() >= deadline) return { kind: "running" };
    await delay(POLL_MS, undefined, { signal });
  }
}

const seconds = (ms: number): number => Math.round(ms / 100) / 10;

/** Native surfaces vanish when their server, window, or pane is destroyed elsewhere. */
async function isMissing(host: Host, target: HostTarget, signal?: AbortSignal): Promise<boolean> {
  return await host.state(target, signal).catch(() => undefined) === "missing";
}

const missingError = (target: HostTarget): Error =>
  new Error(`Panel '${target.name}' no longer exists on ${target.host}. Close it and start a new one.`);

async function readPanel(host: Host, target: HostTarget, lines: number, signal?: AbortSignal): Promise<Bounded> {
  try {
    return bounded(await host.read(target, lines, signal), lines);
  } catch (error) {
    signal?.throwIfAborted();
    if (await isMissing(host, target, signal)) throw missingError(target);
    throw error;
  }
}

/**
 * The persistent wrapper keeps completed output readable, but input belongs
 * only to its running command, never to a new native shell or reused surface.
 */
async function requireRunning(host: Host, target: HostTarget, signal?: AbortSignal): Promise<void> {
  if (target.kind !== "shell") return;
  const state = await host.state(target, signal);
  if (state === "missing") throw missingError(target);
  if (state === "running") return;
  const status = target.outputPath ? capturedExitStatus(target.outputPath) : undefined;
  throw new Error(`The command of panel '${target.name}' exited${status !== undefined ? ` with status ${status}` : ""}; its output is no longer captured and input would reach nothing useful. `
    + "Read its final output with panel-read, then close it and start a new panel. To run several commands in sequence, start a panel whose command is an interactive shell and send each command to it.");
}

export default function panelsExtension(pi: ExtensionAPI, commandGraceMs = COMMAND_GRACE_MS, observeOwner = ownPanel): void {
  /** Prompt-mark warnings already shown to the user, once per panel and running program. */
  const notified = new Set<string>();
  pi.registerTool({
    name: "panel-start",
    label: "Start Panel",
    description: "Start a long-running command in a named terminal panel: a server, watcher, or interactive program. The command runs in the bash tool's shell (a login shell when that is bash). "
      + "After the command exits, its output stays readable and its name reserved until panel-close, but the panel accepts no more input. "
      + `To run several commands in sequence, start an interactive shell that reports its prompt with OSC 133 marks (\`fish\` 4+, or \`bash --rcfile ${PROMPT_INTEGRATION.bash} -i\`) and send each command with panel-send, which then returns its output and exit status; wait also works. `
      + `For gdb, start \`${GDB_COMMAND} …\` so it reports its prompt the same way, including when \`run\` or \`continue\` stops. `
      + "Use built-in bash for ordinary foreground commands. Use wait, never sleep, to react when its output, shell prompt, or exit is ready. "
      + "When this session's tools run on a remote host over SSH, the command and folder are on that host. Returns the panel name.",
    parameters: Type.Object({
      name: nameSchema,
      command: Type.String({ minLength: 1 }),
      folder: Type.Optional(Type.String()),
    }),
    outputSchema: startOutputSchema,
    renderCall: (args) => renderToolCall("panel-start", args),
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const name = validateName(params.name);
      // Claim before any await, so later tools of the same batch see this start in progress.
      const release = await claimNameForOperation(name, signal);
      try {
        const { cwd, argv, label } = await panelLaunch(params.command, params.folder, ctx, signal);
        const existing = readTarget(name);
        if (existing) {
          // A panel whose native surface is gone holds no output; its name is free to reuse.
          if (!await isMissing(hostForTarget(pi, existing), existing, signal)) {
            throw new Error(`'${name}' already exists. Close it explicitly before reusing its name.`);
          }
          removeTarget(name);
          removePanelOutput(existing.outputPath);
        }
        // Native hosts return recoverable ownership when rollback is uncertain.
        // Only acknowledged cleanup authorizes removing the tools-owned capture.
        const host = getHost(pi);
        const owner = panelOwner();
        const output = createPanelOutput();
        let target: HostTarget;
        try {
          target = { ...await host.start({ kind: "shell", name, cwd, argv, outputPath: output.log, placement: "worker", parent: host.parent() }, signal), outputPath: output.log };
        } catch (error) {
          if (error instanceof PanelStartError) {
            try { saveTarget({ ...error.target, owner, outputPath: output.log, closeError: error.message }); }
            catch (recordError) { throw new AggregateError([error, recordError], `${error.message}\nCould not retain recoverable panel target: ${String(recordError)}; capture ${output.log}`); }
          } else removePanelOutput(output.log);
          throw error;
        }
        target = { ...target, owner };
        try {
          saveTarget(target);
          await observeOwner(target, signal);
          signal?.throwIfAborted();
        } catch (error) {
          const failure = error instanceof Error ? error.message : String(error);
          try {
            await host.close(target);
            removePanelOutput(output.log);
            removeTarget(name);
          } catch (cleanupError) {
            const detail = `${failure}\nOwned panel cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
            try { saveTarget({ ...target, closeError: detail }); }
            catch (recordError) { throw new AggregateError([error, cleanupError, recordError], `${detail}\nCould not retain cleanup diagnostic: ${String(recordError)}`); }
            throw new AggregateError([error, cleanupError], detail);
          }
          throw error;
        }
        return {
          content: [{ type: "text", text: target.name }],
          details: { target: publicTarget(target), cwd: label, command: params.command },
          structuredContent: { name: target.name, host: target.host, cwd: label },
        };
      } finally {
        release();
      }
    },
  });

  pi.registerTool({
    name: "panel-read",
    label: "Read Panel",
    description: "Read the screen of a panel, including one whose process has exited. Defaults to 500 lines, bounded to 2000 lines or 50KB. Reads are repeatable snapshots, not an incremental log.",
    parameters: Type.Object({ name: nameSchema, lines: Type.Optional(Type.Integer({ minimum: 1, maximum: DEFAULT_MAX_LINES })) }),
    outputSchema: readOutputSchema,
    renderCall: (args) => renderToolCall("panel-read", args),
    async execute(_id, params, signal) {
      signal?.throwIfAborted();
      const target = await requirePanel(params.name, signal);
      const lines = params.lines ?? DEFAULT_LINES;
      const host = hostForTarget(pi, target);
      const output = await readPanel(host, target, lines, signal);
      const hostState = await host.state(target, signal);
      if (hostState === "missing") throw missingError(target);
      // A shell idle at its prompt is not running a command worth waiting for.
      const state = hostState === "exited" ? "exited"
        : target.kind === "shell" && target.outputPath !== undefined
          && promptReporting(target.outputPath, fs.statSync(target.outputPath).size).kind === "prompt" ? "idle"
        : "running";
      const hint = state === "running" ? "Still running; use wait instead of reading again." : undefined;
      return {
        content: [{ type: "text", text: modelText(output.output, [truncationNote(output), hint]) }],
        details: { target: publicTarget(target) },
        structuredContent: { ...output, state, name: target.name, host: target.host },
      };
    },
  });

  pi.registerTool({
    name: "panel-send",
    label: "Send to Panel",
    description: "Type a line of text or press native keys such as ctrl+c and Escape in a panel, then return the output since that input. Supply exactly one of text or keys. A panel whose command has exited accepts no input. "
      + `Text typed at a shell or gdb prompt that emits OSC 133 prompt marks (also over ssh) returns that command's whole output (and a shell's exit status) when it finishes within ${commandGraceMs / 1000} seconds; a longer command returns its output so far and is still running, so follow it with wait. `
      + "Keys and input to a running program return the output after a short settle; use panel-read for the screen of a full-screen program. This is terminal input, not draft-safe Pi prompt submission. Text sent where no shell reports its prompt, such as ssh to a host without shell integration, returns a warning: wait without match cannot see it finish.",
    parameters: Type.Object({
      name: nameSchema,
      text: Type.Optional(Type.String()),
      keys: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
    }),
    outputSchema: sendOutputSchema,
    renderCall: (args) => renderToolCall("panel-send", args),
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      if ((params.text === undefined) === (params.keys === undefined)) throw new Error("Supply exactly one of text or keys.");
      const target = await requirePanel(params.name, signal);
      const host = hostForTarget(pi, target);
      await requireRunning(host, target, signal);
      const log = target.outputPath;
      // Only a shell idle at its prompt reports when a typed line is done.
      const atPrompt = params.text !== undefined && log !== undefined && promptReporting(log, fs.statSync(log).size).kind === "prompt";
      const input = log === undefined ? undefined : params.text !== undefined ? recordInput(log) : recordKeys(log);
      const sentAt = Date.now();
      await host.send(target, params.text !== undefined
        ? { kind: "text", text: params.text, enter: true }
        : { kind: "keys", keys: params.keys! }, signal);
      /** Later waits return only output after `shownTo`. */
      const respond = (state: "finished" | "running" | "exited" | "sent", text: string, shownTo: number | undefined, status?: number, warning?: string) => {
        if (log !== undefined && shownTo !== undefined) writeCursor(log, { ...readCursor(log), cursor: shownTo });
        const output = bounded(text);
        const elapsed = seconds(Date.now() - sentAt);
        const statusNote = state === "running" ? `Still running after ${elapsed}s; use wait to follow it.`
          : state === "exited" ? `The panel's command exited${status !== undefined ? ` with code ${status}` : ""}.`
          : status ? `Exit code ${status}.` : undefined;
        return {
          content: [{ type: "text" as const, text: modelText(output.output, [truncationNote(output), statusNote, warning]) }],
          details: { target: publicTarget(target) },
          structuredContent: {
            ...output, state, ...(status !== undefined ? { exit_code: status } : {}), wall_time_seconds: elapsed,
            ...(warning ? { warning } : {}), name: target.name, host: target.host,
          },
        };
      };
      if (atPrompt && log !== undefined && input !== undefined) {
        const progress = await followCommand(log, input, commandGraceMs, signal);
        if (progress.kind === "finished") {
          // A nested shell's first prompt (ssh) also ends the line that started it.
          return respond("finished", commandOutput(log, input, progress.end), progress.end, progress.status);
        }
        const size = fs.statSync(log).size;
        return respond(progress.kind, commandOutput(log, input, size), size, progress.kind === "exited" ? progress.status : undefined);
      }
      await delay(SETTLE_MS, undefined, { signal });
      if (log === undefined || input === undefined) {
        // Panels started before output capture existed have only their screen.
        return respond("sent", (await readPanel(host, target, DEFAULT_LINES, signal)).output, undefined);
      }
      const size = fs.statSync(log).size;
      // Keys usually interrupt or answer a running program; only typed lines are commands to wait for.
      if (params.keys !== undefined) return respond("sent", outputSince(log, input, size), size);
      const reporting = promptReporting(log, size, input);
      const warning = promptWarning(reporting);
      const key = `${log}:${reporting.kind}:${reporting.kind === "program" ? reporting.mark : ""}`;
      if (warning && ctx.hasUI && !notified.has(key)) {
        notified.add(key);
        ctx.ui.notify(`Panel ${target.name}: ${warning}`, "warning");
      }
      return respond("sent", commandOutput(log, input, size), size, undefined, warning);
    },
  });

  pi.registerTool({
    name: "panel-close",
    label: "Close Panel",
    description: "Close a panel and release its name. A worker with an active parent request cannot be closed through this tool; cancel that request instead.",
    parameters: Type.Object({ name: nameSchema }),
    renderCall: (args) => renderToolCall("panel-close", args),
    async execute(_id, params, signal) {
      signal?.throwIfAborted();
      const release = await claimNameForOperation(validateName(params.name), signal);
      try {
        const target = readTarget(params.name);
        if (!target) throw new Error(`No panel named '${params.name}'. Use /panels to list panels.`);
        // Once close starts, finish cleanup even if the tool is cancelled.
        await hostForTarget(pi, target).close(target);
        removePanelOutput(target.outputPath);
        removeTarget(params.name);
        return { content: [{ type: "text", text: target.name }], details: { target: publicTarget(target) } };
      } finally { release(); }
    },
  });

  pi.registerCommand("panels", {
    description: "List registered panels, workers, and interactive forks. Exited panels retain their names until explicitly closed.",
    async handler(_args, ctx) {
      const targets = listTargets();
      ctx.ui.notify(bounded(targets.length
        ? targets.map((target) => `${target.name} [${target.host}] ${target.kind} (${target.id})${target.closeError ? ` — ${target.closeError}` : ""}`).join("\n")
        : "No registered panels.").output, "info");
    },
  });
}
