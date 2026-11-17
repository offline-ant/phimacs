import { defineTool, truncateHead, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { JsonValue } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { BrowserUnavailable, type BrowserClient, type SharedTab } from "./broker/client.ts";
import type { TabInfo } from "./broker/protocol.ts";
import { capturePage } from "./capture.ts";
import type { BrowserKind } from "./core/types.ts";
import { publicBrowserError } from "./core/process.ts";
import { SnapshotStore, snapshotSummary, type SnapshotInput, type SnapshotFormat } from "./snapshots.ts";
import { remoteSetupInstructions, type BrowserSetupHandler } from "./browser-remote.ts";
import { abortable } from "./web/async.ts";

export interface BrowserToolOptions {
  /** The selected shared browser, resolved per call; owned and closed by the host. */
  browser: () => BrowserClient | Promise<BrowserClient>;
  snapshots?: SnapshotStore;
  onSetup?: BrowserSetupHandler;
}

export interface BrowserResultDetails {
  browser: BrowserKind;
  remote?: string;
  tab: string;
  url: string;
  title: string;
  snapshot: string;
  available: SnapshotFormat[];
  truncated: boolean;
  warnings?: string[];
  eval_result?: unknown;
  eval_preview?: string;
  eval_error?: string;
}

export interface BrowserListDetails { tabs: TabInfo[] }

/** Codemode result: the page receipt with the complete eval result, or the tab list. */
export const browserOutputSchema = Type.Union([
  Type.Object({
    tab: Type.String(),
    new: Type.Boolean({ description: "This call opened the tab" }),
    browser: Type.String(),
    remote: Type.Optional(Type.String()),
    url: Type.String(),
    title: Type.String(),
    snapshot: Type.String({ description: "Snapshot ID for web_read" }),
    available: Type.Array(Type.String()),
    warnings: Type.Array(Type.String()),
    eval_result: Type.Optional(Type.Unknown({ description: "Complete eval result; null for undefined" })),
    eval_error: Type.Optional(Type.String()),
  }),
  Type.Object({
    tabs: Type.Array(Type.Object({
      name: Type.String(), url: Type.String(), title: Type.String(),
      default: Type.Boolean({ description: "This session's default tab" }),
      mine: Type.Boolean({ description: "This session last used the tab" }),
      lastSession: Type.Optional(Type.String({ description: "ID of the session that last used the tab" })), lastUsedAt: Type.Optional(Type.String()),
      openedBy: Type.Union([Type.Literal("broker"), Type.Literal("other")]),
    })),
  }),
]);

/** Remote connection failures may be fixed by a person; retry once after confirmation, never replaying page work. */
async function withSetup<T>(client: BrowserClient, run: () => Promise<T>, signal: AbortSignal | undefined, onSetup?: BrowserSetupHandler): Promise<T> {
  try { return await run(); }
  catch (error) {
    if (!(error instanceof BrowserUnavailable) || !("remote" in client.source)) throw error;
    const instructions = remoteSetupInstructions(error.message);
    const confirmed = onSetup && await abortable(onSetup(instructions, signal ?? new AbortController().signal), signal);
    signal?.throwIfAborted();
    if (!confirmed) throw new Error(`${instructions}\n${onSetup ? "Retry was declined." : "No interactive setup confirmation is available."}`);
    return run();
  }
}

/** One tab per line, tab-separated: name, URL, title, then optional notes. No tabs gives empty text. */
function formatTabs(tabs: TabInfo[]): string {
  return tabs.map(tab => [tab.name, tab.url, tab.title,
    ...(tab.current ? ["default"] : []),
    ...(tab.lastSession ? [`last used by ${tab.mine ? "this session" : tab.lastSession} at ${tab.lastUsedAt}`] : []),
    ...(tab.openedBy === "other" ? ["not opened by Pi; never closed automatically"] : [])].join("\t")).join("\n");
}

/** Named tabs in the one shared browser produce immutable evidence. */
export function createBrowserTool(options: BrowserToolOptions) {
  const snapshots = options.snapshots ?? new SnapshotStore();
  const tool = defineTool({
    name: "browser", label: "Browser",
    description: "Use named tabs of the browser shared by all Pi sessions (selected by the user with /browser) and optionally evaluate JavaScript (async IIFEs; Promises awaited). Every tab has a name, also tabs from web_fetch and other sessions. Omitted tab uses this session's last tab; an unknown tab with url opens a new tab with that name; omitted tab with url and no usable last tab opens an automatically named tab (host without www plus +length of the rest, e.g. google.com+6). Omit url to keep the page. Pi-opened tabs outside every session's 10 most recently used tabs close automatically. list:true lists all tabs, one per line: name, URL, title, then notes such as default and last user, tab-separated. Calls on the same tab run one after another; different tabs run in parallel. Returns the eval result as JSON (or its error) if eval is given, then a short receipt with tab, URL and snapshot ID; web_read reads final md/text/html/json/screenshot or before-screenshot (after navigation, before eval). Inspect HTML first, screenshots for visual evidence. Large eval results live in snapshot JSON. Interrupted eval closes its tab. Ordinary eval errors keep the tab.",
    parameters: Type.Object({
      tab: Type.Optional(Type.String({ description: "Tab name. Omit for this session's last tab." })),
      url: Type.Optional(Type.String({ description: "HTTP(S) URL to navigate to before capture/eval. Omit to keep the current page." })),
      eval: Type.Optional(Type.String({ description: "JavaScript expression evaluated once; returned Promises are awaited." })),
      list: Type.Optional(Type.Boolean({ description: "List all tabs instead of using one." })),
    }, { additionalProperties: false }),
    outputSchema: browserOutputSchema,
    async execute(_id, params, signal): Promise<AgentToolResult<BrowserResultDetails | BrowserListDetails>> {
      signal?.throwIfAborted();
      const client = await options.browser();
      if (params.list) {
        if (params.tab !== undefined || params.url !== undefined || params.eval !== undefined) throw new Error("list cannot be combined with tab, url, or eval.");
        const tabs = await withSetup(client, () => client.list(signal), signal, options.onSetup);
        return { content: [{ type: "text", text: formatTabs(tabs) }], details: { tabs },
          structuredContent: { tabs: tabs.map(({ name, url, title, current, mine, lastSession, lastUsedAt, openedBy }) => ({
            name, url, title, default: current, mine, ...(lastSession ? { lastSession, lastUsedAt } : {}), openedBy })) } };
      }
      if (params.url !== undefined) {
        const url = new URL(params.url);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Browser URL must be HTTP(S) without embedded credentials.");
      }
      const remote = "remote" in client.source ? client.source.remote : undefined;
      const evidence: SnapshotInput = { kind: "browser", metadata: { ...(remote === undefined ? {} : { remote }),
        ...(params.url ? { requestedUrl: params.url } : {}), ...(params.eval !== undefined ? { expression: params.eval } : {}) }, warnings: [] };
      // The call holds its tab from open to release, so concurrent calls on it never interleave.
      let tab: SharedTab | undefined;
      try {
        const opened = await withSetup(client, () => client.open({ tab: params.tab, url: params.url }, signal), signal, options.onSetup);
        tab = opened.tab;
        Object.assign(evidence.metadata, { browser: opened.browser, tab: tab.name });
        if (params.url) await tab.navigate(params.url, { signal });
        signal?.throwIfAborted();
        await tab.focus();
        signal?.throwIfAborted();
        try {
          evidence.beforeScreenshot = await tab.screenshot();
          evidence.metadata.beforeScreenshotCapturedAt = new Date().toISOString();
        } catch (error) { evidence.warnings!.push(`Before-screenshot unavailable: ${publicBrowserError(error)}`); }
        signal?.throwIfAborted();
        let evalResult: unknown;
        let evalError: string | undefined;
        if (params.eval !== undefined) {
          try {
            evalResult = await tab.evaluate(params.eval, { signal, timeoutMs: 30_000 });
            evidence.metadata.eval_result = evalResult ?? null;
            evidence.metadata.evalType = evalResult === undefined ? "undefined" : evalResult === null ? "null" : typeof evalResult;
          } catch (error) {
            if (signal?.aborted || tab.closed) throw error;
            evalError = error instanceof Error ? error.message : String(error);
            evidence.metadata.eval_error = evalError;
          }
        }
        signal?.throwIfAborted();
        try {
          const capture = await capturePage(tab, { signal, timeoutMs: 5000 });
          Object.assign(evidence, { html: capture.html, md: capture.md, text: capture.text, json: capture.json });
          evidence.metadata.capturedAt = capture.capturedAt;
          evidence.warnings!.push(...capture.warnings);
        } catch (error) {
          if (signal?.aborted) throw error;
          evidence.warnings!.push(`Page capture unavailable: ${publicBrowserError(error)}`);
        }
        signal?.throwIfAborted();
        try {
          evidence.screenshot = await tab.screenshot();
          evidence.metadata.screenshotCapturedAt = new Date().toISOString();
        } catch (error) { evidence.warnings!.push(`Screenshot unavailable: ${publicBrowserError(error)}`); }
        signal?.throwIfAborted();
        // The final capture is authoritative; another live evaluation could observe
        // a later navigation and falsely relabel this immutable evidence.
        const info = { url: typeof evidence.json?.url === "string" ? evidence.json.url : params.url ?? "",
          title: typeof evidence.json?.title === "string" ? evidence.json.title : "Page metadata unavailable" };
        evidence.metadata = { ...evidence.metadata, ...info, status: evalError ? "eval-error" : "complete" };
        const saved = await snapshots.save(evidence);
        signal?.throwIfAborted();
        const serialized = params.eval === undefined ? undefined : JSON.stringify(evalResult ?? null);
        const preview = serialized === undefined ? undefined : truncateHead(serialized, { maxBytes: 4096, maxLines: 60 });
        const details: BrowserResultDetails = {
          browser: opened.browser, ...(remote === undefined ? {} : { remote }), tab: tab.name, ...info,
          snapshot: saved.id, available: saved.available, truncated: preview?.truncated ?? false,
          ...(opened.warnings.length ? { warnings: opened.warnings } : {}),
          ...(preview ? preview.truncated ? { eval_preview: preview.content } : { eval_result: evalResult ?? null } : {}),
          ...(evalError ? { eval_error: evalError } : {}),
        };
        // The eval result is the payload and comes first, alone in its block.
        const payload = evalError ? truncateHead(`Evaluation error: ${evalError}`, { maxBytes: 4096, maxLines: 60 }).content : preview?.content;
        const receipt = [
          ...(preview?.truncated ? ["Evaluation preview truncated; full captured result in web_read json."] : []),
          `Tab: ${tab.name}${opened.created ? " (new)" : ""} in ${opened.browser}${remote === undefined ? "" : ` on remote ${remote}`}`,
          `Page: ${info.url} (${info.title})`,
          snapshotSummary(saved),
          ...opened.warnings.map(warning => `Warning: ${warning}`)].join("\n");
        const structuredContent = {
          tab: tab.name, new: opened.created, browser: opened.browser, ...(remote === undefined ? {} : { remote }), ...info,
          snapshot: saved.id, available: saved.available, warnings: [...opened.warnings, ...saved.warnings],
          ...(evalError ? { eval_error: evalError } : params.eval !== undefined ? { eval_result: (evalResult ?? null) as JsonValue } : {}),
        };
        return {
          content: [...(payload === undefined ? [] : [{ type: "text" as const, text: payload }]),
            { type: "text" as const, text: receipt }],
          details, structuredContent,
        };
      } catch (error) {
        // Never run fresh capture/eval after cancellation. Completed evidence stays useful.
        const failure = new Error(publicBrowserError(error));
        evidence.metadata.status = signal?.aborted ? "cancelled" : "error";
        evidence.metadata.error = failure.message;
        try {
          const saved = await snapshots.save(evidence);
          failure.message += `\n${snapshotSummary(saved)}`;
          Object.assign(failure, { snapshot: saved.id });
        } catch { failure.message += "\nSnapshot unavailable: private storage could not retain this operation."; }
        throw failure;
      } finally { await tab?.release(); }
    },
  });
  return { tool, snapshots };
}
