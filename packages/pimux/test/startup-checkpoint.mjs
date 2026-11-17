// Fault injection is local to synthetic test owners. The unauthorized bootstrap
// must never inherit this preload; the authorized Pi may receive its own env.
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

const root = process.env.PHIMACS_TEST_ROOT;
const stage = process.env.PHIMACS_STARTUP_CHECKPOINT;
// The writer-claim owners: a service-spawned RPC owner, and the managed TUI after
// bin/pimux has re-executed into its launch entry (the CLI process itself is gone).
const owner = process.argv[1]?.endsWith("/owner-entry.js")
  || (process.argv[1]?.endsWith("/dist/launch-entry.js") && process.argv[2] === "tui");
const read = fs.readFileSync;
function identity(pid) {
  const stat = read(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
  return { pid, startTime: fields[19], bootId: read("/proc/sys/kernel/random/boot_id", "utf8").trim() };
}
function pause(child) {
  fs.writeFileSync(path.join(root, "startup-checkpoint.json"), JSON.stringify({ owner: identity(process.pid), child: identity(child), stage }), { mode: 0o600 });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
}
if (root && stage && owner) {
  if (stage === "spawned") {
    fs.readFileSync = function (file, ...args) {
      if (typeof file === "string" && /^\/proc\/\d+\/stat$/.test(file) && file !== `/proc/${process.pid}/stat`) {
        const pid = Number(file.split("/")[2]);
        const stat = read(file, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
        if (Number(fields[1]) === process.pid) pause(pid);
      }
      return Reflect.apply(read, fs, [file, ...args]);
    };
  } else if (stage === "registering" || stage === "registered") {
    const rename = fs.renameSync;
    fs.renameSync = function (from, to) {
      if (typeof to === "string" && to.includes("/claims/records/") && to.endsWith(".json")) {
        const record = JSON.parse(read(from, "utf8"));
        if (record.owner.wrapper.pid === process.pid && record.owner.pi) {
          if (stage === "registering") pause(record.owner.pi.pid);
          const result = Reflect.apply(rename, fs, [from, to]);
          pause(record.owner.pi.pid);
          return result;
        }
      }
      return Reflect.apply(rename, fs, [from, to]);
    };
  }
  syncBuiltinESMExports();
} else if (root && stage === "executing" && process.argv[1]?.endsWith("/bundle/cli.js")) {
  fs.writeFileSync(path.join(root, "startup-checkpoint.json"), JSON.stringify({ owner: identity(process.ppid), child: identity(process.pid), stage }), { mode: 0o600 });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
}
