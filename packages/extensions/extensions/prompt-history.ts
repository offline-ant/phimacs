/** `prompt_history({idx?})`: exact text of one user prompt on the current branch, also after compaction. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const promptSchema = Type.Object({
  text: Type.String(),
  index: Type.Integer(),
  from_end: Type.Integer({ description: "-1 is the current prompt." }),
  time: Type.String(),
});

export default function promptHistory(pi: ExtensionAPI) {
  pi.registerTool({
    name: "prompt_history",
    label: "Prompt History",
    description: "Return the exact text of one user prompt on the current branch, including prompts that compaction summarized. "
      + "idx follows Python: 0 is the first prompt, -1 (default) the current one.",
    promptSnippet: "Read the exact text of an earlier user prompt, including compacted ones",
    promptGuidelines: ["Use prompt_history to quote the user's exact words; do not reconstruct them from memory or summaries."],
    parameters: Type.Object({ idx: Type.Optional(Type.Integer()) }),
    outputSchema: promptSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const prompts = ctx.sessionManager.getBranch().flatMap((entry) =>
        entry.type === "message" && entry.message.role === "user" ? [entry.message] : []);
      const idx = params.idx ?? -1;
      const index = idx < 0 ? prompts.length + idx : idx;
      const message = prompts[index];
      if (!message) throw new Error(`idx ${idx} is out of range: this branch has ${prompts.length} prompts.`);
      const text = typeof message.content === "string"
        ? message.content
        : message.content.map((block) => block.type === "text" ? block.text : `[image: ${block.mimeType}]`).join("\n");
      return {
        content: [{ type: "text", text }],
        details: {},
        structuredContent: { text, index, from_end: index - prompts.length, time: new Date(message.timestamp).toISOString() },
      };
    },
  });
}
