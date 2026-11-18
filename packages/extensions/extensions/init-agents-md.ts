/**
 * /init-agents-md — ask the agent to create or update ./AGENTS.md from the
 * standard template in agents-md-template.md.
 */

import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TEMPLATE_URL = new URL("./agents-md-template.md", import.meta.url);

/** The agent prompt; nonblank `extra` guides this update only. */
export function initAgentsMdPrompt(template: string, extra = ""): string {
  const instructions = extra.trim() ? `\n\nAdditional instructions for this update: ${extra.trim()}` : "";
  return `Create or update AGENTS.md in the current directory from the standard template below.

- First read any AGENTS.md and CLAUDE.md here, the README, and the files that define the project's commands.
- Change only ./AGENTS.md. Keep its project rules, deliberate exceptions, stricter limits and links. Where a generic rule overlaps a template rule, use the template's wording. Ask if existing instructions conflict with the template.
- Pi reads AGENTS.md instead of CLAUDE.md in the same directory: carry CLAUDE.md's project rules into AGENTS.md, and leave CLAUDE.md unchanged.
- Fill in the title and the short introduction. Add only very short project specifics: pointers to the documents and commands that own the truth (README, design docs, check commands), not the information itself.
- Include each applicable template rule once, in the template's wording. Leave out rules that clearly do not apply to this project.
- Check the links and commands that you name, then show a short summary of what changed.

<template>
${template}</template>${instructions}`;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("init-agents-md", {
    description: "Create or update AGENTS.md from the standard rules template; arguments add instructions for this update",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      pi.sendUserMessage(initAgentsMdPrompt(await readFile(TEMPLATE_URL, "utf8"), args));
    },
  });
}
