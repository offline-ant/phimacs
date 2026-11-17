/** Test extension: holds the prompt "held" in an async input hook until PIMUX_HELD_INPUT_DIR/release exists. */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function heldInput(pi: ExtensionAPI): void {
  const directory = process.env.PIMUX_HELD_INPUT_DIR;
  pi.on("input", async (event) => {
    if (!directory || event.text !== "held") return { action: "continue" };
    const release = path.join(directory, "release");
    await new Promise<void>((resolve) => {
      const watcher = fs.watch(directory, () => { if (fs.existsSync(release)) { watcher.close(); resolve(); } });
      fs.writeFileSync(path.join(directory, "holding"), "");
      if (fs.existsSync(release)) { watcher.close(); resolve(); }
    });
    return { action: "continue" };
  });
}
