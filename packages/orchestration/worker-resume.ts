import { basename, dirname, resolve } from "node:path";
import { getAgentDir, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { EphemeralWorkerTool } from "./delegate-policy.ts";
import { REMOTE_ENV } from "./remote-session.ts";
import type { WorkerRequestFile } from "./worker-frame.ts";
import { managedHost, managedPimuxExecutable } from "./managed-launch.ts";

export const WORKER_ENTRY = "pi-orchestration:worker";

/** Everything needed to start a worker again; persisted on the parent's branch at each start. */
export interface WorkerRecord {
  name: string;
  tool: EphemeralWorkerTool;
  sessionFile: string;
  sessionId: string;
  cwd: string;
  args: string[];
  env?: Record<string, string>;
  remote?: string;
  model: { provider: string; id: string };
  thinkingLevel: WorkerRequestFile["thinkingLevel"];
}

/** The latest start of a worker on this branch; a name absent from it belongs to another conversation. */
export function findWorkerRecord(branch: readonly SessionEntry[], name: string): WorkerRecord | undefined {
  const entry = branch.findLast((candidate) => candidate.type === "custom" && candidate.customType === WORKER_ENTRY
    && (candidate.data as WorkerRecord).name === name);
  return entry?.type === "custom" ? entry.data as WorkerRecord : undefined;
}

/** Model-visible, because Pi discards an error's details. */
export function workerStoppedNotice(name: string): string {
  return `Worker ${name} stopped. Its conversation is saved; continue it with do({resume: "${name}", task: "..."}).`;
}

/**
 * Reopen the saved transcript, not the private worker request. Pi restores its cwd;
 * a remote worker's SSH target is restored explicitly, and never inherited otherwise.
 */
export function workerResumeCommand(sessionFile: string, remote?: string): string {
  const quote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;
  // A resume launched from another Pi's shell must not inherit its worker identity
  // or bind its private input socket. Do not copy host endpoints or credentials.
  const host = managedHost();
  const args = ["env", ...["PI_NESTED", "PI_ORCHESTRATION_CONTROL", "PI_ORCHESTRATION_TARGET",
    "PI_ORCHESTRATION_PLACEMENT", "PI_ORCHESTRATION_PARENT", "PI_ORCHESTRATION_HOST", "PI_ORCHESTRATION_ENDPOINT",
    "PHIMACS_MANAGED_CLAIM", "PHIMACS_PARENT_TASK", "PHIMACS_PARENT_TASK_FILE", "PIMUX_DISCOVERY"].flatMap((key) => ["-u", key])];
  args.push(...remote === undefined ? ["-u", REMOTE_ENV] : [quote(`${REMOTE_ENV}=${remote}`)]);
  if (process.env.PI_CODING_AGENT_DIR) args.push(quote(`PI_CODING_AGENT_DIR=${resolve(getAgentDir())}`));
  args.push(quote(process.execPath), quote(managedPimuxExecutable()), "tui", "--", quote(host.executable), "--session", quote(resolve(sessionFile)));
  return args.join(" ");
}

/** Pilish's `details.savedConversations` declaration: a read-only link to the worker's transcript. */
export interface SavedConversations {
  version: 1;
  root: string;
  items: { sessionId: string; file: string; label: string }[];
}

export function workerSavedConversations(sessionFile: string, sessionId: string, label: string): SavedConversations {
  const file = resolve(sessionFile);
  return { version: 1, root: dirname(file), items: [{ sessionId, file: basename(file), label }] };
}

export function workerResumeHint(command: string): string {
  return `To resume/continue after the worker stops, run:\n${command}\nOpens an ordinary session; enter a prompt to continue.`;
}
