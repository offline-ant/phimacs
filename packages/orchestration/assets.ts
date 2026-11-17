import { fileURLToPath } from "node:url";

/** Runtime assets belong to the installed package, independently of build layout. */
export function orchestrationAsset(relativePath: string): string {
  return fileURLToPath(new URL(relativePath, import.meta.resolve("@phimacs/orchestration/package.json")));
}
