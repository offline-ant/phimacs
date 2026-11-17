/** Same-user private directories and atomically published private JSON files. */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

/** Creates the directory (and missing parents) 0700, then verifies it as {@link verifyPrivateDirectory}. */
export function ensurePrivateDirectory(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  verifyPrivateDirectory(dir);
}

/** Requires a canonical, non-symlink directory owned by this user with no group/other access; ENOENT propagates. */
export function verifyPrivateDirectory(dir: string): void {
  const stat = fs.lstatSync(dir);
  const uid = process.getuid?.();
  if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0
    || fs.realpathSync.native(dir) !== path.resolve(dir)) {
    throw new Error(`${dir} must be a canonical directory owned by this user with mode 0700`);
  }
}

/** Replaces `file` with complete 0600 JSON; readers never see partial bytes. */
export function writePrivateJson(file: string, value: unknown): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

/** Publishes complete 0600 JSON only if `file` does not exist yet; EEXIST propagates. */
export function createPrivateJson(file: string, value: unknown): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
    fs.linkSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

/** Reads JSON from a same-user 0600 regular file without following symlinks; undefined when missing. */
export function readPrivateJson<T>(file: string): T | undefined {
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error("Private runtime file has unsafe ownership/permissions");
      return JSON.parse(fs.readFileSync(fd, "utf8")) as T;
    } finally { fs.closeSync(fd); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
