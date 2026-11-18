// Faux direct/router catalogs for real managed model-control tests; inference is forbidden.
import fs from "node:fs";
import path from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function modelCatalog(pi: ExtensionAPI): void {
  for (const provider of ["openai", "openrouter"]) {
    const fake = fauxProvider({ provider, models: [{ id: "old" }, { id: "gpt-6.2-sol" }] }).provider;
    const all = fake.getModels().map((model) => ({ ...model, baseUrl: "https://faux-private-endpoint.invalid/v1",
      headers: { "X-Faux-Secret": "synthetic-private-header" } }));
    let current: typeof all = all.slice(0, 1);
    pi.registerProvider({
      ...fake,
      getModels: () => current,
      getAllModels: () => current,
      async refreshModels(context) {
        if (!fs.existsSync(path.join(process.cwd(), "catalog-published"))) return;
        await context.publish({ update: () => { current = all; } });
      },
    });
  }
  pi.on("before_agent_start", () => { throw new Error("Model-control fixture forbids inference"); });
}
