import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveHost, type HostIdentity } from "@phimacs/pimux/host-identity";
import type { ProcessIdentity } from "@phimacs/pimux/process-identity";
import type { StartSpec } from "./host-types.ts";

/** The global Pi on PATH, or an explicit absolute PHIMACS_PI override. */
export function managedHost(env: NodeJS.ProcessEnv = process.env): HostIdentity {
  return resolveHost(env);
}

export function managedPimuxExecutable(): string {
  return fileURLToPath(new URL("../bin/pimux", import.meta.resolve("@phimacs/pimux/main")));
}

/** Native hosts execute this argv verbatim; the wrapper claims before Pi opens. */
export function managedTerminalArgv(spec: Extract<StartSpec, { kind: "pi" }>, extensions: string[] = []): string[] {
  const host = managedHost({ ...process.env, ...spec.env });
  const bin = managedPimuxExecutable();
  if (!path.isAbsolute(spec.sessionFile)) throw new Error("Managed workers require an absolute session path");
  return [process.execPath, bin, "tui", "--", host.executable, "--session", spec.sessionFile, ...spec.args,
    ...extensions.flatMap((extension) => ["--extension", extension])];
}

export function processIdentity(value: unknown): ProcessIdentity | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  return Number.isSafeInteger(v.pid) && Number(v.pid) > 0 && typeof v.startTime === "string" && /^\d+$/.test(v.startTime)
    && typeof v.bootId === "string" && v.bootId.length > 0 ? v as unknown as ProcessIdentity : undefined;
}
