import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

/** Paths are rooted in this test tree, never a sibling development checkout. */
export const toolsExtension = fileURLToPath(new URL("../../packages/extensions/dist/extensions/tools.js", import.meta.url));
export const switchExtension = fileURLToPath(new URL("../../packages/orchestration/dist/extensions/switch.js", import.meta.url));
export const finishExtension = fileURLToPath(new URL("../../packages/extensions/dist/extensions/herdr-finish.js", import.meta.url));
export const lifecycleFixture = fileURLToPath(new URL("../../packages/orchestration/test/lifecycle-fixture.ts", import.meta.url));
export const switchNativeFixture = fileURLToPath(new URL("../../packages/orchestration/test/switch-native-fixture.ts", import.meta.url));
export const emacsHostFixture = fileURLToPath(new URL("../../packages/orchestration/test/emacs-host.el", import.meta.url));
export const deckDirectory = fileURLToPath(new URL("../../emacs/pi-deck/", import.meta.url));

/** Native lanes must select acquired test inputs, not borrow user caches. */
export function requiredTestPath(variable: string): string {
  const value = process.env[variable];
  if (!value || !isAbsolute(value)) throw new Error(`${variable} must name an absolute, isolated test input path`);
  return value;
}
