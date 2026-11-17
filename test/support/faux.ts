// Shared Pi extension for every real-Pi test: inference stays inside Pi's
// in-process faux providers, so no network-backed provider is ever called.
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * Providers `fx` (instant) and `fx-slow` (slow enough to join or steer
 * mid-reply), models `one` and `two`. Prompts:
 * - "hold NAME": reply only after the test creates `$FX_HOLD_DIR/NAME`.
 * - "stream N": N words. "slow [N]": stay working for N (default 4) seconds.
 * - "tool": a bash tool printing until stopped, with a silent background child
 *   whose PID is written to `tool.pid` in the working directory.
 * - "gated tool": the `fx_hold` tool, which holds on "tool".
 * - "open panel NAME" / "close panel NAME": orchestration panel tools.
 * - "run worker [NAME]": a `do` worker (holding on NAME when given);
 *   "run refusing worker": one whose task is refused.
 * - text containing "refuse": a provider refusal.
 * Anything else replies "reply: TEXT"; tool results reply "tool done: NAME".
 */
export default function faux(pi: ExtensionAPI): void {
  // Single-token chunks make the slow provider's stream fine-grained enough to join.
  for (const [name, options] of [["fx", { tokensPerSecond: 1_000_000 }], ["fx-slow", { tokensPerSecond: 90, tokenSize: { min: 1, max: 1 } }]] as const) {
    const provider = fauxProvider({ provider: name, models: [{ id: "one", reasoning: true }, { id: "two", reasoning: true }], ...options });
    provider.setResponses(Array.from({ length: 200 }, () => respond));
    pi.registerProvider(provider.provider);
  }
  pi.on("before_agent_start", (_event, ctx) => {
    if (ctx.model?.provider !== "fx" && ctx.model?.provider !== "fx-slow") throw new Error("Test fixture refuses non-faux providers");
  });
  pi.registerTool(defineTool({
    name: "fx_hold", label: "Hold", description: "Wait until the test releases the hold", parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      await hold("tool", signal);
      return { content: [{ type: "text", text: "released" }], details: {} };
    },
  }));
  pi.registerCommand("fx-select", {
    description: "Ask a select dialog; args: optional timeout in ms",
    handler: async (args, ctx) => {
      const timeout = Number(args.trim()) || undefined;
      const choice = await ctx.ui.select("Pick a fruit", ["apple", "pear"], { timeout });
      ctx.ui.notify(`picked:${choice ?? "none"}`, "info");
    },
  });
  pi.registerCommand("fx-two", {
    description: "Ask two dialogs at once",
    handler: async (_args, ctx) => {
      const choices = await Promise.all([ctx.ui.select("Fruit one", ["apple", "pear"]), ctx.ui.select("Fruit two", ["plum", "fig"])]);
      ctx.ui.notify(`both:${choices.join(",")}`, "info");
    },
  });
  pi.registerCommand("fx-confirm", {
    description: "Ask a confirmation",
    handler: async (_args, ctx) => {
      const confirmed = await ctx.ui.confirm("Really?", "This is the confirmation message.");
      ctx.ui.notify(`confirmed:${confirmed}`, "info");
    },
  });
  pi.registerCommand("fx-abandon", {
    description: "Ask a dialog that the extension abandons after 200 ms",
    handler: async (_args, ctx) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 200);
      const confirmed = await ctx.ui.confirm("Abandoned", "?", { signal: controller.signal });
      ctx.ui.notify(`abandoned:${confirmed}`, "info");
    },
  });
  pi.registerCommand("fx-status", {
    description: "Show a status, which asks nothing of anyone",
    handler: async (_args, ctx) => { ctx.ui.setStatus("fx", "busy with something"); },
  });
  // The extension UI an interrupted worker sends, over real RPC.
  pi.registerCommand("fx-wait", {
    description: "Act as a worker waiting for the user",
    handler: async (_args, ctx) => {
      ctx.ui.setStatus("worker-frame", ctx.ui.theme.fg("warning", "worker:waiting"));
      ctx.ui.setWidget("worker-frame", ["Worker interrupted", "Type a message to continue"]);
      ctx.ui.notify("Worker interrupted", "warning");
    },
  });
  pi.registerCommand("fx-continue", {
    description: "End a worker's wait",
    handler: async (_args, ctx) => {
      ctx.ui.setStatus("worker-frame", "worker:auto");
      ctx.ui.setWidget("worker-frame", undefined);
    },
  });
  pi.registerCommand("fx-new", {
    description: "Start a new session from an extension command",
    handler: async (_args, ctx) => {
      const result = await ctx.newSession();
      fs.writeFileSync(path.join(process.cwd(), "fx-new.json"), JSON.stringify(result));
    },
  });
  pi.registerCommand("fx-tree", {
    description: "Move the selected branch to an entry (default: the first message) without summarizing",
    handler: async (target, ctx) => {
      const entry = target.trim() || ctx.sessionManager.getEntries().find((item) => item.type === "message")?.id;
      if (!entry) throw new Error("Fixture session has no message to navigate to");
      const result = await ctx.navigateTree(entry, { summarize: false });
      if (result.cancelled) throw new Error("Fixture branch move was cancelled");
    },
  });
}

async function respond(context: TranscriptContext) {
  const last = context.messages.at(-1);
  if (last?.role === "toolResult") return fauxAssistantMessage(`tool done: ${last.toolName}`);
  const text = lastUserText(context);
  if (text === "tool") {
    const command = `sleep 300 & echo $! > ${JSON.stringify(path.join(process.cwd(), "tool.pid"))}; while :; do echo tick; sleep 0.05; done`;
    return fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" });
  }
  if (text === "gated tool") return fauxAssistantMessage([fauxToolCall("fx_hold", {})], { stopReason: "toolUse" });
  const panel = /^(open|close) panel (\S+)/.exec(text);
  if (panel) {
    return fauxAssistantMessage([panel[1] === "open"
      ? fauxToolCall("panel-start", { name: panel[2], command: "sleep 120" })
      : fauxToolCall("panel-close", { name: panel[2] })], { stopReason: "toolUse" });
  }
  if (text.startsWith("run refusing worker")) return fauxAssistantMessage([fauxToolCall("do", { task: "refuse once" })], { stopReason: "toolUse" });
  const worker = /^run worker(?: ([a-z0-9-]+))?/.exec(text);
  if (worker) {
    const task = worker[1] ? `hold ${worker[1]}, then report back` : "say hello from the worker";
    return fauxAssistantMessage([fauxToolCall("do", { task })], { stopReason: "toolUse" });
  }
  // Worker tasks arrive inside a longer brief, so holds match anywhere.
  const held = /\bhold ([a-z0-9-]+)\b/.exec(text);
  if (held) await hold(held[1]!);
  const slow = /^slow(?: (\d+))?/.exec(text);
  if (slow) await delay(1000 * Number(slow[1] ?? 4));
  if (text.includes("refuse")) return fauxAssistantMessage("", { stopReason: "error", errorMessage: "Claude declined to respond (refusal: cyber): faux" });
  const stream = /^stream (\d+)/.exec(text);
  if (stream) return fauxAssistantMessage(Array.from({ length: Number(stream[1]) }, (_, index) => `word${index}`).join(" "));
  return fauxAssistantMessage(`reply: ${text}`);
}

function lastUserText(context: TranscriptContext): string {
  const message = context.messages.findLast((item) => item.role === "user");
  if (!message) return "";
  return typeof message.content === "string" ? message.content
    : message.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n");
}

/** Holds until the test creates `$FX_HOLD_DIR/<name>`, so "busy" is exact. */
async function hold(name: string, signal?: AbortSignal): Promise<void> {
  const directory = process.env.FX_HOLD_DIR;
  if (!directory || !path.isAbsolute(directory)) throw new Error("Set an absolute FX_HOLD_DIR to use fixture holds");
  const deadline = performance.now() + 60_000;
  while (!fs.existsSync(path.join(directory, name))) {
    if (performance.now() > deadline) throw new Error(`Fixture hold timed out: ${name}`);
    await delay(20, undefined, { signal });
  }
}
