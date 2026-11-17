// Ugo's file watchers that resume a waiting loop after human workboard or decision edits.
import { watch, type FSWatcher } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ReplacementSessionContext, UgoState } from "./ugo-state.ts";
import {
  DECISIONS_DIR,
  type DecisionSignal,
  gitStatus,
  scanDecisionSignals,
  statusOnlyTouchesWorkflowState,
  WORKBOARD_FILE,
} from "./ugo-workspace.ts";

type WatchContext = ExtensionCommandContext | ReplacementSessionContext;

/** Loop actions a watcher triggers; the extension owns sessions and state. */
export interface UgoWatchHandlers {
  latestState(ctx: WatchContext, fallback: UgoState): UgoState;
  decisionSignal(ctx: WatchContext, state: UgoState, signal: DecisionSignal): Promise<void>;
  workboardChanged(ctx: WatchContext, state: UgoState): Promise<void>;
}

/** At most one active watch; starting or closing one invalidates pending scans. */
export interface UgoWatch {
  close(): void;
  watchDecisions(ctx: WatchContext, state: UgoState): Promise<void>;
  watchEmptyWorkboard(ctx: WatchContext, state: UgoState): Promise<void>;
}

/** Create the watcher that waits for DONE:/CLARIFY: signals or new workboard work. */
export function createUgoWatch(handlers: UgoWatchHandlers): UgoWatch {
  let watchers: FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
  let blocked = false;
  let generation = 0;

  function close(): void {
    generation++;
    for (const watcher of watchers) watcher.close();
    watchers = [];
    if (timer) clearTimeout(timer);
    timer = undefined;
    busy = false;
    blocked = false;
  }

  function schedule(
    ctx: WatchContext,
    failure: string,
    scan: (stale: () => boolean) => Promise<void>,
  ): void {
    if (timer) clearTimeout(timer);
    const scheduled = generation;
    const stale = (): boolean => scheduled !== generation;
    timer = setTimeout(() => {
      timer = undefined;
      void (async () => {
        if (stale()) return;
        if (busy) return;
        busy = true;
        try {
          await scan(stale);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          notifyIfContextActive(ctx, `${failure}: ${message}`, "error");
        } finally {
          busy = false;
        }
      })();
    }, 250);
  }

  // Ugo commits after each phase, so it resumes only over workflow-state edits.
  async function onlyWorkflowStateDirty(
    ctx: WatchContext,
    stale: () => boolean,
    dirtyMessage: string,
  ): Promise<boolean> {
    const status = await gitStatus(ctx.cwd);
    if (stale()) return false;
    if (statusOnlyTouchesWorkflowState(status)) return true;
    if (!blocked) {
      blocked = true;
      notifyIfContextActive(ctx, dirtyMessage, "warning");
    }
    return false;
  }

  function scheduleDecisionScan(ctx: WatchContext, state: UgoState): void {
    schedule(ctx, "ugo-guide decision watcher failed", async (stale) => {
      const latestState = handlers.latestState(ctx, state);
      if (!latestState.active || latestState.phase !== "awaiting_decision")
        return;
      const signal = await scanDecisionSignals(ctx.cwd);
      if (stale()) return;
      if (!signal) return;
      if (
        !(await onlyWorkflowStateDirty(
          ctx,
          stale,
          "ugo-guide saw a DONE/CLARIFY signal but files outside workboard.md, workflow.md, or scratch/ are dirty. Clean or commit them, then save the signal file again or run /ugo.",
        ))
      )
        return;
      await handlers.decisionSignal(ctx, latestState, signal);
    });
  }

  function scheduleEmptyWorkboardScan(ctx: WatchContext, state: UgoState): void {
    schedule(ctx, "ugo-guide empty-workboard watcher failed", async (stale) => {
      const latestState = handlers.latestState(ctx, state);
      if (!latestState.active || latestState.phase !== "empty") return;
      if (
        !(await onlyWorkflowStateDirty(
          ctx,
          stale,
          "ugo-guide saw a workboard.md edit but files outside workboard.md, workflow.md, or scratch/ are dirty. Clean or commit them, then save workboard.md again or run /ugo.",
        ))
      )
        return;
      await handlers.workboardChanged(ctx, latestState);
    });
  }

  async function watchDecisions(ctx: WatchContext, state: UgoState): Promise<void> {
    close();
    const cwd = ctx.cwd;
    for (const path of [WORKBOARD_FILE, DECISIONS_DIR]) {
      try {
        await access(join(cwd, path));
        watchers.push(
          watch(join(cwd, path), () => scheduleDecisionScan(ctx, state)),
        );
      } catch {
        // Missing watched paths are fine; guidance may not have produced a decision artifact.
      }
    }
    notifyIfContextActive(
      ctx,
      "ugo-guide is watching workboard.md and scratch/decisions for DONE:/CLARIFY:.",
      "info",
    );
    scheduleDecisionScan(ctx, state);
  }

  async function watchEmptyWorkboard(ctx: WatchContext, state: UgoState): Promise<void> {
    close();
    try {
      await access(join(ctx.cwd, WORKBOARD_FILE));
      watchers.push(
        watch(join(ctx.cwd, WORKBOARD_FILE), () =>
          scheduleEmptyWorkboardScan(ctx, state),
        ),
      );
    } catch {
      // If workboard.md does not exist, /ugo can retry after creation.
    }
    notifyIfContextActive(
      ctx,
      "ugo-guide found an empty workboard and is watching workboard.md for new work.",
      "info",
    );
  }

  return { close, watchDecisions, watchEmptyWorkboard };
}

function notifyIfContextActive(
  ctx: WatchContext,
  message: string,
  level: "info" | "warning" | "error",
): void {
  try {
    ctx.ui.notify(message, level);
  } catch (error) {
    if (!isStaleContextError(error)) throw error;
  }
}

function isStaleContextError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes(
      "This extension ctx is stale after session replacement or reload",
    )
  );
}
