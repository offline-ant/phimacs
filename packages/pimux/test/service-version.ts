/** Disposable proof that each restored Pi loads current extension code. */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function versionExtension(pi: ExtensionAPI): void {
  const version = fs.readFileSync(path.join(process.cwd(), "extension-version"), "utf8");
  pi.on("session_start", (_event, ctx) => { ctx.ui.setStatus("service-version", version); });
}
