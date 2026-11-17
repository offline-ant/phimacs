import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { transferOperation, TRANSFER_OWNERSHIP_BLOCKER } from "../session-transfer.ts";
import {
  prepareSwitch, sharedMuxId, switchEnvironment,
  type PreparedSwitch, type SwitchDestination, type SwitchSource,
} from "../switch-destinations.ts";

export interface SwitchDependencies {
  prepare: (kind: SwitchDestination, source: SwitchSource) => Promise<PreparedSwitch>;
  runtime: (environment: NodeJS.ProcessEnv, sessionFile: string | undefined) => string | undefined;
  environment: () => NodeJS.ProcessEnv;
}

export function registerSwitch(pi: ExtensionAPI, dependencies: SwitchDependencies = {
  prepare: prepareSwitch, runtime: sharedMuxId, environment: () => process.env,
}): void {
  pi.registerCommand("switch", {
    description: "Attach Emacs to this shared runtime; native writer handoff is unavailable. Usage: /switch [herdr|emacs]",
    handler: async (args, ctx) => {
      if (transferOperation().active) { ctx.ui.notify("A session transfer is already in progress.", "warning"); return; }
      transferOperation().active = true;
      try {
        let destination = args.trim();
        if (!destination) destination = await ctx.ui.select("Open this session in", ["herdr", "emacs"]) ?? "";
        if (!destination) return;
        if (destination !== "herdr" && destination !== "emacs") {
          throw new Error("Usage: /switch [herdr|emacs]. Native writer handoff is unavailable.");
        }
        const environment = dependencies.environment();
        const sessionFile = ctx.sessionManager.getSessionFile();
        const muxId = dependencies.runtime(environment, sessionFile);
        if (!muxId || destination === "herdr") throw new Error(TRANSFER_OWNERSHIP_BLOCKER);
        // Sharing moves no session and does not release a claim, reset tools,
        // reload a provider, or infer another prompt. It is safe while busy too.
        if (!sessionFile) throw new Error("The shared runtime has no persistent session identity.");
        const source: SwitchSource = {
          sessionFile, cwd: ctx.cwd, args: [], env: switchEnvironment(environment),
          runtime: { protocol: 2, muxId },
        };
        const receipt = await (await dependencies.prepare(destination, source)).start();
        ctx.ui.notify(`${receipt}\nBoth views stay live and in sync. Frontend loss disconnects; Agent Close ends the shared agent everywhere.`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "Session attachment failed; the source runtime is unchanged.", "error");
      } finally {
        transferOperation().active = false;
      }
    },
  });
}

export default function switchExtension(pi: ExtensionAPI): void {
  registerSwitch(pi);
}
