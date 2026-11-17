/** Root-only native integration inputs, never exported from runtime packages. */
export type { Host, HostTarget } from "../../packages/orchestration/host-types.ts";
export { readTarget, removeTarget } from "../../packages/orchestration/workers.ts";
export { createTmuxHost } from "../../packages/orchestration/hosts/tmux.ts";
export { createHerdrHost } from "../../packages/orchestration/hosts/herdr.ts";
export { createEmacsHost } from "../../packages/orchestration/hosts/emacs.ts";
