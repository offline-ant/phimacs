import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ERROR_CLAIM_EVENT, ERROR_CONTINUE_EVENT, type ErrorClaim, type ErrorContinue } from "@phimacs/orchestration/error-events";

export const CONTINUE_OPTION = "Continue";
export const REPLY_OPTION = "Type my own reply";
export const CONTINUE_TEXT = "continue";
const MAX_TITLE_LENGTH = 160;

function errorTitle(errorMessage: string | undefined): string {
  const collapsed = (errorMessage ?? "").replace(/\s+/g, " ").trim() || "The run stopped without an error message.";
  const title = `Error: ${collapsed}`;
  return title.length <= MAX_TITLE_LENGTH ? title : `${title.slice(0, MAX_TITLE_LENGTH - 1)}…`;
}

/**
 * Asks the user what to do when a run ends in an error nothing else recovers from.
 * Pi's retries and compaction finish before agent_settled, and providers wait
 * inside their request, so an error that reaches settlement stopped the conversation.
 */
export default function errorPrompt(pi: ExtensionAPI): void {
  let claimed = false;
  let open: AbortController | undefined;

  async function prompt(ctx: ExtensionContext, errorMessage: string | undefined): Promise<void> {
    const controller = new AbortController();
    open = controller;
    pi.events.emit("herdr:blocked", { active: true, label: "Model error" });
    let choice: string | undefined;
    try {
      choice = await ctx.ui.select(errorTitle(errorMessage), [CONTINUE_OPTION, REPLY_OPTION], { signal: controller.signal });
    } finally {
      open = undefined;
      pi.events.emit("herdr:blocked", { active: false });
    }
    if (choice !== CONTINUE_OPTION || controller.signal.aborted) return;
    pi.events.emit(ERROR_CONTINUE_EVENT, { text: CONTINUE_TEXT } satisfies ErrorContinue);
    await pi.sendUserMessage(CONTINUE_TEXT);
  }

  // The worker frame finishes retrospectives at agent_settled, before this extension's
  // handler can run, so ownership is read while its request is certainly still active.
  pi.on("agent_end", () => {
    const claim: ErrorClaim = { claimed: false };
    pi.events.emit(ERROR_CLAIM_EVENT, claim);
    claimed = claim.claimed;
  });

  pi.on("agent_settled", (event, ctx) => {
    if (event.aborted || claimed || open || !ctx.hasUI || !ctx.isIdle() || ctx.hasPendingMessages()) return;
    const leaf = ctx.sessionManager.getLeafEntry();
    if (leaf?.type !== "message" || leaf.message.role !== "assistant" || leaf.message.stopReason !== "error") return;
    // Never awaited: Pi awaits this handler, and waiting for the user here would hold the session unsettled.
    prompt(ctx, leaf.message.errorMessage).catch((error: unknown) => {
      ctx.ui.notify(`Could not continue after the error: ${error instanceof Error ? error.message : String(error)}`, "error");
    });
  });

  // Dialogs close themselves on these signals; anything the user sends answers the question.
  pi.on("agent_start", () => { open?.abort(); });
  pi.on("session_tree", () => { open?.abort(); });
  pi.on("session_shutdown", () => { open?.abort(); });
}
