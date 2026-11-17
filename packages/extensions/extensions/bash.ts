import { getAgentDir, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@phimacs/orchestration/bash-tool";
import { sessionRemote } from "@phimacs/orchestration/remote-session";

export default function bashExtension(pi: ExtensionAPI): void {
  // Remote bash belongs to orchestration; the first custom registration wins.
  if (sessionRemote()) return;
  pi.registerTool({
    ...createBashToolDefinition(process.cwd()),
    execute(toolCallId, params, signal, onUpdate, ctx) {
      const settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() });
      return createBashToolDefinition(ctx.cwd, {
        shellPath: settings.getShellPath(),
        commandPrefix: settings.getShellCommandPrefix(),
      }).execute(toolCallId, params, signal, onUpdate, ctx);
    },
  });
}
