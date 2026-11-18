import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import initAgentsMd from "./init-agents-md.ts";

test("/init-agents-md submits the template after the agent is idle", async () => {
  const events: string[] = [];
  let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  const pi = {
    registerCommand: (name: string, spec: { handler: typeof handler }) => {
      assert.equal(name, "init-agents-md");
      handler = spec.handler;
    },
    sendUserMessage: (text: string) => events.push(text),
  } as unknown as ExtensionAPI;
  initAgentsMd(pi);
  const ctx = { waitForIdle: async () => { events.push("idle"); } } as unknown as ExtensionCommandContext;

  await handler!("", ctx);

  const template = readFileSync(new URL("./agents-md-template.md", import.meta.url), "utf8");
  assert.equal(events[0], "idle");
  assert.ok(events[1]?.endsWith(`<template>\n${template}</template>`));

  await handler!("  focus on the SDK folder ", ctx);
  assert.ok(events[3]?.endsWith(`</template>\n\nAdditional instructions for this update: focus on the SDK folder`));
});
