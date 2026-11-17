// Ugo: the automatic guide/do workboard loop over fresh sessions.
import { access } from "node:fs/promises";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  formatGuidanceResult,
  PRESENT_GUIDANCE_PARAMS,
  type PresentGuidanceParams,
  validateGuidance,
} from "./guidance-core.ts";
import {
  appendUgoReflection,
  decisionSignalPrompt,
  formatDisplaySessionMessage,
  formatSessionMessage,
  guidePrompt,
  phaseActor,
  recordState,
  stateActor,
  UGO_RETROSPECTIVE_PROMPT,
  updateUi,
  workboardUpdatePrompt,
} from "./ugo-messages.ts";
import {
  appendUgoMessage,
  getLatestGuidance,
  getLatestState,
  hasReplacementMessageMethods,
  lastAssistantTextFromContext,
  lastUserTextFromContext,
  latestAssistantMessage,
  persistState,
  PRESENT_GUIDANCE_TOOL,
  type ReplacementSessionContext,
  RESULT_CUSTOM_TYPE,
  STATE_CUSTOM_TYPE,
  type UgoState,
  uniqueTools,
  withoutPresentGuidance,
} from "./ugo-state.ts";
import { createUgoWatch } from "./ugo-watch.ts";
import {
  commitIfNeeded,
  type DecisionSignal,
  gitStatus,
  hasWorkboard,
  statusOnlyTouchesWorkflowState,
  statusTouchesDecisionArtifacts,
} from "./ugo-workspace.ts";
import {
  ensureAndReadWorkflowFile,
  ensureWorkflowFile,
  formatGuidancePromptSection,
  WORKFLOW_FILE,
} from "./workflow-core.ts";

export default function (pi: ExtensionAPI) {
  let currentState: UgoState | undefined;
  let presentGuidanceRegistered = false;
  const workboardWatch = createUgoWatch({
    latestState: (ctx, fallback) => getLatestState(ctx) ?? currentState ?? fallback,
    decisionSignal: (ctx, state, signal) => runDecisionSignalSession(ctx, state, signal),
    workboardChanged: (ctx, state) =>
      runGuideSession(ctx, {
        ...state,
        phase: "guide",
        doPrompt: undefined,
        doCompleted: true,
      }),
  });

  function registerPresentGuidanceTool(): void {
    if (presentGuidanceRegistered) return;
    presentGuidanceRegistered = true;
    pi.registerTool({
      name: PRESENT_GUIDANCE_TOOL,
      label: "Present Guidance",
      // The terminating final answer of a model turn.
      exposure: "model-only",
      description:
        "Submit the final workboard guidance decision. Valid input is stored and returned as an exact <pi-guidance-result> block; invalid input throws. Use once as the final guidance action.",
      parameters: PRESENT_GUIDANCE_PARAMS,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const errors = validateGuidance(params);
        if (errors.length > 0) {
          throw new Error(
            `Invalid guidance output:\n${errors.map((error) => `- ${error}`).join("\n")}`,
          );
        }

        pi.appendEntry(RESULT_CUSTOM_TYPE, params);
        if (currentState) {
          currentState = { ...currentState, lastGuidance: params };
          pi.appendEntry(STATE_CUSTOM_TYPE, currentState);
          updateUi(ctx, currentState);
        }

        return {
          content: [{ type: "text", text: formatGuidanceResult(params) }],
          details: params,
          terminate: true,
        };
      },
    });
  }

  function activateToolsForState(state: UgoState | undefined): void {
    if (state?.active && state.phase === "guide") {
      registerPresentGuidanceTool();
      pi.setActiveTools(
        uniqueTools([
          ...withoutPresentGuidance(state.originalTools),
          PRESENT_GUIDANCE_TOOL,
        ]),
      );
      return;
    }

    if (state?.active && state.phase === "do_retrospective") {
      pi.setActiveTools([]);
      return;
    }

    const active = pi.getActiveTools();
    const restored =
      state?.originalTools && state.originalTools.length > 0
        ? state.originalTools
        : active;
    pi.setActiveTools(withoutPresentGuidance(restored));
  }

  function appendCurrentState(state: UgoState): void {
    currentState = state;
    pi.appendEntry(STATE_CUSTOM_TYPE, state);
  }

  async function persistCurrentState(
    ctx: ExtensionContext | ReplacementSessionContext,
    state: UgoState,
  ): Promise<void> {
    currentState = state;
    if (hasReplacementMessageMethods(ctx)) {
      await recordState(ctx, state);
      return;
    }
    pi.appendEntry(STATE_CUSTOM_TYPE, state);
  }

  async function commitStepOrPause(
    ctx: ExtensionContext | ReplacementSessionContext,
    params: {
      phase: "guide" | "do";
      prompt: string;
      response: string;
      state: UgoState;
      guidance?: PresentGuidanceParams;
    },
  ): Promise<boolean> {
    try {
      const committed = await commitIfNeeded({
        cwd: ctx.cwd,
        sessionFile: ctx.sessionManager.getSessionFile(),
        ...params,
      });
      if (committed)
        ctx.ui.notify(`${phaseActor(params.phase)} committed.`, "info");
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const pausedState: UgoState = {
        ...params.state,
        phase: "paused",
        reason: `git commit failed after ${params.phase === "guide" ? "guidance" : "worker"} step: ${message}`,
      };
      await persistCurrentState(ctx, pausedState);
      updateUi(ctx, pausedState);
      ctx.ui.notify(
        `ugo paused: git commit failed after ${phaseActor(params.phase)}. ${message}`,
        "error",
      );
      return false;
    }
  }

  function hasSessionControl(
    ctx: ExtensionContext | ReplacementSessionContext,
  ): ctx is ExtensionCommandContext | ReplacementSessionContext {
    return "newSession" in ctx;
  }

  function makeDoRetrospectiveState(
    state: UgoState,
    prompt: string,
    response: string,
  ): UgoState {
    return {
      ...state,
      active: true,
      phase: "do_retrospective",
      doPrompt: prompt,
      doMainResponse: response,
      doCompleted: false,
      reason: "collecting ugo-do reflection",
    };
  }

  async function prepareDoRetrospective(
    ctx: ExtensionContext | ReplacementSessionContext,
    state: UgoState,
    prompt: string,
    response: string,
  ): Promise<UgoState> {
    const retrospectiveState = makeDoRetrospectiveState(state, prompt, response);
    await persistCurrentState(ctx, retrospectiveState);
    updateUi(ctx, retrospectiveState);
    pi.setActiveTools([]);
    return retrospectiveState;
  }

  async function queueDoRetrospective(
    ctx: ExtensionContext | ReplacementSessionContext,
    state: UgoState,
    prompt: string,
    response: string,
  ): Promise<void> {
    await prepareDoRetrospective(ctx, state, prompt, response);
    pi.sendUserMessage(UGO_RETROSPECTIVE_PROMPT, { deliverAs: "followUp" });
  }

  async function continueAfterCompletedDoIfNeeded(
    ctx: ExtensionCommandContext | ReplacementSessionContext,
  ): Promise<void> {
    const latestState = getLatestState(ctx);
    if (!latestState?.active) {
      if (latestState) updateUi(ctx, latestState);
      return;
    }
    if (
      latestState.phase === "do" &&
      latestState.doCompleted === true &&
      latestState.pauseRequested !== true
    ) {
      await runGuideSession(ctx, {
        ...latestState,
        phase: "guide",
        doPrompt: undefined,
        doCompleted: true,
        doMainResponse: undefined,
        pauseRequested: undefined,
      });
    }
  }

  async function finishDoRetrospective(
    ctx: ExtensionContext | ReplacementSessionContext,
    state: UgoState,
  ): Promise<void> {
    const reflection =
      lastAssistantTextFromContext(ctx) ||
      "reflection unavailable: assistant returned no reflection text.";
    const completedState: UgoState = {
      ...state,
      phase: "do",
      doCompleted: true,
      doMainResponse: undefined,
      previousReflection: reflection,
      reason: undefined,
    };
    activateToolsForState(completedState);
    const committed = await commitStepOrPause(ctx, {
      phase: "do",
      prompt: state.doPrompt ?? "",
      response: appendUgoReflection(state.doMainResponse ?? "", reflection),
      state: completedState,
      guidance: state.previousGuidance,
    });
    if (!committed) return;

    if (completedState.pauseRequested) {
      const pausedState: UgoState = {
        ...completedState,
        phase: "paused",
        doPrompt: undefined,
        doMainResponse: undefined,
        pauseRequested: undefined,
        reason: "paused by user after ugo-do",
      };
      await persistCurrentState(ctx, pausedState);
      updateUi(ctx, pausedState);
      ctx.ui.notify("ugo paused after completing ugo-do.", "info");
      return;
    }

    if (hasSessionControl(ctx)) {
      await runGuideSession(ctx, {
        ...completedState,
        phase: "guide",
        doPrompt: undefined,
        doCompleted: true,
        doMainResponse: undefined,
      });
      return;
    }
    appendCurrentState(completedState);
    updateUi(ctx, completedState);
  }

  async function runDecisionSignalSession(
    ctx: ExtensionCommandContext | ReplacementSessionContext,
    state: UgoState,
    signal: DecisionSignal,
  ): Promise<void> {
    workboardWatch.close();
    const prompt = decisionSignalPrompt(signal, state.lastGuidance);
    const doState: UgoState = {
      ...state,
      phase: "do",
      previousGuidance: state.lastGuidance,
      doPrompt: prompt,
      doCompleted: false,
      pauseRequested: undefined,
      reason: `human ${signal.kind} signal in ${signal.path}`,
    };
    const parentSession = ctx.sessionManager.getSessionFile();
    const result = await ctx.newSession({
      parentSession,
      setup: async (sessionManager) => {
        persistState(sessionManager, doState);
        appendUgoMessage(sessionManager, formatSessionMessage(doState), {
          state: doState,
        });
      },
      withSession: async (signalCtx) => {
        updateUi(signalCtx, doState);
        await signalCtx.sendUserMessage(prompt);
        await continueAfterCompletedDoIfNeeded(signalCtx);
      },
    });

    if (result.cancelled)
      ctx.ui.notify("ugo-do decision signal session was cancelled.", "warning");
  }

  async function startDoSession(
    ctx: ExtensionCommandContext | ReplacementSessionContext,
    state: UgoState,
  ): Promise<void> {
    workboardWatch.close();
    const parentSession = ctx.sessionManager.getSessionFile();
    const result = await ctx.newSession({
      parentSession,
      setup: async (sessionManager) => {
        persistState(sessionManager, state);
        appendUgoMessage(sessionManager, formatSessionMessage(state), {
          state,
        });
      },
      withSession: async (doCtx) => {
        updateUi(doCtx, state);
        if (!state.doPrompt) {
          doCtx.ui.notify("ugo-do has no prompt.", "error");
          return;
        }

        await doCtx.sendUserMessage(state.doPrompt);
        await continueAfterCompletedDoIfNeeded(doCtx);
      },
    });

    if (result.cancelled)
      ctx.ui.notify("ugo-do session was cancelled.", "warning");
  }

  async function continueAfterGuidance(
    ctx: ExtensionCommandContext | ReplacementSessionContext,
    state: UgoState,
    guidance: PresentGuidanceParams,
  ): Promise<void> {
    const consumedReflectionState: UgoState = {
      ...state,
      previousReflection: undefined,
    };

    if (guidance.status === "REQUIRE_HUMAN_DECISION") {
      const decisionState: UgoState = {
        ...consumedReflectionState,
        active: true,
        phase: "awaiting_decision",
        lastGuidance: guidance,
        reason: guidance.reason,
      };
      await persistCurrentState(ctx, decisionState);
      updateUi(ctx, decisionState);
      ctx.ui.notify(
        `ugo-guide awaiting human decision: ${guidance.reason}`,
        "warning",
      );
      await workboardWatch.watchDecisions(ctx, decisionState);
      return;
    }

    if (guidance.status === "EMPTY_WORKBOARD") {
      const emptyState: UgoState = {
        ...consumedReflectionState,
        active: true,
        phase: "empty",
        lastGuidance: guidance,
        reason: guidance.reason,
      };
      await persistCurrentState(ctx, emptyState);
      updateUi(ctx, emptyState);
      ctx.ui.notify(`ugo-guide empty workboard: ${guidance.reason}`, "info");
      await workboardWatch.watchEmptyWorkboard(ctx, emptyState);
      return;
    }

    const doPrompt =
      guidance.status === "UPDATE_WORK"
        ? workboardUpdatePrompt(guidance.workboardUpdate ?? "")
        : guidance.nextPrompt;

    if (!doPrompt?.trim()) {
      const pausedState: UgoState = {
        ...consumedReflectionState,
        active: true,
        phase: "paused",
        lastGuidance: guidance,
        reason: "guidance did not include an executable worker prompt",
      };
      await persistCurrentState(ctx, pausedState);
      updateUi(ctx, pausedState);
      ctx.ui.notify(
        "ugo-guide paused: guidance did not include a ugo-do prompt.",
        "warning",
      );
      return;
    }

    const doState: UgoState = {
      ...consumedReflectionState,
      phase: "do",
      previousGuidance: guidance,
      lastGuidance: guidance,
      doPrompt,
      doCompleted: false,
      reason: undefined,
    };
    await startDoSession(ctx, doState);
  }

  async function runGuideSession(
    ctx: ExtensionCommandContext | ReplacementSessionContext,
    state: UgoState,
  ): Promise<void> {
    workboardWatch.close();

    const guideState: UgoState = {
      ...state,
      active: true,
      phase: "guide",
      iteration: state.iteration + 1,
      doPrompt: undefined,
      lastGuidance: undefined,
      pauseRequested: undefined,
      reason: undefined,
    };
    const parentSession = ctx.sessionManager.getSessionFile();
    const result = await ctx.newSession({
      parentSession,
      setup: async (sessionManager) => {
        persistState(sessionManager, guideState);
        appendUgoMessage(sessionManager, formatSessionMessage(guideState), {
          state: guideState,
        });
      },
      withSession: async (guideCtx) => {
        updateUi(guideCtx, guideState);
        const prompt = guidePrompt(guideState);
        await guideCtx.sendUserMessage(prompt);
        const guidance = getLatestGuidance(guideCtx);
        if (!guidance) {
          const pausedState: UgoState = {
            ...guideState,
            phase: "paused",
            reason: "present_guidance was not called",
          };
          await persistCurrentState(guideCtx, pausedState);
          updateUi(guideCtx, pausedState);
          guideCtx.ui.notify(
            "ugo-guide paused: present_guidance was not called.",
            "warning",
          );
          return;
        }
        const guideResultState = { ...guideState, lastGuidance: guidance };
        if (guidance.status === "REQUIRE_HUMAN_DECISION") {
          try {
            if (!guidance.artifact?.trim()) throw new Error("missing artifact");
            await access(join(guideCtx.cwd, guidance.artifact));
          } catch {
            const pausedState: UgoState = {
              ...guideResultState,
              phase: "paused",
              reason:
                "REQUIRE_HUMAN_DECISION did not create its scratch/decisions artifact",
            };
            await persistCurrentState(guideCtx, pausedState);
            updateUi(guideCtx, pausedState);
            guideCtx.ui.notify(
              "ugo-guide paused: REQUIRE_HUMAN_DECISION must create its scratch/decisions artifact.",
              "error",
            );
            return;
          }
        }
        if (
          guidance.status !== "REQUIRE_HUMAN_DECISION" &&
          statusTouchesDecisionArtifacts(await gitStatus(guideCtx.cwd))
        ) {
          const pausedState: UgoState = {
            ...guideResultState,
            phase: "paused",
            reason:
              "guidance wrote scratch/decisions artifacts without REQUIRE_HUMAN_DECISION",
          };
          await persistCurrentState(guideCtx, pausedState);
          updateUi(guideCtx, pausedState);
          guideCtx.ui.notify(
            "ugo-guide paused: scratch/decisions artifacts are only allowed for REQUIRE_HUMAN_DECISION.",
            "error",
          );
          return;
        }
        const committed = await commitStepOrPause(guideCtx, {
          phase: "guide",
          prompt,
          response: formatGuidanceResult(guidance),
          state: guideResultState,
          guidance,
        });
        if (!committed) return;
        const latestAfterGuide = getLatestState(guideCtx) ?? guideResultState;
        if (latestAfterGuide.pauseRequested) {
          const pausedState: UgoState = {
            ...guideResultState,
            phase: "paused",
            pauseRequested: undefined,
            reason: "paused by user after ugo-guide",
          };
          await persistCurrentState(guideCtx, pausedState);
          updateUi(guideCtx, pausedState);
          guideCtx.ui.notify("ugo paused after completing ugo-guide.", "info");
          return;
        }
        await continueAfterGuidance(guideCtx, guideState, guidance);
      },
    });

    if (result.cancelled)
      ctx.ui.notify("ugo-guide session was cancelled.", "warning");
  }

  async function ensureUgoCanRun(
    ctx: ExtensionCommandContext | ReplacementSessionContext,
  ): Promise<boolean> {
    let status: string;
    try {
      status = await gitStatus(ctx.cwd);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`ugo requires a git repository: ${message}`, "error");
      return false;
    }
    if (!statusOnlyTouchesWorkflowState(status)) {
      ctx.ui.notify(
        "ugo requires a clean worktree before starting except for workboard.md, workflow.md, and scratch/ changes because ugo-guide/ugo-do commit after each phase.",
        "error",
      );
      return false;
    }
    try {
      if (await ensureWorkflowFile(ctx.cwd)) {
        ctx.ui.notify(
          `Created ${WORKFLOW_FILE}. Edit it to customize ugo guidance.`,
          "info",
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(
        `ugo could not create ${WORKFLOW_FILE}: ${message}`,
        "error",
      );
      return false;
    }
    status = await gitStatus(ctx.cwd);
    if (!statusOnlyTouchesWorkflowState(status)) {
      ctx.ui.notify(
        "ugo requires a clean worktree before starting except for workboard.md, workflow.md, and scratch/ changes because ugo-guide/ugo-do commit after each phase.",
        "error",
      );
      return false;
    }
    if (!(await hasWorkboard(ctx.cwd))) {
      ctx.ui.notify(
        "ugo-guide needs workboard.md. Run /new-workboard first or create workboard.md.",
        "warning",
      );
      return false;
    }
    return true;
  }

  pi.registerCommand("ugo", {
    description: "Start or resume the ugo automatic workboard loop",
    handler: async (args, ctx) => {
      if (args.trim().length > 0) {
        ctx.ui.notify("Usage: /ugo", "warning");
        return;
      }
      await ctx.waitForIdle();
      if (!(await ensureUgoCanRun(ctx))) return;

      const state = getLatestState(ctx) ?? currentState;
      if (state?.active) {
        if (
          state.phase === "guide" ||
          state.phase === "do_retrospective" ||
          (state.phase === "do" && state.doCompleted !== true)
        ) {
          ctx.ui.notify(
            `ugo is already running: ${formatDisplaySessionMessage(state)}`,
            "info",
          );
          return;
        }

        ctx.ui.notify("Resuming ugo.", "info");
        await runGuideSession(ctx, {
          ...state,
          phase: "guide",
          doPrompt: undefined,
          doCompleted: true,
          doMainResponse: undefined,
          pauseRequested: undefined,
          reason: undefined,
        });
        return;
      }

      const initialState: UgoState = {
        active: true,
        phase: "guide",
        iteration: 0,
        originalTools: withoutPresentGuidance(pi.getActiveTools()),
      };
      ctx.ui.notify("Starting ugo.", "info");
      await runGuideSession(ctx, initialState);
    },
  });

  pi.registerCommand("ugo-pause", {
    description: "Pause ugo after the current safe checkpoint",
    handler: async (args, ctx) => {
      if (args.trim().length > 0) {
        ctx.ui.notify("Usage: /ugo-pause", "warning");
        return;
      }
      const state = getLatestState(ctx) ?? currentState;
      if (!state?.active) {
        ctx.ui.notify("No active ugo session to pause.", "info");
        return;
      }
      workboardWatch.close();

      if (state.phase === "paused") {
        ctx.ui.notify("ugo is already paused. Run /ugo to resume.", "info");
        return;
      }

      if (
        state.phase === "awaiting_decision" ||
        state.phase === "empty" ||
        (state.phase === "do" && state.doCompleted === true)
      ) {
        const pausedState: UgoState = {
          ...state,
          phase: "paused",
          pauseRequested: undefined,
          reason: "paused by user",
        };
        appendCurrentState(pausedState);
        activateToolsForState(pausedState);
        updateUi(ctx, pausedState);
        ctx.ui.notify("ugo paused. Run /ugo to resume.", "info");
        return;
      }

      const pauseState: UgoState = {
        ...state,
        pauseRequested: true,
        reason: state.reason ?? "pause requested by user",
      };
      appendCurrentState(pauseState);
      updateUi(ctx, pauseState);
      ctx.ui.notify(
        "ugo pause requested. The current agent turn will finish and checkpoint before ugo stops.",
        "info",
      );
    },
  });

  pi.on("session_shutdown", async () => {
    workboardWatch.close();
  });

  pi.on("session_start", async (_event, ctx) => {
    currentState = getLatestState(ctx);
    if (
      !currentState?.active ||
      (currentState.phase !== "awaiting_decision" &&
        currentState.phase !== "empty")
    )
      workboardWatch.close();
    activateToolsForState(currentState);
    if (currentState?.active)
      pi.setSessionName(
        `${stateActor(currentState)} ${currentState.phase} #${currentState.iteration}`,
      );
    updateUi(ctx, currentState);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (currentState?.active && currentState.phase === "guide") {
      try {
        const workflow = await ensureAndReadWorkflowFile(ctx.cwd);
        if (workflow.created) {
          ctx.ui.notify(
            `Created ${WORKFLOW_FILE}. Edit it to customize ugo guidance.`,
            "info",
          );
        }
        event.systemPromptOptions.sections.guidance = formatGuidancePromptSection(workflow.content);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(
          `ugo-guide could not load ${WORKFLOW_FILE}: ${message}`,
          "error",
        );
      }
    }
    if (currentState?.active && currentState.phase === "do_retrospective") {
      event.systemPromptOptions.sections.ugo_retrospective = "Answer only the ugo-do reflection prompt; tools are disabled.";
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    const state = getLatestState(ctx) ?? currentState;
    if (!state?.active) return;
    const message = latestAssistantMessage(event.messages);
    if (!message || message.stopReason !== "stop") return;

    if (state.phase === "do_retrospective") {
      await finishDoRetrospective(ctx, state);
      return;
    }

    if (state.phase === "do" && state.doPrompt) {
      await queueDoRetrospective(
        ctx,
        state,
        lastUserTextFromContext(ctx) || state.doPrompt,
        lastAssistantTextFromContext(ctx),
      );
    }
  });
}

