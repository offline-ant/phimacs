/**
 * Discovery files: one `<id>.json` and `<id>.sock` per live wrapper in a
 * private per-user directory. JSON files are replaced atomically. An entry is
 * reclaimed only when neither its wrapper nor its Pi is alive, and for a socket
 * only after a refused connection while its identity did not change.
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { redactEndpoint } from "./endpoint.ts";
import { isRecord, type Placement } from "./protocol.ts";
import { processExists, type ProcessIdentity } from "./process-identity.ts";
import { verifyPrivateDirectory, writePrivateJson } from "./private-files.ts";
import type { HostIdentity } from "./host-identity.ts";
import type { Blocked, MuxStatus } from "./state.ts";

export interface OrchestrationRef { host: string; endpoint: string; id: string; name?: string }

export interface DiscoveryRecord {
  protocol: number;
  muxId: string;
  socket: string;
  pid: number;
  /** Null until Pi is spawned. */
  piPid: number | null;
  ownerIdentity?: ProcessIdentity;
  /** Foreground service whose loss ends this agent. */
  service?: ProcessIdentity;
  piIdentity?: ProcessIdentity | null;
  operationId?: string;
  phase?: "provisional" | "committed";
  host?: HostIdentity;
  cwd: string;
  startedAt: string;
  updatedAt: string;
  status: MuxStatus;
  blocked: Blocked | null;
  /** While starting, only the file `--session` names is known. */
  session: { file: string | null; id: string | null; name: string | null } | null;
  model: { provider: string; id: string } | null;
  thinkingLevel: string | null;
  placement: Placement;
  orchestration: OrchestrationRef | null;
  parent: OrchestrationRef | null;
}

/** `PIMUX_DIR`, else `/tmp/pi-mux-<uid>`: fixed so frontends with different TMPDIRs agree. */
export function muxDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env.PIMUX_DIR || `/tmp/pi-mux-${process.getuid?.() ?? "user"}`;
}

export function writeDiscovery(file: string, record: DiscoveryRecord): void {
  writePrivateJson(file, record);
}

export function readDiscovery(file: string): DiscoveryRecord | undefined {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) return undefined;
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    // Unsupported live owners remain visible: absence must not trigger a new writer.
    return isRecord(parsed) && Number.isSafeInteger(parsed.protocol) && typeof parsed.muxId === "string"
      && typeof parsed.socket === "string" && Number.isSafeInteger(parsed.pid)
      ? parsed as unknown as DiscoveryRecord : undefined;
  } catch {
    return undefined;
  }
}

export function listDiscovery(dir: string): DiscoveryRecord[] {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((name) => name.endsWith(".json") && !name.startsWith("."))
    .map((name) => readDiscovery(path.join(dir, name))).filter((record): record is DiscoveryRecord => record !== undefined);
}

function identity(file: string): string | undefined {
  try {
    const stat = fs.lstatSync(file);
    return `${stat.dev}:${stat.ino}:${stat.ctimeMs}`;
  } catch {
    return undefined;
  }
}

function refused(socket: string): Promise<boolean> {
  return new Promise((resolve) => {
    const connection = net.connect(socket);
    connection.once("connect", () => { connection.destroy(); resolve(false); });
    connection.once("error", (error: NodeJS.ErrnoException) => resolve(error.code === "ECONNREFUSED"));
  });
}

/** Whether the record's wrapper or its Pi may still be running; unknown liveness counts as alive. */
export function discoveryOwnerAlive(record: DiscoveryRecord): boolean {
  return processExists(record.ownerIdentity ?? record.pid)
    || (record.piIdentity ? processExists(record.piIdentity) : record.piPid !== null && processExists(record.piPid));
}

/** Records whose owner may still run, in creation order. A missing directory has none; an unsafe one throws. */
export function liveDiscovery(dir: string): DiscoveryRecord[] {
  if (!fs.existsSync(dir)) return [];
  verifyPrivateDirectory(dir);
  return listDiscovery(dir).filter(discoveryOwnerAlive)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.muxId.localeCompare(b.muxId));
}

export interface DiscoveryWatchOptions {
  /** Delay after a directory event, so a burst of renames becomes one reread. */
  debounceMs?: number;
  /** Periodic reread: notices dead owners, a created directory and missed events. */
  backstopMs?: number;
  /** A later reread failed (the directory became unsafe); the watch has stopped. */
  onError(error: Error): void;
}

/**
 * Calls `onSnapshot` with the complete live discovery now and again whenever it
 * changes, ignoring `updatedAt`. Timers and the watcher do not keep the process
 * alive. The first read's failure throws.
 */
export function watchDiscovery(dir: string, onSnapshot: (records: DiscoveryRecord[]) => void,
  options: DiscoveryWatchOptions): { close(): void } {
  let watcher: fs.FSWatcher | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let signature: string | undefined;
  let closed = false;
  const read = (): void => {
    const records = liveDiscovery(dir);
    const next = JSON.stringify(records.map(({ updatedAt: _updatedAt, ...record }) => record));
    if (next === signature) return;
    signature = next;
    onSnapshot(records);
  };
  const close = (): void => {
    closed = true;
    clearInterval(backstop);
    if (debounce) clearTimeout(debounce);
    watcher?.close();
    watcher = debounce = null;
  };
  const reread = (): void => {
    if (closed) return;
    try { read(); } catch (error) { close(); options.onError(error instanceof Error ? error : new Error(String(error))); }
  };
  const ensureWatcher = (): void => {
    if (watcher || closed) return;
    try {
      watcher = fs.watch(dir, () => {
        if (debounce) return;
        debounce = setTimeout(() => { debounce = null; reread(); }, options.debounceMs ?? 100);
        debounce.unref();
      });
      watcher.unref();
      watcher.on("error", () => { watcher?.close(); watcher = null; });
    } catch { /* Not created yet: the backstop retries. */ }
  };
  read();
  const backstop = setInterval(() => { ensureWatcher(); reread(); }, options.backstopMs ?? 5000);
  backstop.unref();
  ensureWatcher();
  return { close };
}

/** Unknown metadata is not evidence that a writer died. */
function ownerAlive(metadata: string): boolean {
  const record = readDiscovery(metadata);
  return !record || discoveryOwnerAlive(record);
}

/** Removes entries of wrappers that died without cleaning up; returns the removed ids. */
export async function reclaimStale(dir: string): Promise<string[]> {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const removed: string[] = [];
  for (const name of names) {
    if (name.endsWith(".sock")) {
      const socket = path.join(dir, name);
      const before = identity(socket);
      if (!before || !await refused(socket) || identity(socket) !== before) continue;
      const id = name.slice(0, -5);
      const metadata = path.join(dir, `${id}.json`);
      const beforeMetadata = identity(metadata);
      if (ownerAlive(metadata) || identity(socket) !== before || identity(metadata) !== beforeMetadata) continue;
      fs.rmSync(socket, { force: true });
      fs.rmSync(path.join(dir, `${id}.json`), { force: true });
      removed.push(id);
    } else if (name.endsWith(".json") && !name.startsWith(".")) {
      // A wrapper killed before listening leaves only its JSON file.
      const id = name.slice(0, -5);
      if (fs.existsSync(path.join(dir, `${id}.sock`))) continue;
      const metadata = path.join(dir, name);
      const beforeMetadata = identity(metadata);
      if (ownerAlive(metadata) || identity(metadata) !== beforeMetadata) continue;
      fs.rmSync(metadata, { force: true });
      removed.push(id);
    }
  }
  return removed;
}

/** This process's orchestration identity, and the parent identity a host gave a child it started. */
export function orchestrationIdentity(env: NodeJS.ProcessEnv): { orchestration: OrchestrationRef | null; parent: OrchestrationRef | null } {
  const { PI_ORCHESTRATION_HOST: host, PI_ORCHESTRATION_ENDPOINT: endpoint, PI_ORCHESTRATION_TARGET: target } = env;
  let parent: OrchestrationRef | null = null;
  try {
    const parsed: unknown = env.PI_ORCHESTRATION_PARENT ? JSON.parse(env.PI_ORCHESTRATION_PARENT) : undefined;
    if (isRecord(parsed) && typeof parsed.host === "string" && typeof parsed.endpoint === "string" && typeof parsed.id === "string") {
      parent = { host: parsed.host, endpoint: redactEndpoint(parsed.endpoint), id: parsed.id,
        ...typeof parsed.name === "string" ? { name: parsed.name } : {} };
    }
  } catch { /* malformed: no parent */ }
  return {
    orchestration: host && endpoint && target ? { host, endpoint: redactEndpoint(endpoint), id: target } : null,
    parent,
  };
}
