import { ownRuntime } from "./runtime-owner.ts";
import { isRecord } from "./protocol.ts";
import type { RuntimeInitialization } from "./runtime.ts";

let initialized = false;
const deadline = setTimeout(() => process.exit(1), 10_000);
process.once("message", (message: unknown) => {
  if (initialized || !isRecord(message) || message.type !== "initialize") { process.exitCode = 1; return; }
  initialized = true; clearTimeout(deadline);
  void ownRuntime(message as unknown as RuntimeInitialization).catch((error: unknown) => {
    if (process.connected) process.send?.({ type: "failed", error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  });
});
process.on("disconnect", () => { if (!initialized) process.exit(1); });
