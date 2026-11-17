import type { ProcessIdentity } from "@phimacs/pimux/process-identity";
import type { RuntimeReceipt } from "@phimacs/pimux/runtime";
import type { PanelBinding } from "./panel-runtime.ts";

export const HOST_KINDS = ["tmux", "herdr", "emacs"] as const;
export type HostKind = (typeof HOST_KINDS)[number];
export function isHostKind(value: unknown): value is HostKind {
  return typeof value === "string" && (HOST_KINDS as readonly string[]).includes(value);
}
/** One reachable host and the endpoint its operations need. */
export interface HostSelection {
  kind: HostKind;
  endpoint: string;
}
export interface NativePanelSurface {
  /** A private hardlink to the exact listening Unix socket, not its reusable name. */
  socket: { path: string; device: string; inode: string };
  server?: ProcessIdentity;
  panePid: number;
  process?: ProcessIdentity;
  /** Herdr can replace the terminal attached to a pane independently. */
  terminalId?: string;
}
export interface HostTarget {
  host: HostKind;
  endpoint: string;
  id: string;
  kind: "pi" | "shell";
  name: string;
  paneId?: string;
  sessionFile?: string;
  controlPath?: string;
  /** Actual owned Pi, never a frontend/socket/launcher PID. */
  process?: ProcessIdentity;
  runtime?: RuntimeReceipt;
  /** Raw terminal output of a shell panel, captured independently of its host. */
  outputPath?: string;
  /** Exact Pi that created a native shell; frontend lifetime is irrelevant. */
  owner?: ProcessIdentity;
  /** Retained when owned native cleanup could not be acknowledged. */
  closeError?: string;
  nativeSurface?: NativePanelSurface;
  /** Persistent native shell owner; command exit is separate from wrapper exit. */
  panel?: PanelBinding;
  /** Durable observer diagnostics even when the name registry cannot be read. */
  observerErrorPath?: string;
}
interface StartBase {
  name: string;
  cwd: string;
  env?: Record<string, string>;
  placement: "worker" | "interactive-fork";
  parent?: HostTarget;
}
export type StartSpec = StartBase & (
  | { kind: "pi"; sessionFile: string; args: string[]; prompt?: string; runtime?: RuntimeReceipt;
      /** Epoch ms: views need not draw older messages, such as a worker's inherited conversation. */
      hiddenHistoryBefore?: number }
  /** Complete command argv, executed verbatim. */
  | { kind: "shell"; argv: string[]; outputPath?: string }
);
export type HostInput =
  | { kind: "prompt"; text: string }
  | { kind: "text"; text: string; enter: boolean }
  | { kind: "keys"; keys: string[] };
export interface Host {
  readonly kind: HostKind;
  readonly endpoint: string;
  parent(): HostTarget | undefined;
  start(spec: StartSpec, signal?: AbortSignal): Promise<HostTarget>;
  send(target: HostTarget, input: HostInput, signal?: AbortSignal): Promise<void>;
  read(target: HostTarget, lines?: number, signal?: AbortSignal): Promise<string>;
  state(target: HostTarget, signal?: AbortSignal): Promise<"running" | "exited" | "missing">;
  close(target: HostTarget, signal?: AbortSignal): Promise<void>;
  /** Notify the native host after parent-owned task cleanup and name release. */
  taskFinished?(target: HostTarget, error?: string): Promise<void>;
}
