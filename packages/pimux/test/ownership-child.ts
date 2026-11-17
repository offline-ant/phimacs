/** Independent-process claim participant; only synthetic test paths are accepted. */
import { acquireClaim, ClaimConflictError, releaseClaim, type ClaimHandle } from "../ownership.ts";
import { readProcessIdentity } from "../process-identity.ts";

const identity = readProcessIdentity(process.pid);
if (!identity || !process.env.PHIMACS_TEST_ROOT) throw new Error("Synthetic claim environment required");
let handle: ClaimHandle | undefined;
process.on("message", (message: unknown) => {
  if (!message || typeof message !== "object") return;
  const command = message as { id: string; type: string; file: string };
  try {
    if (command.type === "acquire") {
      handle = acquireClaim(command.file, { id: `child-${process.pid}`, kind: "rpc", wrapper: identity, pi: null, protocol: 2 });
      process.send?.({ id: command.id, ok: true, token: handle.token, owner: handle.owner });
    } else if (command.type === "release") {
      if (handle) releaseClaim(handle);
      handle = undefined;
      process.send?.({ id: command.id, ok: true });
    } else if (command.type === "exit") {
      process.exit(0);
    }
  } catch (error) {
    process.send?.({ id: command.id, ok: false, conflict: error instanceof ClaimConflictError,
      error: error instanceof Error ? error.message : String(error),
      ...error instanceof ClaimConflictError ? { claim: error.claim } : {} });
  }
});
process.send?.({ ready: true, identity });
