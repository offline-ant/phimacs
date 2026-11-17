/** Durable service state, separate from ephemeral per-agent sockets. */
import * as fs from "node:fs";
import * as os from "node:os";
import { writePrivateJson } from "./private-files.ts";
import * as path from "node:path";

export function serviceStateDirectory(env = process.env): string {
  if (env.PHIMACS_TEST_ROOT) return path.join(env.PHIMACS_TEST_ROOT, "pimux-state");
  return path.join(env.PHIMACS_STATE_DIR || path.join(env.XDG_STATE_HOME || path.join(env.HOME || os.homedir(), ".local", "state"), "phimacs"), "pimux");
}

/** Root intent and Close must survive power loss, not merely process crashes. */
export function writeServiceJson(file: string, value: unknown): void {
  writePrivateJson(file, value);
  for (const target of [file, path.dirname(file)]) {
    const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
}

/** The durable identity of one service state directory, created by its first service. */
export function stateIdentityFile(directory: string): string { return path.join(directory, "identity.json"); }

export function rootCloseIntent(muxId: string, directory: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(muxId)) throw new Error("Invalid runtime identity");
  return path.join(directory, "closed", `${muxId}.json`);
}
