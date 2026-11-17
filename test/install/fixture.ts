// Inspect installed extension registration and provide local-only inference.
import fs from "node:fs";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function installationFixture(pi: ExtensionAPI): void {
  const provider = fauxProvider({ provider: "installation", models: [{ id: "one" }], tokensPerSecond: 1_000_000 });
  provider.setResponses(Array.from({ length: 8 }, () => () => fauxAssistantMessage("installed reply")));
  pi.registerProvider(provider.provider);
  pi.on("before_agent_start", (_event, ctx) => {
    if (ctx.model?.provider !== "installation") throw new Error("Installation checks refuse network-backed inference");
  });
  pi.registerCommand("installation-check", {
    description: "Record installed tool and command registration without inference",
    handler: async () => {
      const target = process.env.PHIMACS_INSTALLATION_REPORT;
      if (!target) throw new Error("Missing installation report path");
      fs.writeFileSync(target, JSON.stringify({
        tools: pi.getAllTools().map(tool => tool.name),
        commands: pi.getCommands().map(command => command.name),
      }));
    },
  });
}
