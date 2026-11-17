// Move a managed Pi's session leaf and persist unsummarized navigation.
import type { ExtensionAPI, SessionTreeEvent } from "@earendil-works/pi-coding-agent";
import { TREE_NAVIGATE_COMMAND, TREE_NAVIGATION_MARKER_TYPE } from "./protocol.ts";

const USAGE = `Usage: /${TREE_NAVIGATE_COMMAND} [--summarize] <entry-id>`;

function parseArgs(args: string): { entryId: string; summarize: boolean } {
  const tokens = args.trim().split(/\s+/).filter((token) => token !== "");
  const summarize = tokens[0] === "--summarize";
  const rest = summarize ? tokens.slice(1) : tokens;
  const flag = rest.find((token) => token.startsWith("-"));
  if (flag !== undefined) throw new Error(`Unknown flag: ${flag}. ${USAGE}`);
  if (rest.length !== 1) throw new Error(`Expected exactly one entry ID. ${USAGE}`);
  return { entryId: rest[0], summarize };
}

/** Register the in-process command used by managed runtime clients. */
export default function treeNavigate(pi: ExtensionAPI): void {
  let pending = false;
  let observed: SessionTreeEvent | undefined;

  pi.on("session_tree", (event) => {
    if (pending) observed = event;
  });

  pi.registerCommand(TREE_NAVIGATE_COMMAND, {
    description: "Navigate to a session tree entry, optionally summarizing the abandoned branch",
    handler: async (args, ctx) => {
      const { entryId, summarize } = parseArgs(args);
      if (!ctx.isIdle()) throw new Error("Cannot navigate the session tree while the agent is busy");
      if (ctx.sessionManager.getEntry(entryId) === undefined) throw new Error(`Unknown entry: ${entryId}`);

      observed = undefined;
      pending = true;
      let result: { cancelled: boolean };
      let event: SessionTreeEvent | undefined;
      try {
        result = await ctx.navigateTree(entryId, { summarize });
      } finally {
        pending = false;
        // Pi emits through the callback during navigateTree; TypeScript cannot track that assignment.
        event = observed as SessionTreeEvent | undefined;
        observed = undefined;
      }

      if (result.cancelled) throw new Error(`Navigation to ${entryId} was cancelled`);
      if (event === undefined || event.summaryEntry !== undefined) return;
      if (event.newLeafId === event.oldLeafId) return;
      pi.appendEntry(TREE_NAVIGATION_MARKER_TYPE, { navigatedTo: entryId });
    },
  });
}
