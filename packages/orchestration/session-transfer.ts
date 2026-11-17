export { reserveManagedSession } from "@phimacs/pimux/guard";

export const TRANSFER_OWNERSHIP_BLOCKER =
  "Native session handoff is unavailable in Pi: the source cannot be made permanently unable to write before another Pi opens its file, and failed replacements have no authoritative settlement. No claim was released and no destination was opened. For a detached RPC agent use /switch emacs to attach the same runtime. For a native agent, explicitly stop it, verify its owned process has exited, then reopen the saved conversation with `phimacs pi`. Do not run a second raw pi --session against a live conversation.";

const TRANSFERRING = Symbol.for("pi-orchestration:transferring");
export function transferOperation(): { active: boolean } {
  const global = globalThis as typeof globalThis & { [TRANSFERRING]?: { active: boolean } };
  return global[TRANSFERRING] ??= { active: false };
}
