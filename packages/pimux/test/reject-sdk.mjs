// Fail at the native import boundary if a supposedly SDK-free path loads Pi.
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    const result = next(specifier, context);
    if (result.url.includes("/@earendil-works/pi-coding-agent/")) {
      throw new Error(`Unexpected Pi SDK import from ${context.parentURL}`);
    }
    return result;
  },
});
