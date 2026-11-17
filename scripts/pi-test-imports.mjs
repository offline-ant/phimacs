/** Tests resolve the exact declared workspace host, never a developer global. */
import path from "node:path";
import { fileURLToPath } from "node:url";

export const piRoot = path.dirname(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
