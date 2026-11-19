// View state shared by the app modules: one `app` object for reassigned values, plus shared maps and types.

import type { CompactionRowState } from './compaction-row.js';
import type { LiveSession, ModelRecord, PendingDialog, AppEvent, InteractionState, QueuedCommand, UsageRecord, ExtensionUIRequest } from './app-types.js';
import type { SessionHistoryEntry } from './history-render.js';
import { StateManager } from './state.js';
import type { VoiceInput } from './voice-input.js';
import type { InputContext } from './unsent-input.js';

export const app: {
  expandedAssistantBlocks: boolean;
  statusFlashTimer: ReturnType<typeof setTimeout> | null;
  pendingAssistantError: { errorMessage: string } | null;
  retryStatusElement: HTMLElement | null;
  sessionTotalCost: number;
  lastInputTokens: number;
  contextTokensEstimated: boolean;
  compactionRow: { element: HTMLElement; state: RunningCompaction } | null;
  compactionElapsedTimer: ReturnType<typeof setInterval> | null;
  contextWindowSize: number;
  originalTitle: string;
  hasFocus: boolean;
  unreadCount: number;
  isScrolledUp: boolean;
  hasNewWhileScrolled: boolean;
  lastSentMessage: string | null;
  lastUsage: UsageRecord | null;
  activeLiveSessionFile: string | null;
  viewingActiveSession: boolean;
  hasReceivedInitialServerState: boolean;
  liveSessions: LiveSession[];
  liveSessionsRevision: number;
  connectionRevision: number;
  activeLiveSessionId: string | null;
  voiceInput: VoiceInput | null;
  viewSelection: number;
  resumeQueuedInput: boolean;
  pendingExtensionUIRequests: ExtensionUIRequest[];
  reattachMuxId: string | null;
  sidebarRefreshTimer: ReturnType<typeof setTimeout> | null;
  newLiveSessionModels: Array<ModelRecord | string>;
  messageQueue: QueuedCommand[];
  composerContext: InputContext | null;
} = {
  expandedAssistantBlocks: false,
  // Tracks the pending timer that restores the status indicator (dot) and
  // text after a red-dot error flash. Kept SEPARATE from statusRestoreTimer
  // so a normal setStatusMessage call cannot cancel the only callback that
  // would clear the `error` class — otherwise an unrelated status update
  // during the 3s flash would strand the dot red with no timer to reset it.
  statusFlashTimer: null,
  // A failed reply may still be replaced by Pi's retries before agent_settled.
  pendingAssistantError: null,
  retryStatusElement: null,
  sessionTotalCost: 0,
  lastInputTokens: 0,
  // True while lastInputTokens is Pi's estimate after a compaction. The next
  // reply that reports usage replaces it with a real count.
  contextTokensEstimated: false,
  // The transcript row of the compaction running in the shown view.
  compactionRow: null,
  compactionElapsedTimer: null,
  contextWindowSize: 0, // fetched from model info
  originalTitle: document.title,
  hasFocus: true,
  unreadCount: 0,
  isScrolledUp: false,
  hasNewWhileScrolled: false,
  lastSentMessage: null, // Track to avoid duplicate rendering from backend echo events
  lastUsage: null, // Full usage object for context visualiser
  activeLiveSessionFile: null, // The active live session file path
  viewingActiveSession: false, // Whether this browser shows a live agent view, not a read-only session
  hasReceivedInitialServerState: false,
  liveSessions: [],
  // HTTP lists cannot replace a view list changed by socket events or another read.
  liveSessionsRevision: 0,
  connectionRevision: 0,
  activeLiveSessionId: null,
  voiceInput: null,
  // Every explicit choice, even A -> B -> A, retires the previous view's reads.
  viewSelection: 0,
  // A URL selects a view, not permission to submit that view's queued input.
  resumeQueuedInput: true,
  pendingExtensionUIRequests: [], // background notifications only
  reattachMuxId: null, // The shared agent on screen when Tau went away
  sidebarRefreshTimer: null,
  // Model suggestions use the same list and matching as the status-bar model picker.
  newLiveSessionModels: [],
  messageQueue: [],
  composerContext: null,
};

export type CompactionResult = { summary?: string; tokensBefore?: number; estimatedTokensAfter?: number };
export type RunningCompaction = Extract<CompactionRowState, { status: 'running' }>;

export type LiveSessionSnapshotData = {
  sessionId?: string;
  sessionFile?: string | null;
  leafId?: string | null;
  session?: LiveSession;
  isStreaming?: boolean;
  model?: ModelRecord | null;
  thinkingLevel?: string;
  entries?: SessionHistoryEntry[];
  pendingDialogs?: PendingDialog[];
  interactionRevision?: number;
  /** Attached views: the pimux boundary this snapshot describes, and its open dialogs. */
  generation?: number;
  dialogs?: AppEvent[];
};

export type RpcEventDetail = { sessionId?: string; event?: AppEvent };
export const state = new StateManager();

// State tracking
export const currentMessageSteps = new Map<number, HTMLElement>();
// Views that asked Pi to compact and have not seen it start yet. They count as
// compacting, so a message sent in that gap is queued instead of rejected.
export const compactRequests = new Set<string>();
// Counts compaction_start events per view, so a compact request can tell
// whether Pi began compacting before it failed.
export const compactionStarts = new Map<string, number>();
export const closedLiveSessionIds = new Set<string>();
export const interactionStates = new Map<string, InteractionState>();
// Native Pi dialogs use Tau's revisioned registry. Attached Pi dialogs use
// mux membership instead: only a newer snapshot or dialog_closed removes one.
export const sharedDialogs = new Map<string, Map<string, AppEvent>>();
export const sharedDialogGenerations = new Map<string, number>();
export const operationRevisions = new Map<string, number>();
export const sessionStateRevisions = new Map<string, number>();
export const abortRequests = new Map<string, Promise<void>>();
export const localAbortStates = new Map<string, NonNullable<LiveSession['abortState']>>();
export const settledWhileStopping = new Set<string>();
export type QueuedDispatch = {
  id: string;
  command: QueuedCommand;
  started: boolean;
  accepted: boolean;
  uncertain?: boolean;
  reconcileAfterReconnect?: boolean;
  reconciling?: boolean;
  retryTimer?: ReturnType<typeof setTimeout>;
};
export const queuedPrompts = new Map<string, QueuedDispatch>();
export const DIALOG_METHODS = new Set(['select', 'confirm', 'input', 'editor']);
/** Extension UI for a terminal's chrome; Tau has no place for it, and it asks nothing of the user. */
export const DISPLAY_UI_METHODS = new Set(['setStatus', 'setWidget', 'setTitle', 'set_editor_text']);
export const editorNoticeIds = new Map<string, number>();
export const piQueues = new Map<string, { steering: string[]; followUp: string[] }>(); // Prompts Pi holds, by view
