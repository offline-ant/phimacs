import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HOST_KINDS, isHostKind, type Host, type HostKind, type HostSelection, type HostTarget } from "./host-types.ts";
import { createEmacsHost } from "./hosts/emacs.ts";
import { createHerdrHost } from "./hosts/herdr.ts";
import { createTmuxHost } from "./hosts/tmux.ts";
import { childNestingEnvironment } from "./nesting.ts";
import { REMOTE_ENV } from "./remote-session.ts";

interface Environment {
  available: HostSelection[];
  configured: HostSelection | Error;
}
interface HostState {
  environment?: Environment;
  override: HostKind | null;
  startup: Promise<void>;
}
const STATE = Symbol.for("pi-ant.orchestration.host");
function state(): HostState {
  const globals = globalThis as typeof globalThis & { [STATE]?: HostState };
  return globals[STATE] ??= { override: null, startup: Promise.resolve() };
}

function explicitKind(env: NodeJS.ProcessEnv): string | undefined {
  return env.PI_ORCHESTRATION_HOST?.trim() || undefined;
}

/** Every host this process can reach, each with the endpoint its operations need. */
export function availableHosts(env: NodeJS.ProcessEnv): HostSelection[] {
  const endpoints = new Map<HostKind, string>();
  if (env.HERDR_ENV === "1" && env.HERDR_SOCKET_PATH) endpoints.set("herdr", env.HERDR_SOCKET_PATH);
  const tmux = env.TMUX?.split(",")[0];
  if (tmux) endpoints.set("tmux", tmux);
  // Emacs has no ambient marker: Pilish's companion selects it explicitly.
  // PI_ORCHESTRATION_ENDPOINT belongs to that explicitly selected host alone,
  // so a different host still uses its own native endpoint.
  const explicit = explicitKind(env);
  if (isHostKind(explicit) && env.PI_ORCHESTRATION_ENDPOINT) endpoints.set(explicit, env.PI_ORCHESTRATION_ENDPOINT);
  return HOST_KINDS.filter((kind) => endpoints.has(kind)).map((kind) => ({ kind, endpoint: endpoints.get(kind)! }));
}

export function selectHost(env: NodeJS.ProcessEnv): HostSelection {
  const available = availableHosts(env);
  const explicit = explicitKind(env);
  if (explicit !== undefined) {
    if (!isHostKind(explicit)) throw new Error(`PI_ORCHESTRATION_HOST must be one of ${HOST_KINDS.join(", ")}`);
    const selection = available.find((host) => host.kind === explicit);
    if (!selection) throw new Error(`No ${explicit} endpoint; set PI_ORCHESTRATION_ENDPOINT`);
    return selection;
  }
  if (available.length > 1) {
    throw new Error(`Several orchestration hosts are present (${available.map((host) => host.kind).join(", ")}); set PI_ORCHESTRATION_HOST explicitly`);
  }
  const selection = available[0];
  if (!selection) throw new Error("Orchestration needs tmux, Herdr, or Pilish; set PI_ORCHESTRATION_HOST to select one");
  return selection;
}

/** Frozen at first use; later environment changes never redirect operations. */
function environment(): Environment {
  const shared = state();
  if (!shared.environment) {
    const available = availableHosts(process.env);
    let configured: HostSelection | Error;
    try {
      configured = selectHost(process.env);
    } catch (error) {
      configured = error instanceof Error ? error : new Error(String(error));
    }
    shared.environment = { available, configured };
  }
  return shared.environment;
}

export interface OrchestrationHostState {
  available: HostSelection[];
  configured: HostSelection | undefined;
  override: HostKind | null;
  effective: HostSelection | undefined;
  /** Why no host is usable, when `effective` is undefined. */
  unavailable: string | undefined;
}

export function getHostState(): OrchestrationHostState {
  const { available, configured } = environment();
  const override = state().override;
  const base = { available, configured: configured instanceof Error ? undefined : configured, override };
  if (override === null) {
    return configured instanceof Error
      ? { ...base, effective: undefined, unavailable: configured.message }
      : { ...base, effective: configured, unavailable: undefined };
  }
  const selection = available.find((host) => host.kind === override);
  if (selection) return { ...base, effective: selection, unavailable: undefined };
  const reachable = available.map((host) => host.kind).join(", ") || "none";
  return {
    ...base, effective: undefined,
    unavailable: `The selected orchestration host '${override}' is not reachable from this Pi process (reachable: ${reachable}). Select a reachable host or reset the selection.`,
  };
}

/** Applies to hosts started after the change; existing targets keep their own host. */
export function setHostOverride(kind: HostKind | null): void {
  if (kind !== null && !isHostKind(kind)) throw new Error("Orchestration host selection must be tmux, herdr, emacs, or null.");
  state().override = kind;
}

function createNativeHost(pi: ExtensionAPI, kind: HostKind, endpoint: string): Host {
  if (kind === "herdr") return createHerdrHost(pi, endpoint);
  if (kind === "tmux") return createTmuxHost(pi, endpoint);
  return createEmacsHost(pi, endpoint);
}

function createHost(pi: ExtensionAPI, kind: HostKind, endpoint: string): Host {
  const native = createNativeHost(pi, kind, endpoint);
  return {
    ...native,
    start(spec, signal) {
      const start = () => {
        signal?.throwIfAborted();
        const nesting = spec.kind === "pi" ? childNestingEnvironment()
          : process.env.PI_NESTED === undefined ? {} : { PI_NESTED: process.env.PI_NESTED };
        // Pi children run their tools where this process does unless the spec names another target.
        const remote: Record<string, string> = spec.kind === "pi" && process.env[REMOTE_ENV] ? { [REMOTE_ENV]: process.env[REMOTE_ENV] } : {};
        // Explicit identity for any frontend sharing the child (pimux discovery); empty values
        // override what a host's own environment could pass on.
        const placement: Record<string, string> = spec.kind !== "pi" ? {} : {
          // Never inherit another worker's claim or its ancestor task lease.
          PHIMACS_MANAGED_CLAIM: "",
          PHIMACS_PARENT_TASK: spec.placement === "worker" ? spec.env?.PHIMACS_PARENT_TASK ?? "" : "",
          PHIMACS_PARENT_TASK_FILE: spec.placement === "worker" ? spec.env?.PHIMACS_PARENT_TASK_FILE ?? "" : "",
          PI_ORCHESTRATION_PLACEMENT: spec.placement,
          PI_ORCHESTRATION_PARENT: spec.parent
            ? JSON.stringify({ host: spec.parent.host, endpoint: spec.parent.endpoint, id: spec.parent.id, name: spec.parent.name }) : "",
        };
        return native.start({
          ...spec,
          env: {
            ...(process.env.PI_CODING_AGENT_DIR ? { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR } : {}),
            ...remote, ...spec.env, ...nesting, ...placement, PI_ORCHESTRATION_HOST: kind, PI_ORCHESTRATION_ENDPOINT: endpoint,
          },
        }, signal);
      };
      if (spec.kind !== "pi") return start();
      // Shared across extension instances. Only authentication-sensitive startup is serialized.
      const shared = state();
      const operation = shared.startup.then(start);
      shared.startup = operation.then(() => undefined, () => undefined);
      return operation;
    },
  };
}

/** Called by an orchestration operation, not by extension discovery/startup. */
export function getHost(pi: ExtensionAPI): Host {
  const selected = getHostState();
  if (!selected.effective) throw new Error(selected.unavailable ?? "Orchestration has no usable host.");
  return createHost(pi, selected.effective.kind, selected.effective.endpoint);
}

/** Never resolve a stored target against today's environment. */
export function hostForTarget(pi: ExtensionAPI, target: HostTarget): Host {
  return createHost(pi, target.host, target.endpoint);
}
