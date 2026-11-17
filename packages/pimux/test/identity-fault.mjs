import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

// Process-local fault injection only in this test's detached owner, never Pi.
if (process.argv[1]?.endsWith("/owner-entry.js") && process.env.PHIMACS_TEST_ROOT) {
  const original = fs.readFileSync;
  let injected = false;
  fs.readFileSync = function (file, ...args) {
    if (!injected && typeof file === "string" && /^\/proc\/\d+\/stat$/.test(file)) {
      const stat = original(file, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      if (Number(fields[1]) === process.pid) {
        injected = true;
        const pid = Number(file.split("/")[2]);
        fs.writeFileSync(path.join(process.env.PHIMACS_TEST_ROOT, "identity-fault.json"), JSON.stringify({ pid, startTime: fields[19], bootId: original("/proc/sys/kernel/random/boot_id", "utf8").trim() }), { mode: 0o600 });
        throw Object.assign(new Error("Injected child identity read failure"), { code: "EACCES" });
      }
    }
    return Reflect.apply(original, fs, [file, ...args]);
  };
  syncBuiltinESMExports();
}
