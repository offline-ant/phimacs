/**
 * `pimux agent`: a command-line frontend of managed runtimes beside Pilish.
 * It lists agents from discovery, observes one through its socket as an
 * ordinary peer, and submits prompts only through the contextual request path.
 * It never stops or closes agents and never answers their dialogs.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { AgentConnection, type AgentUpdate } from "./agent-client.ts";
import type { DiscoveryRecord } from "./discovery.ts";
import { isRecord, type JsonRecord } from "./protocol.ts";
import { runtimeRequest } from "./request.ts";
import { listRuntimes, lookupTerminalReceipt } from "./runtime-control.ts";
import type { MuxStatus } from "./state.ts";

/** Printed output (JSON value, or text for `--format text`) and the process exit code. */
export interface AgentResult { output: unknown; exitCode: number }

export const AGENT_USAGE = `Usage: pimux agent list [--all]
       pimux agent get <muxId>
       pimux agent read <muxId> [--messages N] [--format json|text]
       pimux agent wait <muxId> [--until idle|working|blocked]... [--next-turn] [--timeout MS]
       pimux agent prompt <muxId> [--follow-up|--steer] [--wait [--until STATE]...] [--timeout MS] -- <text>`;

const EXIT_ERROR = 1;
const EXIT_TIMEOUT = 2;
const EXIT_EXITED = 3;
/** A started prompt whose run is not observed within this bound is reported, never resent. */
const STALL_MS = 5000;
const STATES: ReadonlySet<string> = new Set(["idle", "working", "blocked"]);

class AgentFailure extends Error {
  readonly result: AgentResult;
  constructor(result: AgentResult) {
    super(String((result.output as { error: { message: string } }).error.message));
    this.result = result;
  }
}

function failure(code: string, message: string, exitCode = EXIT_ERROR, details: object = {}): AgentResult {
  return { output: { error: { code, message, ...details } }, exitCode };
}

interface Options {
  positional: string[]; text: string[]; until: MuxStatus[]; all: boolean; nextTurn: boolean; wait: boolean;
  followUp: boolean; steer: boolean; messages?: number; timeoutMs?: number; format: "json" | "text";
}

function parse(args: string[]): Options {
  const options: Options = { positional: [], text: [], until: [], all: false, nextTurn: false, wait: false,
    followUp: false, steer: false, format: "json" };
  const usage = (message: string): never => { throw new AgentFailure(failure("usage", `${message}\n${AGENT_USAGE}`)); };
  const count = (value: string | undefined, name: string): number => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : usage(`${name} needs a positive integer`);
  };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--") { options.text = args.slice(index + 1); break; }
    if (!argument.startsWith("--")) { options.positional.push(argument); continue; }
    const value = (): string | undefined => args[++index];
    if (argument === "--all") options.all = true;
    else if (argument === "--next-turn") options.nextTurn = true;
    else if (argument === "--wait") options.wait = true;
    else if (argument === "--follow-up") options.followUp = true;
    else if (argument === "--steer") options.steer = true;
    else if (argument === "--messages") options.messages = count(value(), "--messages");
    else if (argument === "--timeout") options.timeoutMs = count(value(), "--timeout");
    else if (argument === "--until") {
      const state = value();
      if (!state || !STATES.has(state)) usage("--until takes idle, working or blocked");
      options.until.push(state as MuxStatus);
    } else if (argument === "--format") {
      const format = value();
      if (format !== "json" && format !== "text") usage("--format takes json or text");
      options.format = format as "json" | "text";
    } else usage(`Unknown option ${argument}`);
  }
  return options;
}

/** Runs one `pimux agent` subcommand; failures are named JSON errors, never thrown. */
export async function agentCommand(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<AgentResult> {
  try {
    const [action, ...rest] = args;
    const options = parse(rest);
    const id = (): string => {
      if (options.positional.length !== 1) throw new AgentFailure(failure("usage", AGENT_USAGE));
      return options.positional[0]!;
    };
    if (action === "list") return { output: list(env, options.all), exitCode: 0 };
    if (action === "get") return { output: summary(target(id(), env), callerId(env)), exitCode: 0 };
    if (action === "read") return await read(target(id(), env), options, env);
    if (action === "wait") return await wait(target(id(), env), options, env);
    if (action === "prompt") return await prompt(target(id(), env), options, env);
    return failure("usage", AGENT_USAGE);
  } catch (error) {
    if (error instanceof AgentFailure) return error.result;
    throw error;
  }
}

/** The calling agent's own runtime, from the discovery file its owner names. */
function callerId(env: NodeJS.ProcessEnv): string | undefined {
  return env.PIMUX_DISCOVERY ? path.basename(env.PIMUX_DISCOVERY, ".json") : undefined;
}

function canonical(directory: string): string {
  try { return fs.realpathSync.native(directory); } catch { return path.resolve(directory); }
}

/** Peers share the caller's cwd: roots and interactive forks, never the caller or any worker. */
function list(env: NodeJS.ProcessEnv, all: boolean): JsonRecord[] {
  const records = listRuntimes(env);
  const self = callerId(env);
  const cwd = canonical(records.find((record) => record.muxId === self)?.cwd ?? process.cwd());
  return records
    .filter((record) => all || (record.muxId !== self && record.placement !== "worker" && canonical(record.cwd) === cwd))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((record) => summary(record, self));
}

function summary(record: DiscoveryRecord, self: string | undefined): JsonRecord {
  const sessionFile = record.session?.file ?? null;
  return {
    muxId: record.muxId, placement: record.placement, status: record.status, blocked: record.blocked,
    cwd: record.cwd, startedAt: record.startedAt, updatedAt: record.updatedAt, sessionFile,
    title: shorten(record.session?.name ?? firstPrompt(sessionFile)),
    parent: record.parent ? record.parent.name ?? record.parent.id : null,
    ...record.muxId === self ? { self: true } : {},
  };
}

function shorten(text: string | null): string | null {
  if (!text) return null;
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= 80 ? line : `${line.slice(0, 79)}…`;
}

/** First user prompt within the session file's first MiB; a title fallback only. */
function firstPrompt(file: string | null): string | null {
  if (!file) return null;
  let descriptor: number;
  try { descriptor = fs.openSync(file, "r"); } catch { return null; }
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    const length = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    for (const line of buffer.toString("utf8", 0, length).split("\n")) {
      let entry: unknown;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message) || entry.message.role !== "user") continue;
      const content = entry.message.content;
      return typeof content === "string" ? content : Array.isArray(content)
        ? content.flatMap((part) => isRecord(part) && part.type === "text" ? [String(part.text)] : []).join(" ") : null;
    }
    return null;
  } finally { fs.closeSync(descriptor); }
}

/** An exact muxId or a unique prefix of a live agent; a retained receipt reports exit. */
function target(id: string, env: NodeJS.ProcessEnv): DiscoveryRecord {
  const records = listRuntimes(env);
  const matches = records.filter((record) => record.muxId === id);
  const candidates = matches.length ? matches : records.filter((record) => record.muxId.startsWith(id));
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length > 1) throw new AgentFailure(failure("agent_ambiguous", `${id} matches ${candidates.length} agents`));
  const receipt = terminalReceipt(id, env);
  throw new AgentFailure(receipt ? failure("agent_exited", `Agent ${id} has exited`, EXIT_EXITED, { receipt })
    : failure("agent_not_found", `No live managed agent ${id}`));
}

function terminalReceipt(muxId: string, env: NodeJS.ProcessEnv): unknown {
  try { return lookupTerminalReceipt(muxId, env); } catch { return null; }
}

type Step = (connection: AgentConnection, record: JsonRecord | null, finish: (result: AgentResult) => void) => void;

/** Observes one runtime until `step` finishes, the agent ends or the timeout elapses. */
function follow(record: DiscoveryRecord, timeoutMs: number | undefined, env: NodeJS.ProcessEnv, step: Step,
  cleanup = (): void => {}): Promise<AgentResult> {
  return new Promise((resolve) => {
    let done = false;
    let connection!: AgentConnection;
    const finish = (result: AgentResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      connection.close();
      cleanup();
      resolve(result);
    };
    const timer = timeoutMs === undefined ? undefined
      : setTimeout(() => finish(failure("timeout", `No match within ${timeoutMs} ms`, EXIT_TIMEOUT, connection.live ? connection.status() : {})), timeoutMs);
    try {
      connection = new AgentConnection(record, (update: AgentUpdate) => {
        if (update.kind === "observed") step(connection, update.record, finish);
        else {
          const receipt = terminalReceipt(record.muxId, env);
          finish(update.exit || receipt ? failure("agent_exited", "The agent's Pi exited", EXIT_EXITED, { exit: update.exit, receipt })
            : failure("agent_unavailable", update.error));
        }
      });
    } catch (error) {
      clearTimeout(timer);
      resolve(failure("agent_unavailable", error instanceof Error ? error.message : String(error)));
    }
  });
}

/** The last prompt and the assistant's last text after it. */
function exchange(connection: AgentConnection): { prompt: string | null; answer: string | null } {
  const messages = connection.textMessages();
  const at = messages.findLastIndex((message) => message.role === "user");
  return { prompt: at < 0 ? null : messages[at]!.text,
    answer: messages.slice(at + 1).findLast((message) => message.role === "assistant")?.text ?? null };
}

function read(record: DiscoveryRecord, options: Options, env: NodeJS.ProcessEnv): Promise<AgentResult> {
  return follow(record, options.timeoutMs, env, (connection, _record, finish) => {
    const base = { muxId: record.muxId, ...connection.status(), sessionFile: connection.session?.file ?? null };
    const inFlight = connection.inFlightText();
    if (options.messages !== undefined) {
      const messages = connection.textMessages().slice(-options.messages);
      finish({ exitCode: 0, output: options.format === "text"
        ? [...messages.map((message) => `[${message.role}]\n${message.text}`), ...inFlight ? [`[assistant, streaming]\n${inFlight}`] : []].join("\n\n")
        : { ...base, messages, inFlight } });
      return;
    }
    const { prompt: last, answer } = exchange(connection);
    finish({ exitCode: 0, output: options.format === "text"
      ? [last && `[user]\n${last}`, answer && `[assistant]\n${answer}`, inFlight && `[assistant, streaming]\n${inFlight}`].filter(Boolean).join("\n\n")
      : { ...base, prompt: last, answer, inFlight } });
  });
}

/** Settled means idle or blocked; `--next-turn` ignores states before a run starts after attachment. */
function wait(record: DiscoveryRecord, options: Options, env: NodeJS.ProcessEnv): Promise<AgentResult> {
  if (record.muxId === callerId(env)) throw new AgentFailure(failure("self_target", "An agent cannot wait for itself"));
  const until = new Set<MuxStatus>(options.until.length ? options.until : ["idle", "blocked"]);
  let armed = !options.nextTurn;
  return follow(record, options.timeoutMs, env, (connection, observed, finish) => {
    if (observed?.type === "agent_start") armed = true;
    const status = connection.status();
    if (armed && until.has(status.status)) finish({ exitCode: 0, output: { muxId: record.muxId, ...status, answer: exchange(connection).answer } });
  });
}

/**
 * Submits Pi's RPC prompt once after a complete boundary. A blocked agent needs
 * its user; a working one needs an explicit steer/follow-up. Uncertain delivery
 * is reported, never retried.
 */
function prompt(record: DiscoveryRecord, options: Options, env: NodeJS.ProcessEnv): Promise<AgentResult> {
  const message = options.text.join(" ");
  if (!message.trim() || (options.followUp && options.steer)) throw new AgentFailure(failure("usage", AGENT_USAGE));
  if (record.muxId === callerId(env)) throw new AgentFailure(failure("self_target", "An agent cannot prompt itself"));
  const until = new Set<MuxStatus>(options.until.length ? options.until : ["idle", "blocked"]);
  const behavior = options.followUp ? "followUp" : options.steer ? "steer" : undefined;
  const request = new AbortController();
  let sending = false;
  let started = false;
  let disposition: string | undefined;
  let stall: ReturnType<typeof setTimeout> | undefined;
  return follow(record, options.timeoutMs, env, (connection, observed, finish) => {
    const check = (): void => {
      const status = connection.status();
      const armed = disposition === "queued" || (disposition === "started" && started);
      if (armed && until.has(status.status)) finish({ exitCode: 0, output: { muxId: record.muxId, disposition, ...status, answer: exchange(connection).answer } });
    };
    if (sending) {
      if (observed?.type === "agent_start") started = true;
      check();
      return;
    }
    const status = connection.status();
    if (status.status === "blocked") return finish(failure("agent_blocked", "The agent waits for its user; no input was sent", EXIT_ERROR, { blocked: status.blocked }));
    if (status.status !== "idle" && !behavior) return finish(failure("agent_working", "The agent is working; use --follow-up or --steer", EXIT_ERROR, status));
    const sessionFile = connection.session?.file;
    if (!sessionFile || record.piPid === null) return finish(failure("agent_unavailable", "The agent has no committed session"));
    sending = true;
    // The observing connection is already live, so every record after submission is seen.
    runtimeRequest({ protocol: 2, operationId: record.operationId ?? "", muxId: record.muxId, socket: record.socket, pid: record.pid,
      piPid: record.piPid, sessionFile, state: "committed", outcome: "attached" },
    { type: "prompt", message, ...behavior ? { streamingBehavior: behavior } : {} }, request.signal).then((response) => {
      if (response.success !== true) return finish(failure("prompt_rejected", String(response.error ?? "Pi rejected the prompt")));
      disposition = isRecord(response.data) && typeof response.data.disposition === "string" ? response.data.disposition : "started";
      if (!options.wait || disposition === "handled") return finish({ exitCode: 0, output: { muxId: record.muxId, disposition, ...connection.status() } });
      if (disposition === "started" && !started) {
        stall = setTimeout(() => { if (!started) finish(failure("agent_prompt_stalled", "Pi accepted the prompt but no run started; it was not resent", EXIT_ERROR, { disposition })); }, STALL_MS);
      }
      check();
    }, (error: unknown) => {
      const text = error instanceof Error ? error.message : String(error);
      finish(failure(text.includes("may have been accepted") ? "prompt_uncertain" : "agent_unavailable", text));
    });
  }, () => { clearTimeout(stall); request.abort(); });
}
