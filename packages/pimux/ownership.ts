/**
 * Cooperative session writer claims, shared by RPC and native managed launchers.
 * All pathname/inode indexes change under one cross-process filesystem mutex.
 * This does not lock raw Pi storage, an arbitrary editor, or other nonparticipants.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { processIdentityStatus, sameProcessIdentity, type ProcessIdentity } from "./process-identity.ts";
import { TransactionError, withTransaction } from "./transaction.ts";
import { createPrivateJson, ensurePrivateDirectory, writePrivateJson } from "./private-files.ts";

export interface ClaimOwner {
  id: string;
  kind: "rpc" | "tui" | "lease";
  wrapper: ProcessIdentity;
  pi: ProcessIdentity | null;
  socket?: string;
  protocol?: number;
  operationId?: string;
}

export interface ClaimOptions {
  /** Only accepted for a marked private /tmp/phimacs-test-* tree. */
  testRoot?: string;
}

export interface ClaimRecord {
  schema: 1;
  file: string;
  token: string;
  owner: ClaimOwner;
  aliases: string[];
  inodes: string[];
  createdAt: string;
  updatedAt: string;
}

/** Serializable capability; transfer changes the owner and invalidates stale handles. */
export interface ClaimHandle {
  file: string;
  token: string;
  owner: ClaimOwner;
  testRoot?: string;
}

export class ClaimConflictError extends Error {
  readonly claim: ClaimRecord;
  readonly code: "CLAIM_CONFLICT" | "CLAIM_PATH_CHANGED";
  constructor(claim: ClaimRecord, changed = false) {
    super(changed ? `Claimed session path changed: ${claim.file}` : `Session is owned by ${claim.owner.kind} ${claim.owner.id}: ${claim.file}`);
    this.name = "ClaimConflictError";
    this.claim = claim;
    this.code = changed ? "CLAIM_PATH_CHANGED" : "CLAIM_CONFLICT";
  }
}

export class ClaimStoreError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ClaimStoreError";
  }
}

interface Store { root: string; records: string; keys: string; tickets: string; testRoot?: string; sessions?: string }
const TOKEN = /^[a-f0-9]{64}$/;
const TEST_ROOT = /^\/tmp\/phimacs-test-[A-Za-z0-9_-]+$/;

function privateText(file: string): string {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
      throw new ClaimStoreError(`Claim file must be user-owned and mode 0600: ${file}`);
    }
    return fs.readFileSync(fd, "utf8");
  } finally { fs.closeSync(fd); }
}

function within(file: string, dir: string): boolean {
  return file !== dir && file.startsWith(`${dir}${path.sep}`);
}

/** Resolves existing ancestors too, so a not-yet-created destination has one identity. */
export function canonicalSessionPath(file: string): string {
  const absolute = path.resolve(file);
  try { return fs.realpathSync.native(absolute); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) return canonicalSessionPath(path.resolve(path.dirname(absolute), fs.readlinkSync(absolute)));
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code !== "ENOENT") throw failure;
    }
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    return path.join(canonicalSessionPath(parent), path.basename(absolute));
  }
}

function storeFor(options: ClaimOptions = {}): Store {
  const testRoot = options.testRoot ?? process.env.PHIMACS_TEST_ROOT;
  if (options.testRoot && process.env.PHIMACS_TEST_ROOT && options.testRoot !== process.env.PHIMACS_TEST_ROOT) {
    throw new ClaimStoreError("Conflicting synthetic claim namespaces");
  }
  let root: string;
  let sessions: string | undefined;
  if (testRoot !== undefined) {
    if (!TEST_ROOT.test(testRoot) || fs.realpathSync.native(testRoot) !== testRoot) throw new ClaimStoreError("Invalid synthetic claim root");
    ensurePrivateDirectory(testRoot);
    let marker: unknown;
    try { marker = JSON.parse(privateText(path.join(testRoot, ".phimacs-test"))); } catch (error) {
      throw new ClaimStoreError("Synthetic claim root requires its test marker", error);
    }
    if (!isObject(marker) || marker.schema !== 1 || marker.uid !== process.getuid?.()) throw new ClaimStoreError("Invalid synthetic claim marker");
    sessions = path.join(testRoot, "sessions");
    ensurePrivateDirectory(sessions);
    root = path.join(testRoot, "claims");
  } else {
    if (process.platform !== "linux" || process.getuid === undefined) throw new ClaimStoreError("Session claims require Linux process identities");
    root = `/tmp/phimacs-session-claims-${process.getuid()}`;
  }
  ensurePrivateDirectory(root);
  const result: Store = { root, records: path.join(root, "records"), keys: path.join(root, "keys"), tickets: path.join(root, "tickets"),
    ...testRoot === undefined ? {} : { testRoot }, ...sessions === undefined ? {} : { sessions } };
  for (const dir of [result.records, result.keys, result.tickets]) ensurePrivateDirectory(dir);
  return result;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validProcess(value: unknown): value is ProcessIdentity {
  return isObject(value) && Number.isSafeInteger(value.pid) && Number(value.pid) > 0
    && typeof value.startTime === "string" && /^\d+$/.test(value.startTime)
    && typeof value.bootId === "string" && value.bootId.length > 0;
}

function validOwner(value: unknown): value is ClaimOwner {
  return isObject(value) && typeof value.id === "string" && value.id.length > 0
    && (value.kind === "rpc" || value.kind === "tui" || value.kind === "lease")
    && validProcess(value.wrapper) && (value.pi === null || validProcess(value.pi))
    && (value.socket === undefined || typeof value.socket === "string")
    && (value.protocol === undefined || Number.isSafeInteger(value.protocol))
    && (value.operationId === undefined || typeof value.operationId === "string");
}

function ownerEqual(a: ClaimOwner, b: ClaimOwner): boolean {
  return a.id === b.id && a.kind === b.kind && sameProcessIdentity(a.wrapper, b.wrapper)
    && (a.pi === null ? b.pi === null : b.pi !== null && sameProcessIdentity(a.pi, b.pi))
    && a.socket === b.socket && a.protocol === b.protocol && a.operationId === b.operationId;
}

function ownerDead(owner: ClaimOwner): boolean {
  return processIdentityStatus(owner.wrapper) === "dead" && (owner.pi === null || processIdentityStatus(owner.pi) === "dead");
}

function locked<T>(store: Store, action: () => T): T {
  try { return withTransaction(store.tickets, action); } catch (error) {
    if (error instanceof TransactionError) throw new ClaimStoreError(error.message, error);
    throw error;
  }
}

function recordFile(store: Store, token: string): string {
  if (!TOKEN.test(token)) throw new ClaimStoreError("Invalid claim capability");
  return path.join(store.records, `${token}.json`);
}

function readRecord(store: Store, token: string): ClaimRecord {
  let value: unknown;
  try { value = JSON.parse(privateText(recordFile(store, token))); } catch (error) { throw new ClaimStoreError(`Unreadable session claim ${token}`, error); }
  if (!isObject(value) || value.schema !== 1 || value.token !== token || typeof value.file !== "string"
    || !path.isAbsolute(value.file) || !validOwner(value.owner)
    || !Array.isArray(value.aliases) || !value.aliases.every((alias) => typeof alias === "string" && path.isAbsolute(alias))
    || !Array.isArray(value.inodes) || !value.inodes.every((inode) => typeof inode === "string" && /^\d+:\d+$/.test(inode))
    || typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") throw new ClaimStoreError(`Invalid session claim ${token}`);
  return value as unknown as ClaimRecord;
}

const pathKey = (file: string): string => `path-${createHash("sha256").update(file).digest("hex")}`;
const inodeKey = (inode: string): string => `inode-${inode.replace(":", "-")}`;

function keyToken(store: Store, key: string): string | undefined {
  try {
    const token = privateText(path.join(store.keys, key)).trim();
    if (!TOKEN.test(token)) throw new ClaimStoreError(`Invalid session claim index: ${key}`);
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function installKey(store: Store, key: string, token: string): void {
  const existing = keyToken(store, key);
  if (existing === token) return;
  if (existing) throw new ClaimConflictError(readRecord(store, existing));
  fs.writeFileSync(path.join(store.keys, key), `${token}\n`, { flag: "wx", mode: 0o600 });
}

function removeRecord(store: Store, record: ClaimRecord): void {
  if (JSON.stringify(readRecord(store, record.token)) !== JSON.stringify(record)) {
    throw new ClaimStoreError("Session claim changed before removal; ownership remains uncertain");
  }
  // Include keys from interrupted transactions; a crash may precede record update.
  for (const key of fs.readdirSync(store.keys)) {
    if (keyToken(store, key) === record.token) fs.unlinkSync(path.join(store.keys, key));
  }
  fs.unlinkSync(recordFile(store, record.token));
}

function fileInode(file: string): string | undefined {
  try {
    const stat = fs.statSync(file, { bigint: true });
    if (!stat.isFile()) throw new ClaimStoreError(`Session path is not a regular file: ${file}`);
    return `${stat.dev}:${stat.ino}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function validateTarget(store: Store, file: string): { requested: string; canonical: string; inode?: string } {
  const requested = path.resolve(file);
  const canonical = canonicalSessionPath(requested);
  if (store.sessions) {
    if (!within(requested, store.sessions) || !within(canonical, store.sessions)) {
      throw new ClaimStoreError("Synthetic claim namespaces cannot authorize files outside their sessions directory");
    }
    const stat = fs.existsSync(canonical) ? fs.statSync(canonical, { bigint: true }) : undefined;
    if (stat && stat.nlink > 1n) {
      // A hardlink into the synthetic root must not authorize an external inode.
      let found = 0n;
      const walk = (dir: string): void => {
        for (const name of fs.readdirSync(dir)) {
          const entry = path.join(dir, name);
          const candidate = fs.lstatSync(entry, { bigint: true });
          if (candidate.isDirectory()) walk(entry);
          else if (candidate.isFile() && candidate.dev === stat.dev && candidate.ino === stat.ino) found++;
        }
      };
      walk(store.sessions);
      if (found !== stat.nlink) throw new ClaimStoreError("Synthetic claim file has a hardlink outside its sessions directory");
    }
  }
  const inode = fileInode(canonical);
  return { requested, canonical, ...inode === undefined ? {} : { inode } };
}

function refreshRecord(store: Store, record: ClaimRecord): ClaimRecord {
  const target = validateTarget(store, record.file);
  if (target.canonical !== record.file) throw new ClaimConflictError(record, true);
  // A process can die after publishing its record but before finishing indexes.
  // Rebuild those indexes while serialized, including still-absent destinations.
  for (const alias of record.aliases) installKey(store, pathKey(alias), record.token);
  for (const inode of record.inodes) installKey(store, inodeKey(inode), record.token);
  let changed = false;
  if (target.inode && !record.inodes.includes(target.inode)) {
    installKey(store, inodeKey(target.inode), record.token);
    record.inodes.push(target.inode);
    changed = true;
  }
  if (changed) {
    record.updatedAt = new Date().toISOString();
    writePrivateJson(recordFile(store, record.token), record);
  }
  return record;
}

/** Bind files created since their pre-spawn path claim before accepting aliases. */
function refreshStore(store: Store): void {
  for (const name of fs.readdirSync(store.records)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const record = readRecord(store, name.slice(0, -5));
    if (ownerDead(record.owner)) removeRecord(store, record);
    else {
      try { refreshRecord(store, record); } catch (error) {
        // A retargeted old path remains claimed. Its own lookup/reconcile refuses;
        // unrelated paths do not lose access to the entire per-user namespace.
        if (!(error instanceof ClaimConflictError) || error.code !== "CLAIM_PATH_CHANGED") throw error;
      }
    }
  }
}

function findClaim(store: Store, file: string): ClaimRecord | undefined {
  const target = validateTarget(store, file);
  const keys = [pathKey(target.requested), pathKey(target.canonical), ...target.inode ? [inodeKey(target.inode)] : []];
  let result: ClaimRecord | undefined;
  for (const key of keys) {
    const token = keyToken(store, key);
    if (!token) continue;
    const record = readRecord(store, token);
    if (result && result.token !== token) throw new ClaimConflictError(record);
    result = record;
  }
  if (result && result.aliases.includes(target.requested) && target.canonical !== result.file) throw new ClaimConflictError(result, true);
  return result;
}

export function acquireClaim(file: string, owner: ClaimOwner, options: ClaimOptions = {}): ClaimHandle {
  if (!validOwner(owner)) throw new ClaimStoreError("Invalid session claim owner");
  const store = storeFor(options);
  return locked(store, () => {
    refreshStore(store);
    const existing = findClaim(store, file);
    if (existing) throw new ClaimConflictError(existing);
    const target = validateTarget(store, file);
    const token = randomBytes(32).toString("hex");
    const now = new Date().toISOString();
    const record: ClaimRecord = { schema: 1, file: target.canonical, token, owner: structuredClone(owner),
      aliases: [...new Set([target.requested, target.canonical])], inodes: target.inode ? [target.inode] : [], createdAt: now, updatedAt: now };
    createPrivateJson(recordFile(store, token), record);
    try {
      for (const alias of record.aliases) installKey(store, pathKey(alias), token);
      for (const inode of record.inodes) installKey(store, inodeKey(inode), token);
    } catch (error) { removeRecord(store, record); throw error; }
    return { file: record.file, token, owner: structuredClone(owner), ...store.testRoot ? { testRoot: store.testRoot } : {} };
  });
}

export function lookupClaim(file: string, options: ClaimOptions = {}): ClaimRecord | undefined {
  const store = storeFor(options);
  return locked(store, () => { refreshStore(store); return findClaim(store, file); });
}

/** Exact owner enumeration lets a long-lived launcher release transition reservations after Pi exits. */
export function claimsForOwner(owner: Pick<ClaimOwner, "id" | "wrapper">, options: ClaimOptions = {}): ClaimRecord[] {
  const store = storeFor(options);
  return locked(store, () => {
    refreshStore(store);
    return fs.readdirSync(store.records).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .map((name) => readRecord(store, name.slice(0, -5)))
      .filter((record) => record.owner.id === owner.id && sameProcessIdentity(record.owner.wrapper, owner.wrapper));
  });
}

function heldRecord(store: Store, handle: ClaimHandle): ClaimRecord {
  const record = readRecord(store, handle.token);
  if (record.file !== handle.file || !ownerEqual(record.owner, handle.owner)) throw new ClaimStoreError("Claim capability no longer names its current owner");
  return record;
}

export function updateClaim(handle: ClaimHandle, owner: ClaimOwner): void {
  if (!validOwner(owner)) throw new ClaimStoreError("Invalid session claim owner");
  const store = storeFor(handle.testRoot ? { testRoot: handle.testRoot } : {});
  locked(store, () => {
    const record = heldRecord(store, handle);
    record.owner = structuredClone(owner);
    record.updatedAt = new Date().toISOString();
    writePrivateJson(recordFile(store, record.token), record);
    handle.owner = structuredClone(owner);
  });
}

export function reconcileClaim(handle: ClaimHandle): void {
  const store = storeFor(handle.testRoot ? { testRoot: handle.testRoot } : {});
  locked(store, () => {
    const record = heldRecord(store, handle);
    for (const alias of record.aliases) {
      const target = validateTarget(store, alias);
      if (target.canonical !== record.file) throw new ClaimConflictError(record, true);
    }
    refreshRecord(store, record);
  });
}

/** Caller must first establish that no writer can still use this claim. */
export function releaseClaim(handle: ClaimHandle): void {
  const store = storeFor(handle.testRoot ? { testRoot: handle.testRoot } : {});
  locked(store, () => removeRecord(store, heldRecord(store, handle)));
}

export interface ClaimTestEnvironment {
  root: string;
  sessions: string;
  claims: string;
  options: ClaimOptions;
  env: NodeJS.ProcessEnv;
}

/** Creates isolation only; callers must use synthetic files and remove their tree. */
export function createClaimTestEnvironment(root?: string): ClaimTestEnvironment {
  const dir = root ?? fs.mkdtempSync("/tmp/phimacs-test-");
  if (!TEST_ROOT.test(dir)) throw new ClaimStoreError("Invalid synthetic claim root");
  ensurePrivateDirectory(dir);
  const marker = path.join(dir, ".phimacs-test");
  if (!fs.existsSync(marker)) createPrivateJson(marker, { schema: 1, uid: process.getuid?.(), token: randomBytes(32).toString("hex") });
  const store = storeFor({ testRoot: dir });
  return { root: dir, sessions: store.sessions!, claims: store.root, options: { testRoot: dir },
    env: { PHIMACS_TEST_ROOT: dir, PIMUX_DIR: path.join(dir, "mux") } };
}
