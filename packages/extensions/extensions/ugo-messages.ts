// Ugo prompts, session messages and status UI derived from the loop state.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  formatGuidanceResult,
  type PresentGuidanceParams,
} from "./guidance-core.ts";
import {
  hasReplacementMessageMethods,
  MESSAGE_CUSTOM_TYPE,
  type ReplacementSessionContext,
  type UgoState,
} from "./ugo-state.ts";
import type { DecisionSignal } from "./ugo-workspace.ts";

export const UGO_RETROSPECTIVE_PROMPT = [
  "The main result is saved and tools are unavailable. Return exactly two bullet lines:",
  "- Retrospective: any wrong direction, missed material choice, misplaced authority/state, or process issue; otherwise none.",
  "- Simplify: concrete removal, merge, rename, or stale cleanup supported by the work; otherwise none.",
].join("\n");

export function appendUgoReflection(result: string, reflection: string): string {
  return [result.trimEnd(), "", "---", "", "Reflection:", reflection.trim()].join("\n");
}

export function guidePrompt(state: UgoState): string {
  const previousGuidance = state.previousGuidance
    ? `\n\nPrevious guidance result for context:\n${formatGuidanceResult(state.previousGuidance)}`
    : "";
  const previousReflection = state.previousReflection
    ? [
        "",
        "The previous ugo-do reflection was this:",
        state.previousReflection,
        "",
        "Promote relevant cleanup or follow-up according to workflow.md (needs-distill for durable cleanup, ready for executable simplification); otherwise ignore it.",
      ].join("\n")
    : "";
  return `Inspect workboard.md, follow workflow.md, choose the next workflow outcome, and call present_guidance with the result.${previousGuidance}${previousReflection}`;
}

export function workboardUpdatePrompt(update: string): string {
  return [
    "Apply this workboard.md update only.",
    "Do not change source code, authority docs, or workflow.md.",
    "Edit workboard.md so it reflects the requested state change.",
    "If workboard.md does not exist, report that and stop.",
    "Before finishing, say exactly what changed in workboard.md.",
    "",
    "Requested update:",
    update,
  ].join("\n");
}

export function decisionSignalPrompt(
  signal: DecisionSignal,
  guidance: PresentGuidanceParams | undefined,
): string {
  const target = guidance
    ? `Guidance item: ${guidance.item}\nGuidance reason: ${guidance.reason}`
    : "Guidance item: infer the matching needs-decision item from workboard.md and the signal file.";

  const action =
    signal.kind === "DONE"
      ? [
          "The human resolved the decision. Update workboard.md so the matching item is runnable.",
          "Move the item from needs-decision to ready unless the DONE text explicitly names a different runnable section.",
          "Include the chosen decision in the moved item so the next worker does not need to reopen the decision thread.",
        ]
      : [
          "The human requested clarification. Update workboard.md so the matching item moves to needs-enrichment.",
          "Include the CLARIFY request as the next enrichment question/context target.",
          "Do not make a protocol or design choice on the human's behalf.",
        ];

  return [
    "Apply this human decision signal only.",
    "Do not change source code, authority docs, or workflow.md.",
    "Read workboard.md and the signal file, then update workboard.md to reflect the signal.",
    "Keep the decision artifact if it is useful, but remove or mark the DONE/CLARIFY sentinel as consumed so it does not trigger again.",
    "Before finishing, say exactly which files changed.",
    "",
    target,
    "",
    `Signal file: ${signal.path}`,
    `Signal: ${signal.line}`,
    "",
    ...action,
    "",
    "Signal file content:",
    signal.content,
  ].join("\n");
}

function formatGuidanceSummary(
  guidance: PresentGuidanceParams,
  prompt: string | undefined,
  displayUgoLabels = false,
): string {
  const lines = [
    `${displayUgoLabels ? "ugo-guide result" : "Guidance result"}: ${guidance.status}`,
    `Item: ${guidance.item}`,
    `Reason: ${guidance.reason}`,
  ];
  if (guidance.artifact) lines.push(`Artifact: ${guidance.artifact}`);
  if (guidance.notes) lines.push(`Notes: ${guidance.notes}`);
  if (prompt) lines.push("", displayUgoLabels ? "ugo-do prompt:" : "Worker prompt:", prompt);
  if (guidance.choices && guidance.choices.length > 0) {
    lines.push("", "Choices:");
    for (const choice of guidance.choices) {
      lines.push(
        `- ${choice.recommended ? "[recommended] " : ""}${choice.label}${choice.description ? ` — ${choice.description}` : ""}`,
      );
    }
  }
  return lines.join("\n");
}

export function formatSessionMessage(state: UgoState): string {
  if (state.phase === "guide")
    return "Select the next runnable workboard.md item and present the guidance result.";
  if (state.phase === "do" && state.previousGuidance)
    return formatGuidanceSummary(state.previousGuidance, state.doPrompt);
  if (state.phase === "do_retrospective")
    return "Collecting the no-tools reflection for the completed ugo-do result.";
  return `Workboard state: ${state.phase}${state.reason ? ` — ${state.reason}` : ""}.`;
}

export function formatDisplaySessionMessage(state: UgoState): string {
  const pause = state.pauseRequested ? " (pause requested)" : "";
  if (state.phase === "guide")
    return `ugo-guide phase #${state.iteration}${pause}.`;
  if (state.phase === "do" && state.previousGuidance)
    return `${formatGuidanceSummary(state.previousGuidance, state.doPrompt, true)}${pause}`;
  if (state.phase === "do_retrospective")
    return `ugo-do reflection phase #${state.iteration}${pause}.`;
  return `${stateActor(state)} ${state.phase}${pause}${state.reason ? ` — ${state.reason}` : ""}.`;
}

export async function recordState(
  ctx: ExtensionContext | ReplacementSessionContext,
  state: UgoState,
): Promise<void> {
  if (!hasReplacementMessageMethods(ctx)) return;
  await ctx.sendMessage({
    customType: MESSAGE_CUSTOM_TYPE,
    content: formatSessionMessage(state),
    display: true,
    details: { state },
  });
}

function promptPreview(prompt: string): string {
  return `${prompt.slice(0, 120)}${prompt.length > 120 ? "…" : ""}`;
}

export function phaseActor(phase: "guide" | "do"): "ugo-guide" | "ugo-do" {
  return phase === "guide" ? "ugo-guide" : "ugo-do";
}

export function stateActor(state: UgoState): string {
  if (state.phase === "guide" || state.phase === "do")
    return phaseActor(state.phase);
  if (state.phase === "do_retrospective") return "ugo-do";
  if (state.phase === "awaiting_decision" || state.phase === "empty")
    return "ugo-guide";
  return "ugo";
}

export function updateUi(ctx: ExtensionContext, state: UgoState | undefined): void {
  if (!state?.active) {
    ctx.ui.setStatus("ugo", undefined);
    ctx.ui.setWidget("ugo", undefined);
    return;
  }

  const actor = stateActor(state);
  ctx.ui.setStatus(
    "ugo",
    ctx.ui.theme.fg("accent", `${actor}:${state.phase}#${state.iteration}`),
  );

  const widget = [
    `${actor}: ${state.phase} phase #${state.iteration}${state.pauseRequested ? " (pause requested)" : ""}`,
  ];
  if (state.phase === "guide") {
    if (state.previousGuidance)
      widget.push(
        `previous ugo-guide result: ${state.previousGuidance.status} — ${state.previousGuidance.item}`,
      );
    widget.push("current: choosing next workboard step");
  } else if (state.phase === "do") {
    if (state.previousGuidance)
      widget.push(
        `ugo-guide result: ${state.previousGuidance.status} — ${state.previousGuidance.item}`,
      );
    if (state.doPrompt) {
      widget.push(`current ugo-do prompt: ${promptPreview(state.doPrompt)}`);
    }
  } else if (state.phase === "do_retrospective") {
    if (state.previousGuidance)
      widget.push(
        `ugo-guide result: ${state.previousGuidance.status} — ${state.previousGuidance.item}`,
      );
    widget.push("current: collecting ugo-do reflection");
  } else {
    if (state.lastGuidance)
      widget.push(
        `ugo-guide result: ${state.lastGuidance.status} — ${state.lastGuidance.item}`,
      );
    if (state.doPrompt)
      widget.push(`ugo-do prompt: ${promptPreview(state.doPrompt)}`);
  }
  if (state.reason) widget.push(`reason: ${state.reason}`);
  ctx.ui.setWidget("ugo", widget);
}
