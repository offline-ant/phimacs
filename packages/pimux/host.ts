import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { getAgentDir, parseArgs } from "@earendil-works/pi-coding-agent";
import { canonicalSessionPath } from "./ownership.ts";

export function servesRpc(args: readonly string[]): boolean {
  const parsed = parseArgs([...args]);
  return parsed.mode === "rpc" && !parsed.help && !parsed.version && parsed.listModels === undefined && !parsed.export;
}

export function intendedSessionFile(args: readonly string[], cwd: string): string | null {
  const value = parseArgs([...args]).session;
  if (!value || !(value.includes("/") || value.includes("\\") || value.endsWith(".jsonl"))) return null;
  return path.resolve(cwd, value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value);
}

/** Use Pi's public parser, never raw flag-index guesses which can mistake option values for flags. */
export function withExactOption(args: readonly string[], option: "session" | "export" | "provider" | "model" | "thinking", value: string): string[] {
  const separator = args.indexOf("--");
  const options = separator < 0 ? args : args.slice(0, separator);
  const flag = `--${option}`;
  // Replace earlier occurrences: restored roots and session changes reapply
  // options to journalled arguments, which would otherwise grow per restart.
  const kept = options.filter((arg, index) => !(arg === flag && index + 1 < options.length)
    && !(index > 0 && options[index - 1] === flag));
  const result = [...kept, flag, value, ...(separator < 0 ? [] : args.slice(separator))];
  const before = parseArgs([...args]);
  const after = parseArgs(result);
  const shape = (parsed: ReturnType<typeof parseArgs>): string => JSON.stringify({ ...parsed, [option]: undefined, unknownFlags: [...parsed.unknownFlags] });
  if (after[option] !== value || shape(before) !== shape(after)) throw new Error("Managed arguments require explicit option values before the exact session/export operand");
  return result;
}

/** Selection is read-only and exact. Native selectors must resolve before managed launch. */
export function exactSessionArgs(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, allowInitialMessages = false): { args: string[]; file: string } {
  const parsed = parseArgs([...args]);
  if (parsed.diagnostics.some((item) => item.type === "error")) throw new Error("Invalid Pi arguments; resolve diagnostics before managed launch");
  if (parsed.noSession || parsed.continue || parsed.resume || parsed.fork) {
    throw new Error("Managed launch requires an exact persistent --session path; resolve continue/resume/fork selectors before launch");
  }
  if (!allowInitialMessages && (parsed.messages.length || parsed.fileArgs.length || parsed.print)) throw new Error("Managed RPC startup accepts no initial messages; submit input explicitly after pimux_live");
  let file = intendedSessionFile(args, cwd);
  if (!file && parsed.session !== undefined) throw new Error("Resolve the session ID to an exact absolute path before managed launch");
  if (!file) {
    const base = parsed.sessionDir ? path.resolve(cwd, parsed.sessionDir)
      : env.PHIMACS_TEST_ROOT ? path.join(env.PHIMACS_TEST_ROOT, "sessions")
        : env.PI_CODING_AGENT_SESSION_DIR || path.join(env.PI_CODING_AGENT_DIR || getAgentDir(), "sessions", "phimacs");
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    file = path.join(base, `${Date.now()}-${randomUUID()}.jsonl`);
  }
  const canonical = canonicalSessionPath(file);
  return { args: withExactOption(args, "session", canonical), file: canonical };
}
