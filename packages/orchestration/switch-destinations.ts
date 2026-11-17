import * as os from "node:os";
import * as path from "node:path";
import { emacsDaemon, prepareEmacsSwitch } from "./switch-emacs.ts";
import { readDiscovery } from "@phimacs/pimux/discovery";
import { canonicalSessionPath, lookupClaim } from "@phimacs/pimux/ownership";
import { readProcessIdentity, sameProcessIdentity } from "@phimacs/pimux/process-identity";
import { MANAGED_CLAIM_ENV } from "@phimacs/pimux/guard";
import { PROTOCOL_VERSION } from "@phimacs/pimux/protocol";
import { TRANSFER_OWNERSHIP_BLOCKER } from "./session-transfer.ts";

export type SwitchDestination = "herdr" | "emacs";
export interface SwitchSource {
  sessionFile: string;
  cwd: string;
  args: string[];
  env: Record<string, string>;
  /** Required for a frontend attachment; never permission to start another writer. */
  runtime?: { protocol: 2; muxId: string };
}
export interface PreparedSwitch { start(): Promise<string> }

/** Explicit empty values override identities inherited from the destination host. */
export function switchEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return {
    PI_CODING_AGENT_DIR: path.resolve(env.PI_CODING_AGENT_DIR || path.join(env.HOME || os.homedir(), ".pi", "agent")),
    PI_NESTED: "", PI_ORCHESTRATION_TARGET: "", PI_ORCHESTRATION_CONTROL: "",
    PI_ORCHESTRATION_PLACEMENT: "", PI_ORCHESTRATION_PARENT: "", PHIMACS_PARENT_TASK: "", PHIMACS_PARENT_TASK_FILE: "",
    PHIMACS_MANAGED_CLAIM: "", PIMUX_DISCOVERY: "",
    HERDR_ENV: "", HERDR_SOCKET_PATH: env.HERDR_SOCKET_PATH || "",
    HERDR_WORKSPACE_ID: "", HERDR_TAB_ID: "", HERDR_PANE_ID: "", TMUX: "", TMUX_PANE: "",
    ...(env.PI_CODING_AGENT_SESSION_DIR ? { PI_CODING_AGENT_SESSION_DIR: path.resolve(env.PI_CODING_AGENT_SESSION_DIR) } : {}),
  };
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid destination response");
  return value as Record<string, unknown>;
}

export function assertSharedSwitch(source: SwitchSource): asserts source is SwitchSource & { runtime: { protocol: 2; muxId: string } } {
  if (source.runtime?.protocol !== PROTOCOL_VERSION || !source.runtime.muxId) throw new Error(TRANSFER_OWNERSHIP_BLOCKER);
}

export async function prepareSwitch(kind: SwitchDestination, source: SwitchSource): Promise<PreparedSwitch> {
  assertSharedSwitch(source);
  if (kind === "herdr") throw new Error(TRANSFER_OWNERSHIP_BLOCKER);
  return prepareEmacsSwitch(source, await emacsDaemon(process.env));
}

/** Discovery is only a locator: the claim must identify this exact live Pi. */
export function sharedMuxId(env: NodeJS.ProcessEnv, sessionFile?: string): string | undefined {
  const serialized = env[MANAGED_CLAIM_ENV];
  if (!serialized || !env.PIMUX_DISCOVERY) return undefined;
  const capability = object(JSON.parse(serialized));
  if (typeof capability.file !== "string" || typeof capability.token !== "string") throw new Error("Invalid managed source capability; no destination was opened.");
  const options = env.PHIMACS_TEST_ROOT ? { testRoot: env.PHIMACS_TEST_ROOT } : {};
  const initial = lookupClaim(capability.file, options);
  const current = lookupClaim(sessionFile ?? capability.file, options);
  const self = readProcessIdentity(process.pid);
  const discovery = readDiscovery(env.PIMUX_DISCOVERY);
  if (!initial || initial.token !== capability.token || !current || !self || !current.owner.pi
    || current.owner.id !== initial.owner.id || current.owner.kind !== "rpc" || current.owner.protocol !== PROTOCOL_VERSION
    || !sameProcessIdentity(current.owner.pi, self) || !discovery || discovery.protocol !== PROTOCOL_VERSION
    || discovery.phase !== "committed" || discovery.muxId !== current.owner.id || discovery.piPid !== self.pid
    || !discovery.ownerIdentity || !sameProcessIdentity(discovery.ownerIdentity, current.owner.wrapper)
    || discovery.socket !== current.owner.socket || !discovery.session?.file
    || canonicalSessionPath(discovery.session.file) !== current.file) {
    throw new Error("Shared runtime ownership is unconfirmed; the source and its claims were left unchanged.");
  }
  return current.owner.id;
}
