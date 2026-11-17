import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { reserveManagedSession } from "@phimacs/pimux/guard";

/** Native CLI resume check, with no network or paid inference. */
export default function workerResumeFixture(pi: ExtensionAPI): void {
  const provider = fauxProvider({
    provider: "worker-resume-fixture", models: [{ id: "resume" }], tokensPerSecond: 100_000,
  });
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall("read", { path: "resume-proof.txt" }), { stopReason: "toolUse" }),
    (context) => {
      if (!JSON.stringify(context.messages).includes("saved worker progress")) throw new Error("Lost worker history");
      if (!context.messages.some((message) => message.role === "toolResult"
        && !message.isError && JSON.stringify(message.content).includes("correct worker cwd"))) {
        throw new Error("Resume did not restore the worker cwd");
      }
      return fauxAssistantMessage("resumed ordinary session");
    },
  ]);
  pi.registerProvider(provider.provider);
  pi.on("before_agent_start", (_event, ctx) => {
    if (ctx.model?.provider !== provider.provider.id) throw new Error("Resume fixture refuses non-faux inference");
    if (process.env.PI_NESTED !== "0") throw new Error("Resume inherited nesting depth");
    if (process.env.PI_ORCHESTRATION_CONTROL || process.env.PI_ORCHESTRATION_TARGET || process.env.PI_ORCHESTRATION_HOST
      || process.env.PI_ORCHESTRATION_ENDPOINT || process.env.PHIMACS_PARENT_TASK || process.env.PHIMACS_PARENT_TASK_FILE
      || process.env.PIMUX_DISCOVERY) throw new Error("Resume inherited worker or frontend identity");
    const file = ctx.sessionManager.getSessionFile();
    if (!file || !process.env.PHIMACS_MANAGED_CLAIM || process.env.PHIMACS_MANAGED_CLAIM === "obsolete-capability") throw new Error("Resume lacks a new managed writer capability");
    reserveManagedSession(file);
  });
}
