import * as fs from "node:fs";
import * as path from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Switch lifecycle evidence only: a model request is always a test failure. */
export default function switchNativeFixture(pi: ExtensionAPI): void {
  const trace = (event: string, ctx: ExtensionContext): void => {
    fs.appendFileSync(path.join(ctx.cwd, "switch-trace.jsonl"), `${JSON.stringify({
      event, pid: process.pid, file: ctx.sessionManager.getSessionFile(), sessionId: ctx.sessionManager.getSessionId(),
      mode: ctx.mode, host: process.env.PI_ORCHESTRATION_HOST, pane: process.env.HERDR_PANE_ID,
      workspace: process.env.HERDR_WORKSPACE_ID, control: process.env.PI_ORCHESTRATION_CONTROL,
      target: process.env.PI_ORCHESTRATION_TARGET, endpoint: process.env.PI_ORCHESTRATION_ENDPOINT,
      namespaces: Object.fromEntries(["HOME", "TMPDIR", "PHIMACS_STATE_DIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME",
        "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "PIMUX_DIR"]
        .map((key) => [key, process.env[key]])),
      cwd: ctx.cwd, model: ctx.model?.id, provider: ctx.model?.provider, thinking: pi.getThinkingLevel(),
      tools: pi.getActiveTools(), branch: ctx.sessionManager.getBranch().map((entry) => entry.id),
    })}\n`);
  };
  const provider = fauxProvider({ provider: "switch-native-fixture", models: [{ id: "one", reasoning: true }] });
  provider.setResponses([() => { throw new Error("Native switch must not call a model"); }]);
  pi.registerProvider(provider.provider);
  pi.on("session_start", (_event, ctx) => trace("start", ctx));
  pi.on("session_shutdown", (_event, ctx) => trace("shutdown", ctx));
  pi.on("before_agent_start", (_event, ctx) => { trace("unexpected-inference", ctx); throw new Error("No inference in transfer smoke"); });
  pi.registerCommand("switch-smoke-state", { handler: async (_args, ctx) => trace("state", ctx) });
  // Writes history without inference; the traced branch ends with the new entry.
  pi.registerCommand("switch-smoke-mark", { handler: async (args, ctx) => {
    pi.appendEntry("switch-smoke:mark", { label: args.trim() });
    trace("marked", ctx);
  } });
  pi.registerCommand("switch-smoke-branch", { handler: async (args, ctx) => {
    await ctx.navigateTree(args.trim(), { summarize: false });
    trace("branched", ctx);
  } });
}
