/** Launch-only entry: loading the public Pi parser belongs on this path. */
import { main } from "./main.ts";

await main(process.argv.slice(2));
