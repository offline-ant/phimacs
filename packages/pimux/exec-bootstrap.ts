/**
 * Unauthorized children run only this built-in/dependency-free gate. No host
 * imports, inherited preloads or session opens precede durable authorization.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { HostAuthorization } from "./bootstrap.ts";
import { lookupClaim } from "./ownership.ts";
import { processIdentityStatus, readProcessIdentity, sameProcessIdentity } from "./process-identity.ts";

function authorization(): HostAuthorization {
  const chunks: Buffer[] = [];
  const chunk = Buffer.alloc(64 * 1024);
  let size = 0;
  for (;;) {
    const count = fs.readSync(3, chunk, 0, chunk.length, null);
    if (count === 0) throw new Error("Host bootstrap closed without authorization");
    const received = Buffer.from(chunk.subarray(0, count));
    chunks.push(received); size += count;
    if (size > 4 * 1024 * 1024) throw new Error("Host bootstrap authorization exceeds its bound");
    const newline = received.indexOf(10);
    if (newline < 0) continue;
    if (newline !== received.length - 1) throw new Error("Invalid host bootstrap framing");
    const value = JSON.parse(Buffer.concat(chunks).subarray(0, -1).toString("utf8")) as HostAuthorization;
    if (value.schema !== 1 || !value.host || !path.isAbsolute(value.host.executable)
      || !Array.isArray(value.args)
      || !value.args.every((arg) => typeof arg === "string") || !value.claim
      || typeof value.env !== "object" || value.env === null
      || !Object.values(value.env).every((entry) => typeof entry === "string")) throw new Error("Invalid host bootstrap authorization");
    return value;
  }
}

try {
  if (process.platform !== "linux" || !process.execve) throw new Error("Managed host execution requires Linux Node execve");
  const input = authorization();
  fs.closeSync(3);
  const self = readProcessIdentity(process.pid);
  const current = lookupClaim(input.claim.file, input.claim.testRoot ? { testRoot: input.claim.testRoot } : {});
  if (!self || !current || current.token !== input.claim.token || current.owner.id !== input.claim.owner.id
    || !current.owner.pi || !sameProcessIdentity(current.owner.pi, self)
    || !sameProcessIdentity(current.owner.wrapper, input.claim.owner.wrapper)
    || current.owner.wrapper.pid !== process.ppid
    || processIdentityStatus(current.owner.wrapper) !== "alive"
    || input.env.PHIMACS_TEST_ROOT !== input.claim.testRoot) throw new Error("Host bootstrap has no live durably registered owner");
  const executable = fs.realpathSync.native(input.host.executable);
  const bytes = fs.readFileSync(executable);
  if (executable !== input.host.executable || bytes.subarray(0, bytes.indexOf(10)).toString("utf8") !== "#!/usr/bin/env node") throw new Error("Host changed before authorized execution");
  // A Node shebang is interpreted explicitly with this absolute runtime, not
  // /usr/bin/env's PATH. execve preserves PID/start/boot identity and stdio, while
  // closing the private gate. No supervisor/shim remains in the writer's place.
  process.execve(process.execPath, [process.execPath, executable, ...input.args], input.env);
} catch (error) {
  process.stderr.write(`Managed host bootstrap failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
