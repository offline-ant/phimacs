import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Deterministic provisional-start window, with no inference or external I/O. */
export default function slowStart(pi: ExtensionAPI): void {
  pi.on("session_start", async () => { await delay(5000); });
}
