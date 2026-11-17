// Ugo's repository side: phase commits, worktree status and human decision signals.
import { execFile } from "node:child_process";
import {
  access,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PresentGuidanceParams } from "./guidance-core.ts";
import { phaseActor } from "./ugo-messages.ts";
import type { UgoState } from "./ugo-state.ts";
import { WORKFLOW_FILE } from "./workflow-core.ts";

export const WORKBOARD_FILE = "workboard.md";
export const DECISIONS_DIR = join("scratch", "decisions");

const execFileAsync = promisify(execFile);

export interface DecisionSignal {
  kind: "DONE" | "CLARIFY";
  path: string;
  line: string;
  content: string;
}

async function runGit(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

export async function gitStatus(cwd: string): Promise<string> {
  const result = await runGit(cwd, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  return result.stdout.trimEnd();
}

function commitSubject(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "ugo: checkpoint";
  const subject = `ugo: ${normalized}`;
  return subject.length <= 72
    ? subject
    : `${subject.slice(0, 69).trimEnd()}...`;
}

function guidanceDetails(guidance: PresentGuidanceParams | undefined): string {
  if (!guidance) return "(none)";
  return [
    `Status: ${guidance.status}`,
    `Item: ${guidance.item}`,
    `Reason: ${guidance.reason}`,
    guidance.artifact ? `Artifact: ${guidance.artifact}` : undefined,
    guidance.notes ? `Notes: ${guidance.notes}` : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function commitMessage(params: {
  phase: "guide" | "do";
  prompt: string;
  response: string;
  state: UgoState;
  guidance?: PresentGuidanceParams;
  sessionFile?: string;
}): string {
  const item =
    params.guidance?.item ??
    params.state.previousGuidance?.item ??
    params.state.lastGuidance?.item ??
    params.state.phase;
  const actor = phaseActor(params.phase);
  return [
    commitSubject(item),
    "",
    `${actor} phase`,
    `ugo loop iteration: ${params.state.iteration}`,
    params.sessionFile ? `Session: ${params.sessionFile}` : undefined,
    "",
    "ugo-guide result:",
    guidanceDetails(
      params.guidance ??
        params.state.previousGuidance ??
        params.state.lastGuidance,
    ),
    "",
    `${actor} prompt:`,
    params.prompt.trim() || "(empty)",
    "",
    `${actor} result:`,
    params.response.trim() || "(no assistant text captured)",
    "",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export async function commitIfNeeded(params: {
  cwd: string;
  phase: "guide" | "do";
  prompt: string;
  response: string;
  state: UgoState;
  guidance?: PresentGuidanceParams;
  sessionFile?: string;
}): Promise<boolean> {
  if ((await gitStatus(params.cwd)).length === 0) return false;

  await runGit(params.cwd, ["add", "-A"]);
  if ((await gitStatus(params.cwd)).length === 0) return false;

  const tempDir = await mkdtemp(join(tmpdir(), "pi-ugo-commit-"));
  const messagePath = join(tempDir, "message.txt");
  try {
    await writeFile(messagePath, commitMessage(params), "utf8");
    await runGit(params.cwd, ["commit", "-F", messagePath]);
    return true;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function hasWorkboard(cwd: string): Promise<boolean> {
  try {
    await access(join(cwd, WORKBOARD_FILE));
    return true;
  } catch {
    return false;
  }
}

function findDecisionSignal(
  path: string,
  content: string,
): DecisionSignal | undefined {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const match = /^\s*(DONE|CLARIFY)(?::\s*(.*))?\s*$/i.exec(line);
    if (!match) continue;
    const kind = match[1]?.toUpperCase();
    if (kind !== "DONE" && kind !== "CLARIFY") continue;
    return { kind, path, line: line.trim(), content };
  }
  return undefined;
}

async function readDecisionSignal(
  cwd: string,
  path: string,
): Promise<DecisionSignal | undefined> {
  try {
    return findDecisionSignal(path, await readFile(join(cwd, path), "utf8"));
  } catch {
    return undefined;
  }
}

async function decisionSignalPaths(cwd: string): Promise<string[]> {
  const paths = [WORKBOARD_FILE];
  try {
    const entries = await readdir(join(cwd, DECISIONS_DIR), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (entry.isFile()) paths.push(join(DECISIONS_DIR, entry.name));
    }
  } catch {
    // No decision directory yet.
  }
  return paths;
}

export async function scanDecisionSignals(
  cwd: string,
): Promise<DecisionSignal | undefined> {
  for (const path of await decisionSignalPaths(cwd)) {
    const signal = await readDecisionSignal(cwd, path);
    if (signal) return signal;
  }
  return undefined;
}

function statusPath(line: string): string {
  const rawPath = line.slice(3);
  const renameIndex = rawPath.indexOf(" -> ");
  return renameIndex >= 0
    ? rawPath.slice(renameIndex + " -> ".length)
    : rawPath;
}

function isWorkflowStatePath(path: string): boolean {
  const normalized = path.startsWith("./") ? path.slice(2) : path;
  return (
    normalized === WORKBOARD_FILE ||
    normalized === WORKFLOW_FILE ||
    normalized.startsWith("scratch/")
  );
}

export function statusOnlyTouchesWorkflowState(status: string): boolean {
  if (!status.trim()) return true;
  return status
    .split(/\r?\n/)
    .every((line) => isWorkflowStatePath(statusPath(line)));
}

function isScratchDecisionPath(path: string): boolean {
  const normalized = path.startsWith("./") ? path.slice(2) : path;
  return normalized.startsWith(`${DECISIONS_DIR}/`);
}

export function statusTouchesDecisionArtifacts(status: string): boolean {
  if (!status.trim()) return false;
  return status
    .split(/\r?\n/)
    .some((line) => isScratchDecisionPath(statusPath(line)));
}
