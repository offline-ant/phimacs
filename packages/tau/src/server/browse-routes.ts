// Read-only browsing routes: project and session lists and session files.

import fs from 'node:fs';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import { json, errorMessage, errorStatus } from './server-main.js';
import { SESSIONS_DIR, expandHome } from './config.js';
import { sessionOwners } from './session-owners.js';
import { pimuxFiles } from './pimux.js';
import { liveManager, isGenericSessionName } from './sessions.js';
import type { JsonRecord } from './types.js';
import { readSessionHeader } from './session-header.js';
import { isWithinPath, resolveSessionFile } from './session-paths.js';
import { canonicalSessionPath } from '@phimacs/pimux/ownership';

function canonicalFile(file: string) {
  try { return fs.realpathSync(file); } catch { return path.resolve(file); }
}

function liveFilesSet() {
  return new Set(liveManager.list().map((s) => s.sessionFile).filter(Boolean));
}

export function normalizeSessionCwd(cwd: unknown) {
  return typeof cwd === 'string' && cwd.trim() ? path.resolve(expandHome(cwd)) : null;
}

export function readSessionEntries(filePath: string): unknown[] {
  const entries: unknown[] = [];
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch { /* skip malformed lines */ }
    }
  } catch { /* file may not exist yet */ }
  return entries;
}

export function deriveSessionNameFromEntries(entries: JsonRecord[]) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as { type?: string; name?: unknown };
    const name = typeof e?.name === 'string' ? e.name.trim() : '';
    if (e?.type === 'session_info' && name && !isGenericSessionName(name)) return name;
  }
  for (const entry of entries) {
    const e = entry as { type?: string; message?: { role?: string; content?: unknown } };
    if (e?.type !== 'message' || e.message?.role !== 'user') continue;
    const title = titleFromMessageContent(e.message.content);
    if (title) return title;
  }
  return null;
}

function titleFromMessageContent(content: unknown) {
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content
      .filter((b): b is { type?: unknown; text?: unknown } => !!b && typeof b === 'object')
      .filter((b) => b.type === 'text')
      .map((b) => typeof b.text === 'string' ? b.text : '')
      .join('\n');
  }
  let title = text.replace(/^(ok |okay |so |actually |hey |please |can you |could you |i want(ed)? to |i wanna |let'?s )/i, '').replace(/\n.*/s, '').trim();
  if (!title) return null;
  const sentenceEnd = title.search(/[.!?]\s/);
  if (sentenceEnd > 10 && sentenceEnd < 80) title = title.slice(0, sentenceEnd);
  if (title.length > 60) title = title.slice(0, 57).replace(/\s+\S*$/, '') + '…';
  title = title.charAt(0).toUpperCase() + title.slice(1);
  return title || null;
}

export function readSessionHeaderCwd(filePath: string) {
  try { return readSessionHeader(filePath).cwd; }
  catch { return null; }
}

/**
 * One project per session directory: pi derives that directory name from the
 * session cwd, so a directory is a project and its newest file carries the
 * current cwd. Listing costs a readdir and a stat per file, no transcript
 * parsing — the sidebar loads a project's sessions only when it is expanded.
 */
function projectSummaries() {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  const projects: Array<{ path: string; dirName: string; count: number; lastActive: number }> = [];
  for (const dir of fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const projectDir = path.join(SESSIONS_DIR, dir.name);
    let count = 0, lastActive = 0, newest = '';
    for (const file of fs.readdirSync(projectDir)) {
      if (!file.endsWith('.jsonl')) continue;
      count++;
      const mtime = fs.statSync(path.join(projectDir, file)).mtimeMs;
      if (mtime >= lastActive) { lastActive = mtime; newest = file; }
    }
    if (!count) continue;
    projects.push({ path: readSessionHeaderCwd(path.join(projectDir, newest)) || '', dirName: dir.name, count, lastActive });
  }
  projects.sort((a, b) => b.lastActive - a.lastActive);
  return projects;
}

export function serveProjectSummaries(res: ServerResponse) {
  try {
    json(res, 200, { projects: projectSummaries() });
  } catch (e) { json(res, 500, { error: errorMessage(e) }); }
}

export function serveProjectSessions(res: ServerResponse, dirName: string) {
  try {
    const projectDir = canonicalSessionPath(path.join(SESSIONS_DIR, decodeURIComponent(dirName)));
    if (!isWithinPath(canonicalSessionPath(SESSIONS_DIR), projectDir)) return json(res, 403, { error: 'Project is outside session storage' });
    if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) return json(res, 404, { error: 'Project not found' });
    const liveFiles = liveFilesSet();
    const owners = sessionOwners();
    const sharedFiles = pimuxFiles();
    const sessions = fs.readdirSync(projectDir)
      .filter((file: string) => file.endsWith('.jsonl'))
      .map((file: string) => {
        const filePath = path.join(projectDir, file);
        // A pimux-shared session opens by attaching, never as a read-only follow.
        const shared = sharedFiles.get(canonicalFile(filePath)) ?? null;
        return {
          ...readSessionSummary(filePath), file, dir: dirName, filePath,
          live: liveFiles.has(filePath), owner: shared ? null : owners.get(filePath) ?? null, shared,
        };
      })
      .sort((a, b) => b.mtime - a.mtime);
    json(res, 200, { sessions });
  } catch (e) { json(res, 500, { error: errorMessage(e) }); }
}

/** Bytes read per step from the start of a transcript, and once from its end. */
const SUMMARY_WINDOW = 64 * 1024;

/**
 * Summarises one stored session without reading it whole: the start is read
 * forward only as far as the first user message (system records of any size
 * may precede it), and a rename is appended at the end, so one window there
 * completes everything the sidebar shows.
 * Transcripts here reach tens of megabytes, and a project holds thousands.
 */
function readSessionSummary(filePath: string) {
  const { size, mtimeMs } = fs.statSync(filePath);
  let id = '', timestamp = '', name: string | null = null, firstMessage: string | null = null;
  const readLine = (line: string) => {
    if (!line.trim()) return;
    let entry;
    try { entry = JSON.parse(line); } catch { return; }
    if (entry.type === 'session') { id = entry.id || ''; timestamp = entry.timestamp || ''; }
    else if (entry.type === 'session_info' && entry.name) name = entry.name;
    else if (firstMessage === null && entry.type === 'message' && entry.message?.role === 'user') {
      firstMessage = titleFromMessageContent(entry.message.content);
    }
  };

  const fd = fs.openSync(filePath, 'r');
  try {
    const window = Buffer.alloc(SUMMARY_WINDOW);
    let position = 0;
    let partial: Buffer = Buffer.alloc(0);
    while (firstMessage === null && position < size) {
      const bytesRead = fs.readSync(fd, window, 0, SUMMARY_WINDOW, position);
      if (!bytesRead) break;
      position += bytesRead;
      partial = Buffer.concat([partial, window.subarray(0, bytesRead)]);
      let newline;
      while ((newline = partial.indexOf(10)) !== -1) {
        readLine(partial.toString('utf8', 0, newline));
        partial = partial.subarray(newline + 1);
      }
    }
    // The rest is sampled from the end. A window that starts past the first
    // unread line starts mid-record, so its leading partial line is dropped.
    const unread = position - partial.length;
    const tailStart = Math.max(unread, size - SUMMARY_WINDOW);
    readWindow(fd, tailStart, SUMMARY_WINDOW).split('\n').slice(tailStart > unread ? 1 : 0).forEach(readLine);
  } finally {
    fs.closeSync(fd);
  }
  return { id, timestamp, name, firstMessage, mtime: mtimeMs };
}

function readWindow(fd: number, position: number, length: number) {
  const buffer = Buffer.alloc(length);
  const bytesRead = fs.readSync(fd, buffer, 0, length, position);
  return buffer.toString('utf8', 0, bytesRead);
}

/**
 * Reads a stored session. `since` is a byte offset from a previous read, so a
 * follower polls only the entries appended since then; a file that shrank or
 * was rewritten answers from the start with `reset`, because its earlier bytes
 * no longer describe the same conversation.
 */
export function serveSessionFile(res: ServerResponse, dirName: string, file: string, since: string | null) {
  let filePath: string;
  try { filePath = resolveSessionFile(path.join(SESSIONS_DIR, decodeURIComponent(dirName), decodeURIComponent(file))); }
  catch (error) { return json(res, errorStatus(error), { error: errorMessage(error) }); }
  if (!fs.existsSync(filePath)) return json(res, 404, { error: 'Session not found' });
  const size = fs.statSync(filePath).size;
  const requested = since === null ? 0 : Number(since);
  if (!Number.isInteger(requested) || requested < 0) return json(res, 400, { error: 'since must be a byte offset' });
  const reset = requested > size;
  const start = reset ? 0 : requested;
  const entries: unknown[] = [];
  if (start >= size) return json(res, 200, { entries, offset: size, reset });
  const stream = fs.createReadStream(filePath, { encoding: 'utf8', start });
  let buffer = '';
  // Whole lines only: the last partial line stays unread until its newline
  // arrives, so the next poll starts at a record boundary.
  let consumed = start;
  stream.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n'); buffer = lines.pop() || '';
    for (const line of lines) {
      consumed += Buffer.byteLength(line) + 1;
      if (line.trim()) { try { entries.push(JSON.parse(line)); } catch {} }
    }
  });
  stream.on('end', () => json(res, 200, { entries, offset: consumed, reset }));
  stream.on('error', (e: Error) => json(res, 500, { error: e.message }));
}
