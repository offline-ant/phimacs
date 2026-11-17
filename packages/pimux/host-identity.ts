/** Resolve and verify Pi executables without loading the Pi SDK. */
import * as fs from "node:fs";
import * as path from "node:path";

export interface HostIdentity { executable: string; version: string }

/** Resolve the host Pi: an absolute PHIMACS_PI override, otherwise the global `pi` on PATH. */
export function resolveHost(env: NodeJS.ProcessEnv = process.env): HostIdentity {
  if (env.PHIMACS_PI) return verifyHost(env.PHIMACS_PI);
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(dir, "pi");
    if (path.isAbsolute(dir) && fs.existsSync(candidate)) return verifyHost(candidate);
  }
  throw new Error("No global pi on PATH; install @earendil-works/pi-coding-agent globally or set PHIMACS_PI");
}

/** Validate the selected physical Pi entry point, not a PATH wrapper. */
export function verifyHost(command: string): HostIdentity {
  if (!path.isAbsolute(command)) throw new Error("Managed Pi must be an absolute runtime executable, not a PATH command");
  const executable = fs.realpathSync.native(command);
  if (!fs.statSync(executable).isFile()) throw new Error("Pi executable must be a regular file");
  fs.accessSync(executable, fs.constants.R_OK | fs.constants.X_OK);
  let dir = path.dirname(executable);
  let version: string | undefined;
  for (;;) {
    const manifest = path.join(dir, "package.json");
    if (fs.existsSync(manifest)) {
      const pkg = JSON.parse(fs.readFileSync(manifest, "utf8")) as { name?: string; version?: string };
      if (pkg.name === "@earendil-works/pi-coding-agent") { version = pkg.version; break; }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!version) throw new Error("Pi executable is not part of an @earendil-works/pi-coding-agent package");
  const bytes = fs.readFileSync(executable);
  if (bytes.subarray(0, bytes.indexOf(10)).toString("utf8") !== "#!/usr/bin/env node") throw new Error("Managed Pi must be the supported Node entry point");
  return { executable, version };
}

