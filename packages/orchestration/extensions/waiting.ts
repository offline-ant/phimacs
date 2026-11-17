// Publishes whether this agent only waits on orchestration work rather than working itself.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Extension status key frontends read; its text is "waiting" while set. */
export const WAITING_STATUS_KEY = "orchestration-waiting";

/** Tools whose execution is waiting on another agent or process. */
const WAITING_TOOLS = new Set(["do", "microdo", "delegate", "fresh_look", "wait"]);

interface RunningTool {
  name: string;
  parent?: string;
}

/** True when tools run and every running leaf (a call with no running child) is a waiting tool. */
export function onlyWaiting(running: ReadonlyMap<string, RunningTool>): boolean {
  if (running.size === 0) return false;
  const parents = new Set([...running.values()].flatMap((tool) => tool.parent === undefined ? [] : [tool.parent]));
  return [...running].every(([id, tool]) => parents.has(id) || WAITING_TOOLS.has(tool.name));
}

export default function waitingStatusExtension(pi: ExtensionAPI): void {
  const running = new Map<string, RunningTool>();
  let waiting = false;

  function publish(ctx: ExtensionContext): void {
    const next = onlyWaiting(running);
    if (next === waiting) return;
    waiting = next;
    ctx.ui.setStatus(WAITING_STATUS_KEY, next ? "waiting" : undefined);
  }

  pi.on("tool_execution_start", (event, ctx) => {
    running.set(event.toolCallId, { name: event.toolName, ...event.parentToolCallId === undefined ? {} : { parent: event.parentToolCallId } });
    publish(ctx);
  });
  pi.on("tool_execution_end", (event, ctx) => {
    running.delete(event.toolCallId);
    publish(ctx);
  });
}
