// Refresh and select models in the owning Pi through its supported extension APIs.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  isRecord, MODELS_COMMAND, parseModelsAction, type CompanionRecord, type ModelDescriptor, type ModelsAction,
} from "./protocol.ts";

class ControlError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

type Send = (ctx: ExtensionContext, record: CompanionRecord) => void;

/** Install the internal command used only by the managed socket router. */
export function installModelControl(pi: ExtensionAPI, send: Send, timeoutMs = 10_000): void {
  pi.registerCommand(MODELS_COMMAND, {
    description: "Internal pimux model control",
    handler: async (args, ctx) => {
      let requestId = "";
      let changing = false;
      try {
        const envelope: unknown = JSON.parse(args);
        if (!isRecord(envelope) || typeof envelope.requestId !== "string" || !envelope.requestId
          || envelope.requestId.length > 256) throw new ControlError("invalid_request", "Invalid model request identity");
        requestId = envelope.requestId;
        const request = parseModelsAction(envelope.request);
        if (!request) throw new ControlError("invalid_request", "Invalid model request");
        const file = ctx.sessionManager.getSessionFile();
        const session = ctx.sessionManager.getSessionId();
        const leaf = ctx.sessionManager.getLeafId();
        const check = (): void => {
          if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new ControlError("agent_working", "Model changes require an idle agent without queued input");
          if (ctx.sessionManager.getSessionFile() !== file || ctx.sessionManager.getSessionId() !== session
            || ctx.sessionManager.getLeafId() !== leaf) throw new ControlError("stale_context", "The conversation changed during model refresh");
        };
        if (request.action === "set") check();
        await refresh(ctx, request, timeoutMs);
        if (request.action === "list") {
          send(ctx, { kind: "models-result", requestId, success: true, data: { models: ctx.modelRegistry.getAvailable().map(describeModel) } });
          return;
        }
        check();
        const model = ctx.modelRegistry.getAvailable().find((candidate) => candidate.provider === request.provider && candidate.id === request.modelId);
        if (!model) throw new ControlError("model_unavailable", `Model unavailable: ${request.provider}/${request.modelId}`);
        changing = true;
        if (!await pi.setModel(model)) throw new ControlError("model_unavailable", `Authentication unavailable: ${request.provider}/${request.modelId}`);
        if (ctx.model?.provider !== request.provider || ctx.model.id !== request.modelId) {
          throw new ControlError("model_uncertain", "The selected model changed before acknowledgement; inspect current state");
        }
        send(ctx, { kind: "models-result", requestId, success: true, data: { model: describeModel(ctx.model), thinkingLevel: pi.getThinkingLevel() } });
      } catch (error) {
        send(ctx, { kind: "models-result", requestId, success: false, error: {
          code: error instanceof ControlError ? error.code : changing ? "model_uncertain" : "model_control_failed",
          message: error instanceof Error ? error.message : String(error),
        } });
      }
    },
  });
}

function describeModel(model: ModelDescriptor): ModelDescriptor {
  return { provider: model.provider, id: model.id, name: model.name, reasoning: model.reasoning,
    input: model.input, contextWindow: model.contextWindow };
}

async function refresh(ctx: ExtensionContext, request: ModelsAction, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  const signal = AbortSignal.any(ctx.signal ? [ctx.signal, controller.signal] : [controller.signal]);
  const timer = setTimeout(() => controller.abort(new Error("Model refresh timed out")), timeoutMs);
  let abort: (() => void) | undefined;
  try {
    if (signal.aborted) throw new ControlError("model_refresh_aborted", "Model refresh cancelled");
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new ControlError("model_refresh_aborted", controller.signal.aborted ? "Model refresh timed out" : "Model refresh cancelled"));
      signal.addEventListener("abort", abort, { once: true });
    });
    const result = await Promise.race([ctx.modelRegistry.refresh({
      ...request.action === "set" ? { providers: [request.provider] } : {},
      force: request.action === "set" || request.force === true,
      allowNetwork: process.env.PI_OFFLINE === undefined,
      signal,
    }), cancelled]);
    signal.throwIfAborted();
    if (result.aborted) throw new ControlError("model_refresh_aborted", "Model refresh cancelled");
    if (result.errors.size) throw new ControlError("model_refresh_failed", [...result.errors]
      .map(([provider, error]) => `${provider}: ${error.message}`).join("; "));
    const error = ctx.modelRegistry.getError();
    if (error) throw new ControlError("model_refresh_failed", error);
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener("abort", abort);
  }
}
