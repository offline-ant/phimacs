/**
 * Device sharing protocol v1, host side. Each connected device forwards
 * `<id>.mic.sock`, `<id>.speaker.sock` and `<id>.notify.sock` into one private
 * share directory; per kind, the newest socket that accepts a connection wins.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { CaptureSource } from './capture.ts';
import type { OutputSink } from './output.ts';

export const SHARE_KINDS = ['mic', 'speaker', 'notify'] as const;
export type ShareKind = (typeof SHARE_KINDS)[number];
/** Kinds the host writes to; their devices answer with one status line. */
export type OutputKind = Exclude<ShareKind, 'mic'>;
/** A refused socket younger than this may still be between bind and listen, so it is never pruned. */
export const STALE_SOCKET_MS = 60_000;
/** After its audio's duration, how long a speaker or notification device may take to close. */
export const DEVICE_CLOSE_GRACE_MS = 10_000;
const SPEAKER_BYTES_PER_MS = 44_100 * 2 / 1000;
const CONNECT_TIMEOUT_MS = 1_000;
const SOCKET_NAME = /^([A-Za-z0-9_-]+)\.(mic|speaker|notify)\.sock$/;
const LABELS: Record<ShareKind, string> = { mic: 'microphone', speaker: 'speaker', notify: 'notification' };
const PROGRAMS: Record<OutputKind, string> = { speaker: 'player', notify: 'notifier' };
/** Longer than any valid status line. */
const STATUS_LIMIT = 64;

/**
 * Lexically normalized without trailing slashes, so `dir/`, `dir/.` or `dir/./` cannot
 * make lstat follow a symbolic link, and checks and socket paths use the same string.
 */
export function normalizeShareDirectory(directory: string): string {
  return path.normalize(directory).replace(/\/+$/, '') || '/';
}

/** `PHIMACS_SHARE_DIR` (absolute; empty means unset), else `/tmp/phimacs-share-<uid>`; normalized. */
export function shareDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PHIMACS_SHARE_DIR;
  if (!configured) return `/tmp/phimacs-share-${process.getuid!()}`;
  if (!path.isAbsolute(configured)) throw new Error('PHIMACS_SHARE_DIR must be an absolute path.');
  return normalizeShareDirectory(configured);
}

/** True for a usable share directory, false when it does not exist; refuse any other directory. */
export function checkShareDirectory(directory: string): boolean {
  directory = normalizeShareDirectory(directory);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new Error(`Cannot inspect share directory ${directory}.`);
  }
  if (!stat.isDirectory() || stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o700) {
    throw new Error(`Refusing share directory ${directory}: it must be a directory owned by you with mode 0700.`);
  }
  return true;
}

/** Create missing parents and the share directory (exactly 0700), verify it and return its path. */
export function ensureShareDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const directory = shareDirectory(env);
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
    // Like `mkdir -m 700`: the umask cannot remove owner permissions.
    fs.chmodSync(directory, 0o700);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (!checkShareDirectory(directory)) throw new Error(`Share directory ${directory} disappeared.`);
  return directory;
}

interface Candidate { id: string; file: string; mtimeMs: number; ino: number }

function candidates(directory: string, kind: ShareKind): Candidate[] {
  // List and join exactly the path that was checked.
  directory = normalizeShareDirectory(directory);
  if (!checkShareDirectory(directory)) return [];
  return fs.readdirSync(directory).flatMap((name) => {
    const match = SOCKET_NAME.exec(name);
    if (match?.[2] !== kind) return [];
    const file = path.join(directory, name);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(file); } catch { return []; }
    return stat.isSocket() ? [{ id: match[1], file, mtimeMs: stat.mtimeMs, ino: stat.ino }] : [];
  }).sort((a, b) => b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id));
}

/** A connected socket, `refused` when nothing listens, or null when unreachable otherwise. */
function attempt(file: string, signal?: AbortSignal): Promise<net.Socket | 'refused' | null> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const socket = net.createConnection(file);
    const timeout = setTimeout(() => finish(null), CONNECT_TIMEOUT_MS);
    function abort() { finish(null, signal?.reason); }
    function connected() { finish(socket); }
    function failed(error: NodeJS.ErrnoException) { finish(error.code === 'ECONNREFUSED' ? 'refused' : null); }
    function finish(result: net.Socket | 'refused' | null, error?: unknown) {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      socket.off('connect', connected);
      socket.off('error', failed);
      if (result !== socket) socket.destroy();
      if (error !== undefined) reject(error);
      else resolve(result);
    }
    socket.once('connect', connected);
    socket.once('error', failed);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Remove a refused socket only when it is still the same file and older than `STALE_SOCKET_MS`. */
function prune(candidate: Candidate, now: number): void {
  if (now - candidate.mtimeMs <= STALE_SOCKET_MS) return;
  try {
    const stat = fs.lstatSync(candidate.file);
    if (stat.ino === candidate.ino && stat.mtimeMs === candidate.mtimeMs) fs.unlinkSync(candidate.file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export interface SharedDevice {
  /** The device name: the connection ID without its random suffix. */
  device: string;
  id: string;
  socket: net.Socket;
}

/** Connect to the newest answering KIND socket in DIRECTORY; null when none answers. */
export async function connectDevice(directory: string, kind: ShareKind,
  options: { signal?: AbortSignal; now?: () => number } = {}): Promise<SharedDevice | null> {
  options.signal?.throwIfAborted();
  for (const candidate of candidates(directory, kind)) {
    const result = await attempt(candidate.file, options.signal);
    if (result === 'refused') prune(candidate, (options.now ?? Date.now)());
    else if (result) return { device: candidate.id.replace(/-[^-]*$/, '') || candidate.id, id: candidate.id, socket: result };
  }
  return null;
}

function noDevice(kind: ShareKind, directory: string): Error {
  return new Error(`No shared ${LABELS[kind]} device answers in ${directory}.`);
}

/** Microphone of the newest answering device: it streams 16 kHz mono s16le until the host closes. */
export function sharedCapture(directory?: string): CaptureSource {
  return {
    async open(signal) {
      const resolved = directory ?? shareDirectory();
      const mic = await connectDevice(resolved, 'mic', { signal });
      if (!mic) throw noDevice('mic', resolved);
      const close = () => mic.socket.destroy();
      signal.addEventListener('abort', close, { once: true });
      if (signal.aborted) { close(); signal.throwIfAborted(); }
      return { device: mic.device, stream: mic.socket,
        close() { signal.removeEventListener('abort', close); close(); } };
    },
  };
}

/**
 * Write DATA, close the write side, then wait for the device's status line and close:
 * `ok` after its player or notifier exited 0, else `error <exit code>`. A device that
 * closes without reading DATA (such as an accepted forward whose device listener is
 * gone) resets the connection; that and a close without a status line are errors.
 */
function settle(socket: net.Socket, data: Buffer, limitMs: number, program: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    // Nothing was written yet, so nothing can still play: never leave the connection open.
    if (signal?.aborted) { socket.destroy(); reject(signal.reason); return; }
    let status = '';
    const timer = setTimeout(() => done(new Error(`it did not close within ${limitMs} ms`)), limitMs);
    function abort() {
      // Data already written still plays: keep the connection draining until the device closes,
      // but never keep the process alive for it.
      socket.unref();
      done(signal!.reason, false);
      socket.resume();
    }
    function received(chunk: Buffer) {
      status += chunk.toString('latin1');
      if (status.length > STATUS_LIMIT) done(new Error('it sent an invalid status line'));
    }
    function failed(error: Error) { done(error); }
    function closed(hadError: boolean) {
      if (hadError) return;
      if (status === 'ok\n') return done();
      const exit = /^error (\d+)\n$/.exec(status);
      done(new Error(exit ? `${program} exited ${exit[1]}`
        : status ? 'it sent an invalid status line' : 'it closed without a status line, so delivery is uncertain'));
    }
    function done(error?: unknown, destroy = true) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      socket.off('data', received);
      socket.off('error', failed);
      socket.off('close', closed);
      if (destroy) socket.destroy();
      if (error === undefined) resolve(); else reject(error);
    }
    // `failed` reports errors until settled; later errors of a settled connection have no caller.
    socket.on('error', () => {});
    socket.on('error', failed);
    socket.on('data', received);
    socket.on('close', closed);
    signal?.addEventListener('abort', abort, { once: true });
    socket.end(data, (error?: Error | null) => { if (error) done(error); });
  });
}

/**
 * Deliver DATA to a connected speaker or notification DEVICE and wait for its `ok`.
 * A signal aborted before writing closes the connection; after writing, it stops
 * waiting while the device still plays or shows what it received.
 */
export async function deliverToDevice(device: SharedDevice, kind: OutputKind, data: Buffer,
  options: { signal?: AbortSignal; closeGraceMs?: number } = {}): Promise<void> {
  const playMs = kind === 'speaker' ? data.length / SPEAKER_BYTES_PER_MS : 0;
  const limitMs = Math.ceil(playMs) + (options.closeGraceMs ?? DEVICE_CLOSE_GRACE_MS);
  try {
    await settle(device.socket, data, limitMs, PROGRAMS[kind], options.signal);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new Error(`Shared ${LABELS[kind]} device ${device.device} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function deliver(directory: string | undefined, kind: OutputKind, data: Buffer,
  closeGraceMs: number, signal?: AbortSignal): Promise<string> {
  const resolved = directory ?? shareDirectory();
  const connected = await connectDevice(resolved, kind, { signal });
  if (!connected) throw noDevice(kind, resolved);
  await deliverToDevice(connected, kind, data, { closeGraceMs, ...(signal ? { signal } : {}) });
  return connected.device;
}

/**
 * Speaker (44.1 kHz mono s16le) and notifications (title line, body, EOF) of the
 * newest answering devices. Each resolves once the device has reported `ok` and
 * closed. No answering device, a reset connection, a failure or missing status line
 * and a device that does not close within the audio's duration plus `closeGraceMs`
 * are errors, never a silent fallback. An empty play is a probe that sends one
 * silent sample, so a device that cannot play is detected before speech is synthesized.
 */
export function sharedOutput(directory?: string, options: { closeGraceMs?: number } = {}): OutputSink {
  const grace = options.closeGraceMs ?? DEVICE_CLOSE_GRACE_MS;
  return {
    play: (pcm, signal) => deliver(directory, 'speaker', pcm.length ? pcm : Buffer.alloc(2), grace, signal),
    notify: (title, body) => deliver(directory, 'notify',
      Buffer.from(`${title.replace(/[\r\n]+/g, ' ').trim()}\n${body}`, 'utf8'), grace),
  };
}
