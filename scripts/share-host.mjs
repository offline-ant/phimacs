// Host side of device sharing, protocol 1: the private share directory that devices
// forward their mic/speaker/notify sockets into over SSH. Devices invoke
// `phimacs --local share-host prepare|release ID`; the sound package selects sockets.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export const SHARE_KINDS = ['mic', 'speaker', 'notify'];
const SOCKET = /^([A-Za-z0-9_-]+)\.(mic|speaker|notify)\.sock$/;
const ID = /^[A-Za-z0-9_-]+$/;
/** A refusing socket younger than this may still be binding; it is never pruned. */
export const STALE_MS = 60_000;

/**
 * PHIMACS_SHARE_DIR when non-empty (it must be absolute), else /tmp/phimacs-share-UID,
 * lexically normalized without trailing slashes: `dir/`, `dir/.` or `dir/./` would make
 * a check follow a symlink, and checks and socket paths must use the same string.
 * The sound package resolves the same directory by the same rule.
 */
export function shareDirectory(env = process.env) {
  const configured = env.PHIMACS_SHARE_DIR;
  if (!configured) return `/tmp/phimacs-share-${process.getuid()}`;
  if (!path.isAbsolute(configured)) throw new Error('PHIMACS_SHARE_DIR must be absolute');
  return path.normalize(configured).replace(/\/+$/, '') || '/';
}

/** Only your own real directory with permission bits exactly 0700 (setgid and the like allowed). */
function verify(directory) {
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700) {
    throw new Error(`Share directory ${directory} must be your own non-symlink directory with mode 0700`);
  }
}

/** Device connections by ID, newest socket first; an absent directory has none. */
export function listShares(env = process.env) {
  const directory = shareDirectory(env);
  let names;
  try { verify(directory); names = fs.readdirSync(directory); }
  catch (error) { if (error.code === 'ENOENT') return { directory, connections: [] }; throw error; }
  const connections = new Map();
  for (const name of names) {
    const match = SOCKET.exec(name);
    const info = match && fs.lstatSync(path.join(directory, name), { throwIfNoEntry: false });
    if (!info?.isSocket()) continue;
    const connection = connections.get(match[1]) ?? { id: match[1], kinds: [], modified: 0 };
    connection.kinds.push(match[2]);
    connection.modified = Math.max(connection.modified, info.mtimeMs);
    connections.set(match[1], connection);
  }
  return { directory, connections: [...connections.values()].sort((a, b) => b.modified - a.modified) };
}

function refuses(file) {
  return new Promise(resolve => {
    const socket = net.connect(file);
    const finish = refused => { clearTimeout(timer); socket.destroy(); resolve(refused); };
    const timer = setTimeout(() => finish(false), 1000);
    socket.once('connect', () => finish(false));
    socket.once('error', error => finish(error.code === 'ECONNREFUSED'));
  });
}

/**
 * Create the directory (missing parents too; it exactly 0700) or verify it, and prune only
 * sockets proven stale: refusing, older than STALE_MS and still the same file after
 * the probe, so a device that replaced it meanwhile keeps its new socket.
 */
export async function prepareShare(env = process.env, now = Date.now()) {
  const directory = shareDirectory(env);
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.chmodSync(directory, 0o700); // like mkdir -m 700: the umask cannot remove owner permissions
  } catch (error) {
    if (error.code !== 'EEXIST') throw error; // anything already there, even a dangling symlink, is verified
  }
  verify(directory);
  for (const name of fs.readdirSync(directory)) {
    const file = path.join(directory, name);
    const info = SOCKET.test(name) && fs.lstatSync(file, { throwIfNoEntry: false });
    if (!info?.isSocket() || info.uid !== process.getuid() || now - info.mtimeMs <= STALE_MS || !await refuses(file)) continue;
    const probed = fs.lstatSync(file, { throwIfNoEntry: false });
    if (probed?.ino === info.ino && probed.mtimeMs === info.mtimeMs) fs.rmSync(file, { force: true });
  }
  return directory;
}

/** Remove one device connection's own sockets; never another ID's. */
export function releaseShare(id, env = process.env) {
  if (!ID.test(id)) throw new Error('Invalid share connection ID');
  const directory = shareDirectory(env);
  verify(directory);
  for (const kind of SHARE_KINDS) {
    const file = path.join(directory, `${id}.${kind}.sock`);
    const info = fs.lstatSync(file, { throwIfNoEntry: false });
    if (info?.isSocket() && info.uid === process.getuid()) fs.rmSync(file, { force: true });
  }
}

export async function shareHost(argv, env = process.env) {
  if (argv.length === 1 && argv[0] === 'prepare') console.log(await prepareShare(env));
  else if (argv.length === 2 && argv[0] === 'release') releaseShare(argv[1], env);
  else throw new Error('Usage: phimacs share-host prepare | release ID (used by devices over SSH)');
  return 0;
}
