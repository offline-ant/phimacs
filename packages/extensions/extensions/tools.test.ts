import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext, KeybindingsManager, Theme, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import toolsExtension, { showToolDialog } from "./tools.ts";
import { TOOL_SELECTION_ENTRY } from "@phimacs/orchestration/session-tools";

function scriptedContext(selections: string[], notices: string[] = []): ExtensionContext {
  return {
    mode: "rpc",
    ui: {
      select: async (_title: string, options: string[]) => {
        const expected = selections.shift();
        if (expected === undefined) return undefined;
        const choice = options.find((option) => option.startsWith(expected));
        assert.ok(choice, `No choice for ${expected}: ${options.join(", ")}`);
        return choice;
      },
      notify: (text: string) => notices.push(text),
      custom: () => assert.fail("RPC must not call custom"),
    },
  } as unknown as ExtensionContext;
}

test("RPC tool dialog toggles, enforces required tools, and saves the default", async () => {
  const selections = ["[required] present_guidance", "[ ] browser", "[x] browser", "[ ] fresh_look", "Save as default", "Done"];
  const notices: string[] = [];
  const changes: string[][] = [];
  const saves: string[][] = [];
  const initial = ["read"];
  await showToolDialog(scriptedContext(selections, notices), {
    selection: initial,
    savedDefault: undefined,
    tools: ["read", "browser", "fresh_look", "present_guidance"].map((name) => ({ name, description: name })) as ToolInfo[],
    required: new Set(["present_guidance"]),
    onChange: (selection) => changes.push(selection),
    onSaveDefault: (selection) => { saves.push(selection); return true; },
  });
  assert.equal(selections.length, 0);
  assert.deepEqual(changes, [["read", "browser"], ["read"], ["read", "fresh_look"]]);
  assert.deepEqual(saves, [["read", "fresh_look"]]);
  assert.equal(notices.length, 1);
  assert.deepEqual(initial, ["read"]);
});

test("TUI tool dialog shows and handles its injected save-default keybinding", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tools-keybindings-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  let handler: Parameters<ExtensionAPI["registerCommand"]>[1]["handler"] | undefined;
  toolsExtension({
    on() {}, registerCommand: (_name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) => { handler = command.handler; },
    getAllTools: () => [], getActiveTools: () => [],
  } as unknown as ExtensionAPI);
  let finished = false;
  const keybindings = {
    getKeys: (action: string) => action === "app.models.save" ? ["ctrl+shift+s"] : [],
    matches: (data: string, action: string) => data === "save" && action === "app.models.save",
  } as unknown as KeybindingsManager;
  const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value } as unknown as Theme;
  const custom = async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) => {
    const component = await factory({ requestRender() {} } as TUI, theme, keybindings, () => { finished = true; });
    assert.match(component.render(120).join("\n"), /ctrl\+shift\+s save default/);
    component.handleInput?.("save");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, "tool-selection.json"), "utf8")), { enabledTools: [] });
    assert.equal(finished, false, "saving keeps the dialog open");
    return undefined;
  };
  assert.ok(handler);
  await handler("", {
    mode: "tui", hasUI: true, waitForIdle: async () => {},
    sessionManager: { getBranch: () => [] }, ui: { custom, notify() {} },
  } as unknown as ExtensionCommandContext);
});

test("RPC tool dialog cancellation leaves the selection unchanged", async () => {
  await showToolDialog(scriptedContext([]), {
    selection: ["read"], savedDefault: ["read"], tools: [], required: new Set(),
    onChange: () => assert.fail("cancel changed the selection"),
    onSaveDefault: () => assert.fail("cancel saved the selection"),
  });
});

interface FakeSession {
  active: string[] | undefined;
  registered: string[];
  branch: unknown[];
  emit(event: "session_start" | "session_tree" | "input"): Promise<void>;
  saveDefault(value: unknown): void;
  dispose(): void;
}

function fakeSession(branch: unknown[], savedDefault?: unknown): FakeSession {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tools-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const session: FakeSession = {
    active: undefined,
    registered: ["read", "ask", "do", "microdo", "delegate", "fresh_look", "codemode", "tool_search"],
    branch,
    emit: async (event) => {
      await handlers.get(event)?.({}, { cwd: "/tmp", sessionManager: { getBranch: () => session.branch } });
    },
    saveDefault: (value) => fs.writeFileSync(path.join(agentDir, "tool-selection.json"), JSON.stringify(value)),
    dispose: () => {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      fs.rmSync(agentDir, { recursive: true, force: true });
    },
  };
  if (savedDefault !== undefined) session.saveDefault(savedDefault);
  toolsExtension({
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler),
    registerCommand: () => undefined,
    getAllTools: () => session.registered.map((name) => ({ name })),
    getActiveTools: () => session.active ?? [],
    setActiveTools: (tools: string[]) => { session.active = tools; },
  } as unknown as Parameters<typeof toolsExtension>[0]);
  return session;
}

async function startSession(branch: unknown[], savedDefault?: unknown): Promise<string[] | undefined> {
  const session = fakeSession(branch, savedDefault);
  try {
    await session.emit("session_start");
    return session.active;
  } finally {
    session.dispose();
  }
}

test("without a saved selection, normal defaults including microdo stay active", async () => {
  const session = fakeSession([]);
  try {
    session.active = ["read", "do", "microdo"];
    await session.emit("session_start");
    await session.emit("input");
    assert.deepEqual(session.active, ["read", "do", "microdo"]);
  } finally {
    session.dispose();
  }
});

test("saved defaults apply exactly, including whether microdo is selected", async () => {
  assert.deepEqual(await startSession([], { enabledTools: ["read", "do"] }), ["read", "do"]);
  assert.deepEqual(await startSession([], { enabledTools: ["read", "microdo"] }), ["read", "microdo"]);
});

test("branch selections override saved defaults exactly for microdo", async () => {
  assert.deepEqual(await startSession([
    { type: "custom", customType: TOOL_SELECTION_ENTRY, data: { enabledTools: ["read", "do"] } },
  ], { enabledTools: ["read", "microdo"] }), ["read", "do"]);
  assert.deepEqual(await startSession([
    { type: "custom", customType: TOOL_SELECTION_ENTRY, data: { enabledTools: ["read", "microdo"] } },
  ], { enabledTools: ["read", "do"] }), ["read", "microdo"]);
});

test("an interactive fork releases inherited worker ownership and restores exact available tools", async () => {
  assert.deepEqual(await startSession([
    { type: "custom", customType: "pi-orchestration:delegate-runtime", data: {} },
    { type: "custom", customType: "pi-orchestration:fork", data: {} },
    { type: "custom", customType: TOOL_SELECTION_ENTRY, data: { enabledTools: ["read", "unavailable"] } },
  ], { enabledTools: ["do"] }), ["read"]);
});

test("structured workers keep the tools their request selected", async () => {
  assert.equal(await startSession([
    { type: "custom", customType: "pi-orchestration:delegate-runtime", data: {} },
  ], { enabledTools: ["do"] }), undefined);
});

test("activations Pi makes after the selection was applied survive later prompts", async () => {
  const session = fakeSession([], { enabledTools: ["read", "do"] });
  try {
    await session.emit("session_start");
    // An MCP server connects: its codemode-exposed tool registers inactive and Pi enables codemode.
    session.registered.push("mcp_search");
    session.active = [...session.active!, "codemode", "tool_search"];
    await session.emit("input");
    // tool_search declares a match for the following calls.
    session.active = [...session.active, "mcp_search"];
    await session.emit("input");
    assert.deepEqual(session.active, ["read", "do", "codemode", "tool_search", "mcp_search"]);
  } finally {
    session.dispose();
  }
});

test("a changed saved default, ended Ugo control, or branch change reapplies the selection", async () => {
  const session = fakeSession([], { enabledTools: ["read"] });
  try {
    await session.emit("session_start");
    session.active = [...session.active!, "codemode"];
    session.saveDefault({ enabledTools: ["read", "ask"] });
    await session.emit("input");
    assert.deepEqual(session.active, ["read", "ask"]);

    session.branch = [{ type: "custom", customType: "pi-ant:ugo-state", data: { active: true } }];
    session.active = ["present_guidance"];
    await session.emit("input");
    assert.deepEqual(session.active, ["present_guidance"]);
    session.branch = [...session.branch, { type: "custom", customType: "pi-ant:ugo-state", data: { active: false } }];
    await session.emit("input");
    assert.deepEqual(session.active, ["read", "ask"]);

    session.active = [...session.active, "codemode"];
    session.branch = [{ type: "custom", customType: TOOL_SELECTION_ENTRY, data: { enabledTools: ["read", "ask"] } }];
    await session.emit("session_tree");
    assert.deepEqual(session.active, ["read", "ask"]);
  } finally {
    session.dispose();
  }
});

test("selected tools registered after the selection was applied become active", async () => {
  const session = fakeSession([], { enabledTools: ["read", "mcp_direct"] });
  try {
    await session.emit("session_start");
    assert.deepEqual(session.active, ["read"]);
    session.registered.push("mcp_direct", "mcp_other");
    session.active = [...session.active!, "codemode"];
    await session.emit("input");
    assert.deepEqual(session.active, ["read", "codemode", "mcp_direct"]);
  } finally {
    session.dispose();
  }
});
