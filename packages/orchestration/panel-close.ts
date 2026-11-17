import { existsSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { closePanel, type PanelBinding } from "./panel-runtime.ts";

/** Native UIs use the same identity-bound close as tools, never a terminal PID. */
export async function closeNativePanelBinding(binding: PanelBinding): Promise<void> {
  await closePanel(binding);
}

// Node runs the main module from its real path; compare real paths so a
// symlinked invocation does not silently skip the entry point.
if (process.argv[1] && existsSync(process.argv[1]) && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  try {
    const binding = JSON.parse(process.argv[2] ?? "null") as PanelBinding;
    await closeNativePanelBinding(binding);
    process.stdout.write(`${JSON.stringify({ success: true, id: binding.id })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
