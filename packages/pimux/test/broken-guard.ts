import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Test-owned Pi only: required safety initialization must fail readiness. */
export default function brokenGuard(_pi: ExtensionAPI): void {
  process.env.PHIMACS_MANAGED_CLAIM = "invalid JSON";
}
