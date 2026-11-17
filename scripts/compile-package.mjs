// Compile the workspace package in the current directory and replace its dist/
// only after a complete, successful build.
//
//   node ../../scripts/compile-package.mjs [--copy FILE]... [--executable FILE]...
//
// --copy copies a package file to the same relative path in the new dist/;
// --executable marks a file of the new dist/ executable. A checkout can serve
// running agents, so dist/ is never deleted first or written in place: the build
// goes to a sibling staging directory, which replaces dist/ by two renames. A
// failed or interrupted build leaves the previous dist/ untouched.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  copy: { type: "string", multiple: true, default: [] },
  executable: { type: "string", multiple: true, default: [] },
} });
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
let child;
let interrupted;
const forward = signal => { interrupted ??= signal; child?.kill(signal); };
for (const signal of signals) process.on(signal, forward);
// A dot-prefixed sibling stays on dist/'s filesystem and out of source globs.
const staging = fs.mkdtempSync(".dist-");
const previous = `${staging}-previous`;

function build() {
  child = spawn(process.execPath, [tsc, "-p", "tsconfig.emit.json", "--outDir", staging], { stdio: "inherit" });
  if (interrupted) child.kill(interrupted);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (interrupted || signal) reject(new Error(`Compilation interrupted by ${interrupted ?? signal}; dist/ was left unchanged`));
      else resolve(code ?? 1);
    });
  });
}

function install() {
  for (const file of values.copy) {
    const destination = path.join(staging, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(file, destination);
  }
  for (const file of values.executable) {
    const target = path.join(staging, file);
    fs.chmodSync(target, fs.statSync(target).mode | 0o111);
  }
  let moved = false;
  try {
    fs.renameSync("dist", previous);
    moved = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    fs.renameSync(staging, "dist");
  } catch (error) {
    if (moved) {
      try { fs.renameSync(previous, "dist"); }
      catch (restore) { throw new AggregateError([error, restore], `Could not install the new dist/, and the previous one stays at ${previous}`); }
    }
    throw error;
  }
  fs.rmSync(previous, { recursive: true, force: true });
}

try {
  const code = await build();
  if (code === 0) install();
  else process.exitCode = code;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
  for (const signal of signals) process.off(signal, forward);
}
