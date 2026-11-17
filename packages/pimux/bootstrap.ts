/** Spawn a nonwriting gate; only a durably registered child may exec the host. */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { HostIdentity } from "./host-identity.ts";
import { updateClaim, type ClaimHandle } from "./ownership.ts";
import { readProcessIdentity, type ProcessIdentity } from "./process-identity.ts";

export interface HostAuthorization {
  schema: 1;
  host: HostIdentity;
  args: string[];
  env: NodeJS.ProcessEnv;
  claim: ClaimHandle;
}

export interface GatedHost {
  child: ChildProcess;
  /** Persist this exact PID/start/boot identity, then authorize a same-PID exec. */
  authorize(): Promise<ProcessIdentity>;
}

export function spawnGatedHost(options: {
  host: HostIdentity;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  claim: ClaimHandle;
  stdio: "pipe" | "inherit";
}): GatedHost {
  const entry = fileURLToPath(new URL("./exec-bootstrap.js", import.meta.resolve("@phimacs/pimux/runtime")));
  const streams: SpawnOptions["stdio"] = options.stdio === "inherit" ? ["inherit", "inherit", "inherit", "pipe"] : ["pipe", "pipe", "pipe", "pipe"];
  // In particular, never inherit NODE_OPTIONS/preloads into the unauthorized
  // child. Its actual host environment travels only over the private gate.
  const child = spawn(process.execPath, [entry], { cwd: options.cwd, env: {}, stdio: streams });
  const gate = child.stdio[3] as Writable;
  let gateError: Error | undefined;
  gate.on("error", (error: Error) => { gateError = error; });
  const spawned = new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  // Callers install exit/cleanup handlers before awaiting authorization.
  // Observe early failure even if the caller is itself cancelled first.
  void spawned.catch(() => {});
  let authorized = false;
  return {
    child,
    async authorize(): Promise<ProcessIdentity> {
      if (authorized) throw new Error("Host bootstrap authorization is single-use");
      authorized = true;
      await spawned;
      try {
        if (gateError) throw gateError;
        const pi = readProcessIdentity(child.pid!);
        if (!pi) throw new Error("Host bootstrap exited before its process identity could be established");
        updateClaim(options.claim, { ...options.claim.owner, pi });
        const message: HostAuthorization = { schema: 1, host: options.host, args: options.args, env: options.env, claim: options.claim };
        // EOF without this complete record cannot execute Pi. A crash after it
        // leaves the live child identity in the claim, including across execve.
        gate.end(`${JSON.stringify(message)}\n`);
        return pi;
      } catch (error) {
        gate.destroy();
        throw error;
      }
    },
  };
}
