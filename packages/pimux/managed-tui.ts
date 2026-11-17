/** Managed native TUI lifetime is terminal-owned, not a shared RPC frontend. */
import { spawnGatedHost, type GatedHost } from "./bootstrap.ts";
import { parseArgs } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireClaim, canonicalSessionPath, claimsForOwner, releaseClaim, type ClaimHandle } from "./ownership.ts";
import { readProcessIdentity } from "./process-identity.ts";
import { exactSessionArgs, servesRpc, withExactOption } from "./host.ts";
import { verifyHost } from "./host-identity.ts";
import { MANAGED_CLAIM_ENV } from "./guard.ts";

export interface ManagedTuiOptions { command: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }
export async function runManagedTui(options: ManagedTuiOptions): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const host = verifyHost(options.command);
  if (servesRpc(options.args)) throw new Error("RPC agents use pimux start and socket clients, not managed TUI passthrough");
  const exportFile = parseArgs(options.args).export;
  const canonicalExport = exportFile ? canonicalSessionPath(path.resolve(cwd, exportFile)) : undefined;
  // Pi's exporter opens before extension loading. Pass the same single canonical
  // path we claim; an original alias could retarget between claim and child open.
  const selected = canonicalExport ? { args: withExactOption(options.args, "export", canonicalExport), file: canonicalExport }
    : exactSessionArgs(options.args, cwd, env, true);
  const wrapper = readProcessIdentity(process.pid);
  if (!wrapper) throw new Error("Cannot establish managed TUI owner identity");
  const claim = acquireClaim(selected.file, { id: randomUUID(), kind: "tui", wrapper, pi: null }, env.PHIMACS_TEST_ROOT ? { testRoot: env.PHIMACS_TEST_ROOT } : {});
  const guard = fileURLToPath(import.meta.resolve("@phimacs/pimux/guard"));
  let gated: GatedHost;
  try {
    gated = spawnGatedHost({ host, args: [...selected.args, "--extension", guard], cwd,
      env: { ...env, [MANAGED_CLAIM_ENV]: JSON.stringify(claim) }, claim, stdio: "inherit" });
  } catch (error) { releaseClaim(claim); throw error; }
  const child = gated.child;
  const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
  const handlers = signals.map((signal) => { const handler = (): void => { child.kill(signal); }; process.on(signal, handler); return handler; });
  return new Promise((resolve, reject) => {
    let handoffError: unknown;
    void gated.authorize().catch((error: unknown) => { handoffError = error; child.kill("SIGTERM"); });
    const cleanup = (): void => {
      signals.forEach((signal, i) => process.off(signal, handlers[i]!));
      try {
        for (const current of claimsForOwner(claim.owner, claim.testRoot ? { testRoot: claim.testRoot } : {})) {
          const owned: ClaimHandle = { file: current.file, token: current.token, owner: current.owner,
            ...claim.testRoot ? { testRoot: claim.testRoot } : {} };
          releaseClaim(owned);
        }
      } catch { /* uncertainty remains claimed */ }
    };
    child.on("error", (error) => {
      // Signalling/IPC errors can happen after successful spawn. They do not
      // establish child exit and must not release a live writer's claim.
      if (child.pid === undefined) { cleanup(); reject(error); }
      else handoffError = error;
    });
    child.once("close", (code, signal) => { cleanup(); if (handoffError) reject(handoffError); else resolve({ code, signal }); });
  });
}
