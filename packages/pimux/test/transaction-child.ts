import * as fs from "node:fs";
import * as path from "node:path";
import { withTransaction } from "../transaction.ts";
import { readProcessIdentity } from "../process-identity.ts";

const directory = process.argv[2];
process.on("message", (message: { id: number; type: string; count?: number }) => {
  try {
    if (message.type === "hold") {
      withTransaction(directory, () => {
        process.send?.({ id: message.id, held: true });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      });
    } else {
      for (let index = 0; index < (message.count ?? 1); index++) withTransaction(directory, () => {
        const sentinel = path.join(directory, "critical");
        const fd = fs.openSync(sentinel, "wx", 0o600);
        try {
          const counter = path.join(directory, "counter");
          const value = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
          fs.writeFileSync(counter, String(value + 1), { mode: 0o600 });
        } finally { fs.closeSync(fd); fs.unlinkSync(sentinel); }
      });
      process.send?.({ id: message.id, ok: true });
    }
  } catch (error) { process.send?.({ id: message.id, error: String(error) }); }
});
process.send?.({ ready: true, identity: readProcessIdentity(process.pid) });
