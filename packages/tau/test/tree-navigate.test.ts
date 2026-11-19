import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TREE_NAVIGATE_COMMAND, TREE_NAVIGATION_MARKER_TYPE } from '@phimacs/pimux/protocol';

import type { ChildProcess } from 'node:child_process';
import type { TestContext } from 'node:test';

// Isolate settings + sessions in a temp tree. Env must be set before
// requiring the module.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-tree-'));
process.env.PI_CODING_AGENT_DIR = TMP;
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(TMP, 'sessions');

// Load the server after the env is in place: the module reads it at load
// time, and ESM hoists static imports ahead of this body.
const {
  handleRpcCommand,
  liveManager,
  navigateTree,
  selectNavigationTarget,
  entriesById,
  pathFromRoot,
  leafDescendsFrom,
} = (await import('../bin/tau.js')) as any;

type Json = Record<string, any>;

// pimux loads this extension into every managed Pi; the real-child test below loads it directly.
const EXTENSION_PATH = fileURLToPath(import.meta.resolve('@phimacs/pimux/tree-navigate'));
const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-tree-proj-'));
let fileCounter = 0;

// Small session tree, format per docs/session-format.md:
//   u1 (user) → a1 (assistant) → u2 (user) → a2 (assistant)
function treeSessionEntries(): Json[] {
  return [
    { type: 'message', id: 'u1', parentId: null, timestamp: '2026-07-01T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'first user message' }], timestamp: 1 } },
    { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-07-01T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'first assistant reply' }] } },
    { type: 'message', id: 'u2', parentId: 'a1', timestamp: '2026-07-01T00:00:03.000Z', message: { role: 'user', content: [{ type: 'text', text: 'second user message' }], timestamp: 2 } },
    { type: 'message', id: 'a2', parentId: 'u2', timestamp: '2026-07-01T00:00:04.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'second assistant reply' }] } },
  ];
}

function writeTreeSession(): string {
  const file = path.join(PROJ, `session-${fileCounter++}.jsonl`);
  const lines: Json[] = [
    { type: 'session', version: 3, id: '0199aaaa-1111-2222-3333-444444444444', timestamp: '2026-07-01T00:00:00.000Z', cwd: PROJ },
    ...treeSessionEntries(),
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

function readEntries(file: string): Json[] {
  return fs.readFileSync(file, 'utf8').split('\n').filter((l: string) => l.trim()).map((l: string) => JSON.parse(l));
}

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.rmSync(PROJ, { recursive: true, force: true });
});

// ═══════════════════════════════════════
// selectNavigationTarget (pure selection semantics)
// ═══════════════════════════════════════

test('selectNavigationTarget: user message → parent + editor text', () => {
  const target = selectNavigationTarget({ id: 'u2', parentId: 'a1', type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } });
  assert.deepEqual(target, { leafTargetId: 'a1', editorText: 'hello' });
});

test('selectNavigationTarget: root user message → null leaf + editor text', () => {
  const target = selectNavigationTarget({ id: 'u1', parentId: null, type: 'message', message: { role: 'user', content: 'plain string content' } });
  assert.deepEqual(target, { leafTargetId: null, editorText: 'plain string content' });
});

test('selectNavigationTarget: custom message → parent + editor text', () => {
  const target = selectNavigationTarget({ id: 'c1', parentId: 'a1', type: 'custom_message', customType: 'ext', content: [{ type: 'text', text: 'custom text' }] });
  assert.deepEqual(target, { leafTargetId: 'a1', editorText: 'custom text' });
});

test('selectNavigationTarget: assistant / other entries → the entry itself, no editor text', () => {
  assert.deepEqual(selectNavigationTarget({ id: 'a1', parentId: 'u1', type: 'message', message: { role: 'assistant', content: [] } }), { leafTargetId: 'a1' });
  assert.deepEqual(selectNavigationTarget({ id: 'k1', parentId: 'a1', type: 'compaction' }), { leafTargetId: 'k1' });
});

// ═══════════════════════════════════════
// tree helpers
// ═══════════════════════════════════════

function sampleEntries() {
  // u1 → a1 → { u2 → a2, marker }
  return [
    { id: 'u1', parentId: null, type: 'message' },
    { id: 'a1', parentId: 'u1', type: 'message' },
    { id: 'u2', parentId: 'a1', type: 'message' },
    { id: 'a2', parentId: 'u2', type: 'message' },
    { id: 'm1', parentId: 'a1', type: 'custom' },
  ];
}

test('entriesById/pathFromRoot/leafDescendsFrom walk the flat get_entries payload', () => {
  const byId = entriesById(sampleEntries());
  assert.equal(byId.size, 5);
  assert.deepEqual(pathFromRoot(byId, 'm1').map((e: Json) => e.id), ['u1', 'a1', 'm1']);
  assert.deepEqual(pathFromRoot(byId, null), []);
  assert.equal(leafDescendsFrom(byId, 'm1', 'a1'), true);
  assert.equal(leafDescendsFrom(byId, 'm1', 'm1'), true);
  assert.equal(leafDescendsFrom(byId, 'a2', 'm1'), false);
});

// ═══════════════════════════════════════
// navigateTree orchestration (fake pi child, no LLM)
// ═══════════════════════════════════════

// In-memory stand-in for a pi child with pimux's tree-navigate extension loaded: answers
// get_entries/get_commands and emulates the /pimux-tree-navigate handler on
// prompt, including its selection semantics and marker append. Its snapshot
// is the child's active path, as the mux snapshot is for a real session.
const RUNTIME_CONTEXT = { contextId: 'ctx-1', sessionFile: '/fake/session.jsonl' };
const INPUT_CONTEXT = { agentId: 'mux-1', file: '/fake/session.jsonl', runtimeContext: RUNTIME_CONTEXT };

function fakeSession(opts: { isStreaming?: boolean; entries?: Json[]; leafId?: string; extensionLoaded?: boolean; extensionError?: string } = {}) {
  const state = {
    entries: (opts.entries ?? treeSessionEntries()).map((e) => ({ ...e })),
    leafId: (opts.leafId ?? 'a2') as string | null,
    markerCounter: 0,
  };
  const sent: Json[] = [];
  const broadcasts: Json[] = [];
  const updated: string[] = [];

  const session = {
    id: 'live_1',
    isStreaming: !!opts.isStreaming,
    capabilities: { navigateTree: true },
    lastExtensionError: null as string | null,
    navigateCommandChecked: false,
    sent,
    broadcasts,
    updated,
    state,
    async send(command: Json) {
      sent.push(command);
      if (command.type === 'get_entries') {
        return { type: 'response', command: 'get_entries', success: true, data: { entries: state.entries, leafId: state.leafId } };
      }
      if (command.type === 'get_commands') {
        const commands = opts.extensionLoaded === false ? [] : [{ name: TREE_NAVIGATE_COMMAND, source: 'extension' }];
        return { type: 'response', command: 'get_commands', success: true, data: { commands } };
      }
      if (command.type === 'prompt') {
        // Emulate pi's extension-command path: handler errors surface as an
        // extension_error EVENT (recorded by PiRpcSession.handleEvent before
        // the response line arrives), while the prompt still acks success.
        if (opts.extensionError) {
          session.lastExtensionError = opts.extensionError;
          return { type: 'response', command: 'prompt', success: true };
        }
        const entryId = String(command.message).replace(`/${TREE_NAVIGATE_COMMAND} `, '').trim();
        const entry = state.entries.find((e) => e.id === entryId);
        if (entry && entryId !== state.leafId) {
          const isUserish = (entry.type === 'message' && entry.message?.role === 'user') || entry.type === 'custom_message';
          const targetLeaf = isUserish ? (entry.parentId ?? null) : entryId;
          if (targetLeaf !== state.leafId) {
            const marker = { id: `m${++state.markerCounter}`, parentId: targetLeaf, type: 'custom', customType: TREE_NAVIGATION_MARKER_TYPE, data: { navigatedTo: entryId } };
            state.entries.push(marker);
            state.leafId = marker.id;
          }
        }
        return { type: 'response', command: 'prompt', success: true };
      }
      throw new Error(`unexpected command: ${command.type}`);
    },
    // Mutating browser commands carry the context the browser captured.
    browserInputContext(command: Json) {
      if (command.inputContext?.agentId !== INPUT_CONTEXT.agentId) throw new Error('Input belongs to an unavailable or different conversation');
      return { agentId: INPUT_CONTEXT.agentId, file: INPUT_CONTEXT.file, leafId: null, runtimeContext: command.inputContext.runtimeContext };
    },
    async snapshot() {
      return { session: { id: this.id }, entries: pathFromRoot(entriesById(state.entries), state.leafId), isStreaming: this.isStreaming };
    },
    manager: {
      broadcast(data: Json) { broadcasts.push(data); },
      broadcastUpdated(id: string) { updated.push(id); },
    },
  };
  return session;
}

test('navigateTree drives the extension command, re-derives the active path, and broadcasts a snapshot', async () => {
  const session = fakeSession();
  const result = await navigateTree(session, 'u2');
  assert.equal(result.editorText, 'second user message');

  // Preflight get_entries resolves the target, get_commands confirms the child
  // loaded pimux's extension, then the slash command moves the leaf in-process
  // and the follow-up get_entries verifies it.
  assert.deepEqual(session.sent.map((c: Json) => c.type), ['get_entries', 'get_commands', 'prompt', 'get_entries']);
  assert.equal(session.sent[2].message, `/${TREE_NAVIGATE_COMMAND} u2`);

  // Every browser gets a fresh full snapshot of the new active path
  // root → target (marker included) plus the metadata update.
  assert.equal(session.broadcasts.length, 1);
  assert.equal(session.broadcasts[0].type, 'live_session_snapshot');
  assert.equal(session.broadcasts[0].sessionId, 'live_1');
  const entries = session.broadcasts[0].entries as Json[];
  assert.deepEqual(entries.slice(0, 2).map((e) => e.id), ['u1', 'a1']);
  assert.equal(entries[entries.length - 1].customType, TREE_NAVIGATION_MARKER_TYPE);
  assert.ok(!entries.some((e) => e.id === 'u2' || e.id === 'a2'));
  assert.deepEqual(session.updated, ['live_1']);
});

test('navigateTree checks the extension command only once per child', async () => {
  const session = fakeSession();
  await navigateTree(session, 'a1');
  session.sent.length = 0;
  await navigateTree(session, 'u2');
  assert.ok(!session.sent.some((c: Json) => c.type === 'get_commands'));
});

test('navigating to the current position skips the child round-trip', async () => {
  // The current leaf itself…
  let session = fakeSession({ leafId: 'a2' });
  let result = await navigateTree(session, 'a2');
  assert.equal(result.editorText, undefined);
  assert.deepEqual(session.sent.map((c: Json) => c.type), ['get_entries']);

  // …and a user message whose parent already is the leaf: no move, but the
  // text still goes back so the composer gets prefilled for edit + resubmit.
  session = fakeSession({ leafId: 'a1' });
  result = await navigateTree(session, 'u2');
  assert.equal(result.editorText, 'second user message');
  assert.deepEqual(session.sent.map((c: Json) => c.type), ['get_entries']);
});

test('navigateTree refuses while the session is streaming', async () => {
  const session = fakeSession({ isStreaming: true });
  await assert.rejects(() => navigateTree(session, 'a1'), /while the agent is streaming/);
  assert.equal(session.sent.length, 0);
});

test('navigateTree rejects unknown entries from the preflight tree', async () => {
  const session = fakeSession();
  await assert.rejects(() => navigateTree(session, 'nope'), /Entry nope not found/);
  assert.ok(!session.sent.some((c: Json) => c.type === 'prompt'));
});

test('a turn that starts during navigation aborts it before the command is sent', async () => {
  const session = fakeSession();
  // Simulate agent_start racing in while the preflight round-trips: the
  // guard passed once, but the re-check after the awaits must still refuse.
  const origSend = session.send.bind(session);
  session.send = async (command: Json) => {
    const resp = await origSend(command);
    session.isStreaming = true;
    return resp;
  };
  await assert.rejects(() => navigateTree(session, 'a1'), /streaming/);
  assert.ok(!session.sent.some((c: Json) => c.type === 'prompt'));
});

test('concurrent navigations on the same session are refused instead of interleaved', async () => {
  const session = fakeSession();
  const origSend = session.send.bind(session);
  session.send = async (command: Json) => {
    await new Promise((r) => setTimeout(r, 25));
    return origSend(command);
  };
  const first = navigateTree(session, 'a1');
  await assert.rejects(() => navigateTree(session, 'u2'), /already in progress/);
  await first;
});

test('a child without the extension is refused before anything is prompted', async () => {
  const session = fakeSession({ extensionLoaded: false });
  await assert.rejects(() => navigateTree(session, 'a1'), /did not load pimux's pimux-tree-navigate extension/);
  assert.ok(!session.sent.some((c: Json) => c.type === 'prompt'));
  assert.equal(session.navigateCommandChecked, false);
});

test('a handler error surfaces via the captured extension_error and clients are re-synced', async () => {
  const session = fakeSession({ extensionError: 'Entry a1 not found in the session tree' });
  await assert.rejects(() => navigateTree(session, 'a1'), /did not move the session leaf.*Entry a1 not found/);
  // Even on failure every client is re-rendered onto the child's real state.
  assert.equal(session.broadcasts.length, 1);
  assert.deepEqual(session.broadcasts[0].entries.map((e: Json) => e.id), ['u1', 'a1', 'u2', 'a2']);
});

// ═══════════════════════════════════════
// handleRpcCommand guards
// ═══════════════════════════════════════

test('navigate_tree via handleRpcCommand: unknown session / missing entryId fail cleanly', async () => {
  const missing = await handleRpcCommand({ type: 'navigate_tree', sessionId: 'nope', entryId: 'a1' });
  assert.equal(missing.success, false);
  assert.match(String(missing.error), /Live session not found/);

  const session = fakeSession();
  liveManager.sessions.set(session.id, session);
  try {
    const uncaptured = await handleRpcCommand({ type: 'navigate_tree', sessionId: session.id, entryId: 'a1' });
    assert.equal(uncaptured.success, false);
    assert.match(String(uncaptured.error), /different conversation/);

    const noEntry = await handleRpcCommand({ type: 'navigate_tree', sessionId: session.id, inputContext: INPUT_CONTEXT });
    assert.equal(noEntry.success, false);
    assert.match(String(noEntry.error), /entryId required/);

    session.isStreaming = true;
    const streaming = await handleRpcCommand({ type: 'navigate_tree', sessionId: session.id, entryId: 'a1', inputContext: INPUT_CONTEXT });
    assert.equal(streaming.success, false);
    assert.match(String(streaming.error), /streaming/);

    session.isStreaming = false;
    const ok = await handleRpcCommand({ type: 'navigate_tree', sessionId: session.id, entryId: 'u2', inputContext: INPUT_CONTEXT });
    assert.equal(ok.success, true);
    assert.equal((ok.data as Json).editorText, 'second user message');
    // The navigation command carries the browser's captured context to the mux.
    assert.deepEqual(session.sent.find((c: Json) => c.type === 'prompt')?.pimuxContext, RUNTIME_CONTEXT);
  } finally {
    liveManager.sessions.delete(session.id);
  }
});

test('prompts are refused while a tree navigation is in flight', async () => {
  const session = fakeSession();
  const origSend = session.send.bind(session);
  session.send = async (command: Json) => {
    await new Promise((r) => setTimeout(r, 25));
    return origSend(command);
  };
  liveManager.sessions.set(session.id, session);
  try {
    const nav = navigateTree(session, 'a1');
    const prompt = await handleRpcCommand({ type: 'prompt', message: 'racing prompt', sessionId: session.id, inputContext: INPUT_CONTEXT });
    assert.equal(prompt.success, false);
    assert.match(String(prompt.error), /navigation is in progress/);
    await nav;
    // The racing prompt was refused up front, never forwarded to the child.
    assert.ok(!session.sent.some((c: Json) => c.message === 'racing prompt'));
  } finally {
    liveManager.sessions.delete(session.id);
  }
});

// ═══════════════════════════════════════
// Real pi child with pimux's tree-navigate extension (skipped without pi)
// ═══════════════════════════════════════

const piAvailable = (() => {
  try { return spawnSync('pi', ['--version'], { encoding: 'utf8', timeout: 15000 }).status === 0; } catch { return false; }
})();

type RpcClient = { child: ChildProcess; send: (command: Json) => Promise<Json> };

function spawnPi(t: TestContext, file: string): RpcClient {
  const child: ChildProcess = spawn('pi', ['--mode', 'rpc', '--extension', EXTENSION_PATH, '--session', file], {
    cwd: PROJ,
    env: { ...process.env, TAU_DISABLED: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });

  const pending = new Map<string, (msg: Json) => void>();
  let buf = '';
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg: Json;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.type === 'response' && msg.id && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      }
    }
  });
  function send(command: Json): Promise<Json> {
    const id = `t_${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${command.type}`)); }, 30000);
      pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      child.stdin!.write(JSON.stringify({ ...command, id }) + '\n');
    });
  }
  return { child, send };
}

test('the tree-navigate extension moves a real pi child\'s leaf, invisibly to the LLM, and it survives a restart', { skip: !piAvailable, timeout: 120000 }, async (t: TestContext) => {
  const file = writeTreeSession();
  const pi = spawnPi(t, file);

  // Wait for the child to accept RPC commands.
  await new Promise((r) => setTimeout(r, 1500));
  const before = await pi.send({ type: 'get_entries' });
  assert.equal(before.success, true);

  const session = {
    id: 'live_pi',
    isStreaming: false,
    entries: [] as Json[],
    historyEpoch: 0,
    lastExtensionError: null as string | null,
    send: pi.send,
    snapshot() { return { entries: this.entries }; },
    manager: { broadcast() {}, broadcastUpdated() {} },
  };
  const result = await navigateTree(session, 'a1');
  assert.equal(result.editorText, undefined);

  // The child's in-memory leaf now sits at our marker: the active
  // conversation is just the first user/assistant pair.
  const messages = await pi.send({ type: 'get_messages' });
  assert.equal(messages.success, true);
  const texts = (messages.data.messages as Json[])
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => (Array.isArray(m.content) ? m.content.filter((b: Json) => b.type === 'text').map((b: Json) => b.text).join('') : m.content));
  assert.deepEqual(texts, ['first user message', 'first assistant reply']);

  // On disk: the extension persisted the move as a marker entry, and the
  // /pimux-tree-navigate command never became a user message.
  const entries = readEntries(file);
  const marker = entries[entries.length - 1];
  assert.equal(marker.type, 'custom');
  assert.equal(marker.customType, TREE_NAVIGATION_MARKER_TYPE);
  assert.equal(marker.parentId, 'a1');
  assert.ok(!entries.some((e) => e.type === 'message' && JSON.stringify(e.message?.content ?? '').includes(TREE_NAVIGATE_COMMAND)));

  // A fresh pi on the same file derives its leaf from the last entry — the
  // marker — so the navigation survives the restart.
  pi.child.kill('SIGKILL');
  const revived = spawnPi(t, file);
  await new Promise((r) => setTimeout(r, 1500));
  const afterRestart = await revived.send({ type: 'get_entries' });
  assert.equal(afterRestart.success, true);
  const byId = entriesById(afterRestart.data.entries);
  assert.ok(leafDescendsFrom(byId, afterRestart.data.leafId, marker.id));
  assert.ok(leafDescendsFrom(byId, afterRestart.data.leafId, 'a1'));
});
