import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { truncateTail, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { processExists } from "@phimacs/pimux/process-identity";
import { hostForTarget } from "../host.ts";
import type { HostTarget } from "../host-types.ts";
import { capturedExitStatus, commandOutput, lastPromptMark, outputSince, promptReporting, promptWarning, readCursor, scanOutput, PROMPT_INTEGRATION_HINT, writeCursor, type PromptMark, type ScanOutcome } from "../panel-output.ts";
import { renderToolCall } from "../tool-call.ts";
import { settledTarget, validateName } from "../workers.ts";

const POLL_MS = 500;
const STATE_POLL_MS = 2000;
const PROGRESS_MS = 5000;
const MAX_TIMEOUT_SECONDS = 24 * 60 * 60;

const waitOutputSchema = Type.Object({
  output: Type.String({ description: "Output no earlier result returned." }),
  truncated: Type.Boolean(),
  state: Type.Union([Type.Literal("matched"), Type.Literal("prompt"), Type.Literal("idle"), Type.Literal("exited"), Type.Literal("timeout")], {
    description: "idle: already at the prompt when the wait started.",
  }),
  exit_code: Type.Optional(Type.Integer()),
  matched_line: Type.Optional(Type.String()),
  wall_time_seconds: Type.Number(),
  warning: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  host: Type.Optional(Type.String()),
});

type Outcome =
  | ScanOutcome
  | { kind: "idle"; status?: number }
  | { kind: "exited"; status?: number }
  | { kind: "timeout" };

interface WaitDetails {
  source: string;
  elapsedMs: number;
}

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours) return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
  return minutes ? `${minutes}m${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
}

function compile(match: string | undefined): RegExp | undefined {
  if (match === undefined) return undefined;
  try { return new RegExp(match); }
  catch (error) { throw new Error(`Invalid match regex: ${error instanceof Error ? error.message : String(error)}`); }
}

function fileSize(file: string): number {
  return fs.statSync(file).size;
}

function describe(outcome: Outcome): string {
  switch (outcome.kind) {
    case "matched": return "Matched";
    case "prompt": return `Back at the prompt${outcome.status !== undefined ? ` (exit code ${outcome.status})` : ""}`;
    case "idle": return `Already idle at the prompt${outcome.status !== undefined ? ` (last exit code ${outcome.status})` : ""}`;
    case "exited": return `Exited${outcome.status !== undefined ? ` with code ${outcome.status}` : ""}`;
    case "timeout": return "Timed out";
  }
}

function idleAtPrompt(log: string, end: number, input: number | undefined): PromptMark | undefined {
  const last = lastPromptMark(log, end);
  if (!last || last.kind === "C") return undefined;
  return input === undefined || last.end > input ? last : undefined;
}

export default function waitExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "wait",
    label: "Wait",
    description: "Wait until a panel, log file, or process is ready instead of sleeping. Returns at the first of: a line matching `match` (JavaScript regex) in new output; a panel's shell or gdb returning to its prompt; the panel's or pid's process exiting; or timeoutSeconds. "
      + "Returns the new output and the outcome; a timeout is a result, not an error. A panel already idle at its prompt answers at once. "
      + "For a panel, new output is what no earlier panel-send or wait result returned. "
      + "A command typed into an interactive shell or gdb in a panel (including over ssh) is detected as finished only when it reports its prompt with OSC 133 marks; panel-send warns when its input goes somewhere without them. "
      + `${PROMPT_INTEGRATION_HINT} For a file, only text appended after the call counts and \`match\` is required.`,
    promptSnippet: "Wait for panel output, shell prompts, process exit, or log lines, instead of sleep",
    promptGuidelines: ["Never run sleep to wait for builds, servers, or panels; use wait so you continue as soon as the result is ready."],
    parameters: Type.Object({
      panel: Type.Optional(Type.String({ description: "Registered panel name." })),
      file: Type.Optional(Type.String({ description: "Log file to follow." })),
      pid: Type.Optional(Type.Integer({ minimum: 1, description: "Process to wait for." })),
      match: Type.Optional(Type.String({ minLength: 1, description: "JavaScript regular expression tested against each new output line." })),
      timeoutSeconds: Type.Integer({ minimum: 1, maximum: MAX_TIMEOUT_SECONDS, description: "Upper bound, not an expected duration." }),
    }),
    outputSchema: waitOutputSchema,
    renderCall: (args) => renderToolCall("wait", args),
    async execute(_id, params, signal, onUpdate, ctx) {
      signal?.throwIfAborted();
      const sources = [params.panel, params.file, params.pid].filter((value) => value !== undefined);
      if (sources.length !== 1) throw new Error("Supply exactly one of panel, file, or pid.");
      const regex = compile(params.match);
      const startedAt = Date.now();
      const deadline = startedAt + params.timeoutSeconds * 1000;
      let target: HostTarget | undefined;
      let log: string;
      let source: string;
      let offset: number;
      let promptAfter: number | undefined;
      let outcome: Outcome | undefined;
      /** End of the matched line or command, if any. */
      let end: number | undefined;
      /** The panel-send input this wait's output starts at, if no wait followed it yet. */
      let input: number | undefined;
      let lastLine: string | undefined;
      const scan = (after: number | undefined) => {
        const result = scanOutput(log, offset, regex, after);
        offset = result.next;
        lastLine = result.lines.at(-1) ?? lastLine;
        if (result.found) end = result.found.end;
        return result;
      };

      if (params.pid !== undefined) {
        if (regex) throw new Error("match is not supported with pid; wait for a panel or file instead.");
        source = `pid ${params.pid}`;
        const alive = () => processExists(params.pid!);
        while (alive() && Date.now() < deadline) await delay(POLL_MS, undefined, { signal });
        outcome = alive() ? { kind: "timeout" } : { kind: "exited" };
        log = "";
        offset = 0;
      } else if (params.file !== undefined) {
        if (!regex) throw new Error("A file wait needs match: a file has no prompt or exit to wait for.");
        log = path.resolve(ctx.cwd, params.file.replace(/^~(?=\/|$)/, os.homedir()));
        if (!fs.existsSync(log)) throw new Error(`File does not exist: ${log}. If a panel or process creates it, wait on that panel (output, prompt, or exit) or pid instead.`);
        source = log;
        offset = fileSize(log);
      } else {
        const name = validateName(params.panel!);
        // A panel started earlier in the same tool batch may still be registering.
        target = await settledTarget(name, signal);
        if (!target) throw new Error(`No panel named '${name}'. Use /panels to list panels.`);
        if (target.kind !== "shell" || !target.outputPath) throw new Error(`'${name}' has no captured output to wait on${target.kind === "shell" ? "; it was started before output capture existed. Close and restart it." : ": it is not a shell panel."}`);
        log = target.outputPath;
        source = `panel ${name}`;
        const host = hostForTarget(pi, target);
        const state = await host.state(target, signal);
        if (state === "missing") throw new Error(`Panel '${name}' no longer exists on ${target.host}. Close it and start a new one.`);
        const cursor = readCursor(log);
        const size = fileSize(log);
        offset = cursor.cursor <= size ? cursor.cursor : 0;
        if (cursor.input === offset) input = offset;
        const idle = idleAtPrompt(log, size, cursor.input);
        // An idle or exited panel answers at once, after the output still pending since the cursor.
        const now: Outcome | undefined = state !== "running" ? { kind: "exited", status: capturedExitStatus(log) }
          : idle ? { kind: "idle", ...(idle.status !== undefined ? { status: idle.status } : {}) }
          : undefined;
        if (now) {
          const found = scan(now.kind === "idle" ? offset : undefined).found?.outcome;
          outcome = found?.kind === "matched" ? found : now;
        } else promptAfter = size;
      }
      const start = offset;

      let lastState = Date.now();
      let lastProgress = Date.now();
      while (!outcome) {
        const result = scan(promptAfter);
        if (result.found) { outcome = result.found.outcome; break; }
        if (result.exitStatus !== undefined) { outcome = { kind: "exited", status: result.exitStatus }; break; }
        if (result.more) continue;
        if (target && Date.now() - lastState >= STATE_POLL_MS) {
          lastState = Date.now();
          const state = await hostForTarget(pi, target).state(target, signal);
          if (state === "missing") throw new Error(`Panel '${target.name}' no longer exists on ${target.host}.`);
          if (state === "exited") {
            const final = scan(promptAfter);
            outcome = final.found?.outcome ?? { kind: "exited", status: final.exitStatus };
            break;
          }
        }
        if (Date.now() >= deadline) { outcome = { kind: "timeout" }; break; }
        if (Date.now() - lastProgress >= PROGRESS_MS) {
          lastProgress = Date.now();
          onUpdate?.({
            content: [{ type: "text", text: `Waiting ${duration(Date.now() - startedAt)} for ${source}${lastLine !== undefined ? `; last line: ${lastLine}` : ""}` }],
            details: { source, elapsedMs: Date.now() - startedAt } satisfies WaitDetails,
          });
        }
        await delay(POLL_MS, undefined, { signal });
      }

      const stop = end ?? offset;
      // Lines scanned past a match stay pending for the next wait.
      if (target) writeCursor(log, { ...readCursor(log), cursor: stop });
      const elapsedMs = Date.now() - startedAt;
      // Right after panel-send, drop the echoed line as panel-send does.
      const text = params.pid !== undefined ? ""
        : input !== undefined ? commandOutput(log, input, stop)
        : outputSince(log, start <= stop ? start : 0, stop);
      const { content: output, truncated } = truncateTail(text);
      const warning = outcome.kind === "timeout" && target && !regex
        ? promptWarning(promptReporting(log, fileSize(log), readCursor(log).input))
        : undefined;
      const status = "status" in outcome ? outcome.status : undefined;
      const notes = [
        truncated ? "Output truncated to its last lines." : undefined,
        `${describe(outcome)} after ${duration(elapsedMs)}.`,
        warning,
      ];
      return {
        content: [{ type: "text", text: [output, ...notes].filter(Boolean).join("\n\n") }],
        details: { source, elapsedMs } satisfies WaitDetails,
        structuredContent: {
          output, truncated, state: outcome.kind,
          ...(status !== undefined ? { exit_code: status } : {}),
          ...(outcome.kind === "matched" ? { matched_line: outcome.line } : {}),
          wall_time_seconds: Math.round(elapsedMs / 100) / 10,
          ...(warning ? { warning } : {}),
          ...(target ? { name: target.name, host: target.host } : {}),
        },
      };
    },
  });
}
