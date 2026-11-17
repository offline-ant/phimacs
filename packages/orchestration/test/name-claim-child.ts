import * as path from "node:path";
import * as os from "node:os";
import { tryClaimName } from "../workers.ts";
import { withTransaction } from "@phimacs/pimux/transaction";
import { readProcessIdentity } from "@phimacs/pimux/process-identity";

const name = "race";
let release: (() => void) | undefined;
process.on("message", (message: { id: number; type: string }) => {
  try {
    if (message.type === "hold-transaction") {
      withTransaction(path.join(os.tmpdir(), "pi-orchestration-targets", `${name}.transactions`), () => {
        process.send?.({ id: message.id, held: true });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      });
    } else if (message.type === "release") {
      release?.(); release = undefined;
      process.send?.({ id: message.id, released: true });
    } else {
      release = tryClaimName(name);
      process.send?.({ id: message.id, acquired: !!release });
    }
  } catch (error) { process.send?.({ id: message.id, error: String(error) }); }
});
process.send?.({ ready: true, identity: readProcessIdentity(process.pid) });
