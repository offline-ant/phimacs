import type { HostTarget } from "./host-types.ts";
import { redactEndpoint } from "@phimacs/pimux/endpoint";


/** A target as tool results and other transcript data may carry it. */
export function publicTarget(target: HostTarget): HostTarget {
  return { ...target, endpoint: redactEndpoint(target.endpoint) };
}
