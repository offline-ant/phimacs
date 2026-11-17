/**
 * Emitted synchronously when a run ends. An extension whose failed run must not
 * ask the user sets `claimed`, so generic error handling stays out of its way.
 */
export const ERROR_CLAIM_EVENT = "pi-orchestration:error-claim";

export interface ErrorClaim {
  claimed: boolean;
}

/** Emitted just before an error dialog's answer sends `text` for the user. */
export const ERROR_CONTINUE_EVENT = "pi-orchestration:error-continue";

export interface ErrorContinue {
  text: string;
}
