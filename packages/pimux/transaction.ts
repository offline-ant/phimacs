/** Synchronous cooperative filesystem transactions; no Pi or frontend dependency. */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { processIdentityStatus, readProcessIdentity, type ProcessIdentity } from "./process-identity.ts";
import { createPrivateJson, ensurePrivateDirectory, writePrivateJson } from "./private-files.ts";

export class TransactionError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "TransactionError";
  }
}

export interface TransactionOptions {
  /** A live or uncertain participant is never stolen, including on timeout. */
  timeoutMs?: number;
}

interface Ticket { schema: 1; id: string; process: ProcessIdentity; choosing: boolean; number: number }
const TICKET_NAME = /^[a-f0-9]{64}\.json$/;
const WAIT = new Int32Array(new SharedArrayBuffer(4));
const active = new Set<string>();

function readTicket(directory: string, name: string): Ticket | undefined {
  const file = path.join(directory, name);
  let value: unknown;
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 4096) {
        throw new TransactionError(`Transaction ticket must be user-owned, mode 0600 and bounded: ${file}`);
      }
      value = JSON.parse(fs.readFileSync(fd, "utf8"));
    } finally { fs.closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new TransactionError(`Unreadable transaction ticket: ${file}`, error);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TransactionError(`Invalid transaction ticket: ${file}`);
  const ticket = value as Record<string, unknown>;
  const identity = ticket.process as Partial<ProcessIdentity> | null;
  if (ticket.schema !== 1 || ticket.id !== name.slice(0, -5) || !identity || typeof identity !== "object"
    || !Number.isSafeInteger(identity.pid) || Number(identity.pid) <= 0
    || typeof identity.startTime !== "string" || !/^\d+$/.test(identity.startTime)
    || typeof identity.bootId !== "string" || identity.bootId.length === 0
    || typeof ticket.choosing !== "boolean" || !Number.isSafeInteger(ticket.number)
    || (ticket.choosing ? ticket.number !== 0 : Number(ticket.number) <= 0)) {
    throw new TransactionError(`Invalid transaction ticket: ${file}`);
  }
  return value as Ticket;
}

/**
 * Lamport bakery exclusion over atomic complete ticket publications. Every attempt
 * owns a distinct exclusive participant pathname, never a reused lock pathname.
 * A dead attempt therefore cannot be confused with a later live lock holder.
 * The action must finish synchronously. Keep the private directory for its lifetime;
 * deleting/replacing a transaction namespace requires stopping all participants.
 */
export function withTransaction<T>(directory: string, action: () => T, options: TransactionOptions = {}): T {
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new RangeError("Transaction timeout must be a positive integer");
  directory = path.resolve(directory);
  ensurePrivateDirectory(directory);
  if (active.has(directory)) throw new TransactionError("A synchronous transaction cannot re-enter its own namespace");
  const identity = readProcessIdentity(process.pid);
  if (!identity) throw new TransactionError("Cannot establish transaction process identity");
  const ticket: Ticket = { schema: 1, id: randomBytes(32).toString("hex"), process: identity, choosing: true, number: 0 };
  const ownName = `${ticket.id}.json`;
  const ownFile = path.join(directory, ownName);
  // Exclusive publication failure never removes another attempt's ticket.
  createPrivateJson(ownFile, ticket);
  active.add(directory);
  const participants = (): string[] => fs.readdirSync(directory).filter((name) => TICKET_NAME.test(name));
  const liveTicket = (name: string): Ticket | undefined => {
    const other = readTicket(directory, name);
    if (!other || processIdentityStatus(other.process) !== "dead") return other;
    // Distinct never-reused attempt names make concurrent crash recovery safe.
    // A dead participant cannot update its own ticket or publish a successor here.
    const current = readTicket(directory, name);
    if (current) {
      if (JSON.stringify(current) !== JSON.stringify(other)) throw new TransactionError("Transaction participant changed during stale recovery; retry explicitly");
      fs.rmSync(path.join(directory, name), { force: true });
    }
    return undefined;
  };
  try {
    let maximum = 0;
    for (const name of participants()) maximum = Math.max(maximum, liveTicket(name)?.number ?? 0);
    if (maximum >= Number.MAX_SAFE_INTEGER) throw new TransactionError("Transaction counter exhausted");
    ticket.number = maximum + 1;
    ticket.choosing = false;
    writePrivateJson(ownFile, ticket);
    const deadline = performance.now() + timeoutMs;
    for (const name of participants()) {
      if (name === ownName) continue;
      for (;;) {
        const other = liveTicket(name);
        if (!other || !other.choosing && (other.number > ticket.number || other.number === ticket.number && other.id > ticket.id)) break;
        if (performance.now() >= deadline) throw new TransactionError("A live or uncertain transaction did not finish; retry explicitly");
        Atomics.wait(WAIT, 0, 0, 2);
      }
    }
    return action();
  } finally {
    try { fs.rmSync(ownFile, { force: true }); } finally { active.delete(directory); }
  }
}
