// Compile the workspace package in the current directory into a fresh dist/.
import fs from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
fs.rmSync("dist", { recursive: true, force: true });
const result = spawnSync(process.execPath, [tsc, "-p", "tsconfig.emit.json"], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
