/** Linux process identities. PID alone is never evidence of continued ownership. */
import * as fs from "node:fs";

export interface ProcessIdentity {
  pid: number;
  startTime: string;
  bootId: string;
}

export type ProcessIdentityStatus = "alive" | "dead" | "unknown";

export class ProcessIdentityError extends Error {
  constructor(pid: number, cause: unknown) {
    super(`Cannot establish identity of potentially live process ${pid}`, { cause });
    this.name = "ProcessIdentityError";
  }
}

/** A zombie has exited and cannot write, even before its parent reaps the PID. */
export function readProcessIdentity(pid: number): ProcessIdentity | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new RangeError("Process PID must be a positive integer");
  let stat: string;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    try {
      process.kill(pid, 0);
    } catch (probe) {
      if ((probe as NodeJS.ErrnoException).code === "ESRCH") return undefined;
      throw new ProcessIdentityError(pid, probe);
    }
    throw new ProcessIdentityError(pid, error);
  }
  const close = stat.lastIndexOf(")");
  const fields = close < 0 ? [] : stat.slice(close + 2).trim().split(/\s+/);
  if (fields[0] === "Z" || fields[0] === "X" || fields[0] === "x") return undefined;
  const startTime = fields[19];
  if (!startTime || !/^\d+$/.test(startTime)) throw new ProcessIdentityError(pid, new Error("Malformed /proc stat"));
  let bootId: string;
  try {
    bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch (error) {
    throw new ProcessIdentityError(pid, error);
  }
  if (!bootId) throw new ProcessIdentityError(pid, new Error("Missing Linux boot identity"));
  return { pid, startTime, bootId };
}

export function processIdentityStatus(identity: ProcessIdentity): ProcessIdentityStatus {
  try {
    const current = readProcessIdentity(identity.pid);
    return current && current.startTime === identity.startTime && current.bootId === identity.bootId ? "alive" : "dead";
  } catch {
    return "unknown";
  }
}

/** Unknown liveness is conservatively present; zombies and reused identities are absent. */
export function processExists(processOrIdentity: number | ProcessIdentity): boolean {
  if (typeof processOrIdentity !== "number") return processIdentityStatus(processOrIdentity) !== "dead";
  if (!Number.isSafeInteger(processOrIdentity) || processOrIdentity <= 0) return false;
  try {
    return readProcessIdentity(processOrIdentity) !== undefined;
  } catch {
    return true;
  }
}

export function sameProcessIdentity(a: ProcessIdentity, b: ProcessIdentity): boolean {
  return a.pid === b.pid && a.startTime === b.startTime && a.bootId === b.bootId;
}
