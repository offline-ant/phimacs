#!/usr/bin/env node
import { readWorkerTask } from "./worker-task.ts";

try {
  const args = process.argv.slice(2);
  const index = args.indexOf("--id");
  if (args.length !== 3 || index < 0 || index === args.length - 1 || args.filter(arg => arg === "--json").length !== 1
    || ![0, 1].includes(index) || args.filter(arg => arg === "--id").length !== 1) {
    throw new Error("Usage: phimacs-task-status --id MUX --json");
  }
  const id = args[index + 1];
  if (id.startsWith("--") || (index === 0 ? args[2] : args[0]) !== "--json") throw new Error("Usage: phimacs-task-status --id MUX --json");
  process.stdout.write(`${JSON.stringify(readWorkerTask(id))}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
