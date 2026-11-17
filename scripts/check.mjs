// Type-check every workspace (in package.json order), the root tests and the install contracts.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
for (const [command, args] of [
  ["npm", ["run", "check", "--workspaces"]],
  ["npm", ["exec", "--", "tsc", "--noEmit", "-p", "tsconfig.json"]],
  [process.execPath, ["--test", "test/install/contracts.test.ts"]],
]) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
