#!/usr/bin/env node
/*
 * Tau standalone server.
 *
 * Serves the Tau web UI and equal socket clients of detached Pi runtimes.
 * Agent Close stops its exact runtime; internal view cleanup and server
 * shutdown only disconnect. Browser loss never controls agent lifetime.
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { spawn, execFile } from 'node:child_process';
import { WebSocketServer, WebSocket } from 'ws';

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Stats } from 'node:fs';
import type { AddressInfo, Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';
import type { WebSocket as WsType } from 'ws';
import type { JsonRecord, RpcCommand, RpcResponse } from './types.js';
import { ARGS, AUTH_CONFIGURED, AUTH_OVERRIDE, HOST, HTTP_PORT, MIME_TYPES, PI_AGENT_DIR, PI_COMMAND, PORT, SESSIONS_DIR, STATIC_DIR, TAU_SETTINGS, TLS_DIR, USER_HOME, expandHome, isLoopbackHost, loadTauSettings, parseArgs, requireTauCredentials, resolvePiCommand, saveTauSetting } from './config.js';
import { SESSION_COOKIE_NAME, SESSION_REFRESH_THRESHOLD_SECONDS, buildSessionCookie, issueSessionToken, matchCredentials, parseCookies, verifySessionToken } from './auth.js';
import { sendLoginPage, submitLogin } from './browser-login.js';
import { completeDirectories } from './path-completion.js';
import { getAvailableModels, modelLabel, normalizeModel, parseModelSpecToModel, parsePiListModels, _clearModelListCacheForTest, _setExecFileForTest } from './model-utils.js';
import { InputContextError, LiveSessionManager, PiRpcSession, SessionOpenError, assertNoSessionArgs, liveManager, makeId } from './sessions.js';
import { isReadOnlyCommand, isRecord } from '@phimacs/pimux/protocol';
import { readWorkerTask } from '@phimacs/orchestration/worker-task';
import { workerExitReport } from './runtime-exit.js';
import { pimuxEntryById } from './pimux.js';
import { AgentOverview } from './agents.js';
import { closeRegisteredEmacsPanel } from '@phimacs/orchestration/panel-owner';
import { lookupClaim } from '@phimacs/pimux/ownership';
import { exportSession } from './session-export.js';
import { publishBrowserUrls, unpublishBrowserUrls } from './orchestration.js';
import { sessionOwner, sessionOwners } from './session-owners.js';
import { ensureTlsCertificate } from './tls.js';
import type { SoundRuntime } from '@phimacs/sound';
import { MAX_FRAME_BYTES, VOICE_PATH, configuredVoice, handleVoiceSocket } from './voice.js';
import { entriesById, isTreeNavigationInProgress, leafDescendsFrom, navigateTree, pathFromRoot, selectNavigationTarget } from './tree.js';
import { normalizeSessionCwd, readSessionHeaderCwd, readSessionEntries, deriveSessionNameFromEntries, serveProjectSummaries, serveProjectSessions, serveSessionFile } from './browse-routes.js';
import { isWithinPath, resolveExportOutputPath, resolveSessionFile } from './session-paths.js';

type TauWs = WsType & { isAlive?: boolean };

const loopbackOnly = isLoopbackHost(HOST);
let authEnabled = TAU_SETTINGS.authEnabled;

function allowedRequestHost(req: IncomingMessage): boolean {
  if (authEnabled) return true;
  // A browser can reach loopback under a non-local DNS name after its DNS
  // answer changes. Origin alone cannot distinguish that from a real local UI.
  const authority = /^(localhost|\[::1\]|127\.(?:\d{1,3}\.){2}\d{1,3})(?::\d{1,5})?$/i.exec(req.headers.host ?? '');
  return authority !== null && isLoopbackHost(authority[1].toLowerCase().replace('[::1]', '::1'));
}

function checkBasicAuth(req: IncomingMessage) {
  if (!authEnabled) return true;
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString();
  const colon = decoded.indexOf(':');
  if (colon === -1) return false;
  return matchCredentials(decoded.slice(0, colon), decoded.slice(colon + 1));
}

type AuthResult = { ok: boolean; via: 'disabled' | 'basic' | 'cookie' | 'none'; expiresAt?: number };

// A wrong Basic header does not short-circuit: a valid session cookie still
// wins, so a browser resending a stale cached Basic header cannot lock the
// user out of an otherwise live session.
function checkAuth(req: IncomingMessage): AuthResult {
  if (!authEnabled) return { ok: true, via: 'disabled' };
  if (checkBasicAuth(req)) return { ok: true, via: 'basic' };
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME];
  if (token) {
    const verdict = verifySessionToken(token);
    if (verdict.valid) return { ok: true, via: 'cookie', expiresAt: verdict.expiresAt };
  }
  return { ok: false, via: 'none' };
}

/**
 * The one route open without credentials, compared after URL normalization:
 * `/api/health/../agents` routes to `/api/agents`, so a raw prefix check
 * would let it past authentication.
 */
function isPublicRequest(req: IncomingMessage): boolean {
  const url = req.url || '';
  if (!url.startsWith('/')) return false;
  try {
    return new URL(`http://localhost${url}`).pathname === '/api/health';
  } catch {
    return false;
  }
}

function isHttpsRequest(req: IncomingMessage): boolean {
  return (req.socket as TLSSocket).encrypted === true
    || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

// Mint when the request carries no valid session cookie (covers the page load
// right after the native prompt) and refresh one nearing expiry; never mint
// while auth is disabled so toggling it back on grants nothing to bystanders.
// Desktop browsers resend the Basic header on every request, so Basic-authed
// requests usually also carry a fresh cookie — don't re-mint on every response.
function maybeSetSessionCookie(req: IncomingMessage, res: ServerResponse, auth: AuthResult) {
  if (!authEnabled || !auth.ok || auth.via === 'disabled') return;
  let expiresAt = auth.expiresAt;
  if (expiresAt === undefined) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME];
    if (token) {
      const verdict = verifySessionToken(token);
      if (verdict.valid) expiresAt = verdict.expiresAt;
    }
  }
  if (expiresAt !== undefined && expiresAt - Math.floor(Date.now() / 1000) >= SESSION_REFRESH_THRESHOLD_SECONDS) return;
  res.setHeader('Set-Cookie', buildSessionCookie(issueSessionToken(), { secure: isHttpsRequest(req) }));
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export function errorStatus(e: unknown): number {
  if (e && typeof e === 'object' && 'status' in e) {
    const status = (e as { status?: unknown }).status;
    if (typeof status === 'number' && status) return status;
  }
  return 400;
}

function sendAuthRequired(res: ServerResponse, req?: IncomingMessage) {
  // Clear a presented-but-invalid session cookie so the browser stops
  // resending it and falls back to the Basic prompt.
  if (req && parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME]) {
    res.setHeader('Set-Cookie', buildSessionCookie('', { secure: isHttpsRequest(req), clear: true }));
  }
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Tau"', 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unauthorized' }));
}

const HISTORY_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

// History responses are large JSON that compresses about 3.5 times at the
// fastest gzip level. A browser on a phone or remote link gets them that much
// sooner. Loopback browsers gain nothing, so they skip it.
const COMPRESS_MIN_BYTES = 32 * 1024;
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function shouldCompress(remoteAddress: string | undefined, acceptEncoding: string | string[] | undefined, bytes: number) {
  if (bytes < COMPRESS_MIN_BYTES || LOOPBACK_ADDRESSES.has(remoteAddress || '')) return false;
  return /\bgzip\b/.test(String(acceptEncoding || ''));
}

/** Send JSON, compressed when the browser is remote and accepts gzip. Compression runs off the main thread. */
function compressedJson(req: IncomingMessage, res: ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data);
  if (!shouldCompress(req.socket.remoteAddress, req.headers['accept-encoding'], Buffer.byteLength(body))) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
    return;
  }
  zlib.gzip(body, { level: 1 }, (error, zipped) => {
    if (error) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
    res.end(zipped);
  });
}

export function json(res: ServerResponse, status: number, data: unknown, extraHeaders: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(data));
}

function sendLifecycleError(res: ServerResponse, error: unknown) {
  if (error instanceof SessionOpenError) {
    return json(res, error.status, { error: error.message, ...(error.muxId ? { muxId: error.muxId } : {}) });
  }
  return json(res, errorStatus(error), { error: errorMessage(error) });
}

function readBody(req: IncomingMessage): Promise<RpcCommand> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > 20 * 1024 * 1024) reject(new Error('Request body too large'));
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) as RpcCommand : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

let lanUrl = '';
let tailscaleUrl = '';

/**
 * Validates programmatic spawn fields for live-session create and resume.
 *
 * These let an orchestration client run a managed runtime with its own
 * extensions, model flags, and environment. They do not widen the server's
 * blast radius: the API already starts `pi` in a caller-chosen directory and
 * prompts it, so it is an authenticated code-execution surface either way.
 * The checks exist to turn malformed input into a 400 instead of a confusing
 * spawn failure.
 */
function parseSpawnOverrides(body: RpcCommand): { args?: string[]; env?: Record<string, string>; sessionFile?: string } {
  const overrides: { args?: string[]; env?: Record<string, string>; sessionFile?: string } = {};
  if (body.args !== undefined) {
    if (!Array.isArray(body.args) || body.args.some((arg) => typeof arg !== 'string')) throw new Error('args must be an array of strings');
    assertNoSessionArgs(body.args as string[]);
    overrides.args = body.args as string[];
  }
  if (body.env !== undefined) {
    if (typeof body.env !== 'object' || body.env === null || Array.isArray(body.env)) throw new Error('env must be an object of string values');
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(body.env as Record<string, unknown>)) {
      if (typeof value !== 'string') throw new Error(`env.${key} must be a string`);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
      env[key] = value;
    }
    overrides.env = env;
  }
  // Reuse the session-directory containment check: a created session may adopt
  // an existing file (an orchestration worker writes its header before start),
  // but never a path outside Pi's session storage.
  if (body.sessionFile !== undefined) overrides.sessionFile = resolveSessionFile(String(body.sessionFile));
  return overrides;
}

/**
 * Another Pi process (a terminal orchestration target) is appending to this
 * file; opening it would make Tau a second writer. A pimux-shared file is not
 * refused here: opening it attaches.
 */
function terminalOwnerRefusal(file: string, _force: boolean) {
  const claim = lookupClaim(file);
  if (claim && (claim.owner.kind !== 'rpc' || claim.owner.protocol !== 2)) {
    return { error: 'Session has a live or uncertain nonattachable owner. Force cannot override a writer claim.' };
  }
  if (claim?.owner.kind === 'rpc') return null;
  const owner = sessionOwner(file);
  return owner ? { error: `Session is running as ${owner.name} on ${owner.host}. Follow it read-only or stop that agent first.`, owner } : null;
}

function updateLiveSessionName(session: PiRpcSession | null | undefined, name: string) {
  if (!session) return;
  session.sessionName = name;
  session.titleSet = true;
  liveManager.broadcast({ type: 'event', sessionId: session.id, event: { type: 'session_name', name } });
  liveManager.broadcastUpdated(session.id);
}

function openUrl(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return Promise.reject(new Error('Invalid URL'));
  if (process.platform === 'win32') {
    spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' }).unref();
    return Promise.resolve();
  }
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  return new Promise<void>((resolve, reject) => {
    execFile(opener, [url], (err) => err ? reject(err) : resolve());
  });
}

async function handleRpcCommand(command: RpcCommand): Promise<RpcResponse> {
  const id = command.id;
  const cmd = command.type;
  const success = (data?: unknown): RpcResponse => ({ type: 'response', command: cmd, success: true, id, ...(data !== undefined ? { data } : {}) });
  const isInstruction = cmd === 'prompt' || cmd === 'steer' || cmd === 'follow_up';
  const error = (message: string): RpcResponse => ({ type: 'response', command: cmd, success: false, error: message, id, ...(isInstruction ? { delivery: 'rejected' } : {}) });

  // Backend-local commands do not require a live runtime connection.
  if (cmd === 'get_auth') return success({ configured: AUTH_CONFIGURED, enabled: authEnabled });
  if (cmd === 'set_auth') {
    if (typeof command.enabled !== 'boolean') return error('enabled must be true or false');
    if (!command.enabled && !loopbackOnly) return error('Authentication is required outside loopback.');
    if (AUTH_OVERRIDE !== undefined) return error('Authentication is set by TAU_AUTH_ENABLED.');
    if (!AUTH_CONFIGURED) return error('No credentials configured. Set TAU_USER and TAU_PASS, or tau.user and tau.pass in settings.json.');
    if (!saveTauSetting('authEnabled', command.enabled)) return error('Could not save Tau authentication settings.');
    const wasEnabled = authEnabled;
    authEnabled = command.enabled;
    liveManager.broadcast({ type: 'event', event: { type: 'auth_changed', enabled: authEnabled } });
    if (!wasEnabled && authEnabled) {
      const timer = setTimeout(() => {
        for (const client of [...liveManager.clients, ...voiceWss.clients]) {
          try { client.close(4001, 'Authentication enabled'); } catch {}
        }
      }, 25);
      timer.unref?.();
    }
    return success({ enabled: authEnabled });
  }
  // Before creating an agent there is no owning runtime to ask. Never use the
  // launch host's catalog as a substitute for an existing agent's catalog.
  if (cmd === 'get_available_models' && !command.sessionId) return success({ models: await getAvailableModels() });
  const session = command.sessionId ? liveManager.get(command.sessionId) : null;
  let requestContext: ReturnType<PiRpcSession['browserInputContext']> | undefined;
  if (session && !isReadOnlyCommand(String(cmd)) && cmd !== 'live_session_snapshot_request') {
    try { requestContext = session.browserInputContext(command); }
    catch (cause) { return error(errorMessage(cause)); }
    command = { ...command, pimuxContext: requestContext.runtimeContext };
  }
  if (cmd === 'set_session_name') {
    const name = (command.name || '').trim();
    if (!name) return error('Name cannot be empty');
    if (!session) return error('Live session not found');
    // A live Pi writes its own file: rename through it, so its state and
    // every frontend sharing it agree, and the file has one writer.
    const renameContext = requestContext?.runtimeContext ?? session.attachment?.inputContext;
    try {
      const resp = await session.send({ type: 'set_session_name', name,
        ...(renameContext ? { pimuxContext: renameContext } : {}) }, { timeoutMs: 10000 });
      if (resp.success === false) return error(String(resp.error || 'Pi refused the rename'));
    } catch (e) { return error(errorMessage(e)); }
    if (renameContext && session.attachment?.inputContext?.contextId === renameContext.contextId
      && session.sessionFile === renameContext.sessionFile) updateLiveSessionName(session, name);
    return success({ name });
  }

  // Backend-local: move the session-tree leaf to an earlier entry (pi's
  // native RPC protocol has no leaf-move command, so tau drives pimux's
  // /pimux-tree-navigate extension command in-process — see src/server/tree.ts).
  if (cmd === 'navigate_tree') {
    if (!session) return error('Live session not found');
    if (!session.capabilities.navigateTree) return error('This runtime does not advertise the tree navigation command.');
    const entryId = typeof command.entryId === 'string' ? command.entryId.trim() : '';
    if (!entryId) return error('entryId required');
    try {
      const result = await navigateTree(session, entryId, requestContext?.runtimeContext);
      return success({ editorText: result.editorText });
    } catch (e) { return error(errorMessage(e)); }
  }
  if (cmd === 'export_html') {
    try {
      if (!session) throw new Error('Live session not found');
      const sf = session.sessionFile;
      if (!sf) throw new Error('No session file to export yet');
      const output = resolveExportOutputPath(command.outputPath || sf.replace(/\.jsonl$/, '.html'), sf);
      const result = await exportSession(sf, output, session, requestContext?.runtimeContext);
      return success({ path: result });
    } catch (e) { return error(errorMessage(e)); }
  }

  if (!session) return error('No active Tau session. Create or select an in-page Tau tab first.');

  if (cmd === 'get_available_models' || cmd === 'set_model') {
    if (!session.attachment?.supportsModels) return error('This runtime does not support live model control.');
    try {
      const response = await session.send(cmd === 'get_available_models'
        ? { type: 'pimux_models', action: 'list', id }
        : { type: 'pimux_models', action: 'set', id, provider: command.provider, modelId: command.modelId,
          pimuxContext: requestContext!.runtimeContext });
      if (response.success === true) return success(response.data);
      const detail = isRecord(response.error) ? response.error.message : response.error;
      return { ...error(String(detail || 'Model request failed')), delivery: response.delivery };
    } catch (cause) { return error(errorMessage(cause)); }
  }
  if (cmd === 'get_state') {
    if (command.refresh === true) {
      // Prompt acceptance precedes agent_start. Queue reconciliation needs a
      // fresh Pi probe, not the possibly still-idle event cache below.
      try {
        const response = await session.send({ type: 'get_state' }, { timeoutMs: 5000 });
        if (response.success !== true) return error(String(response.error || 'Pi state probe failed'));
        return success(response.data);
      } catch (e) { return error(errorMessage(e)); }
    }
    return success({
      model: session.model,
      thinkingLevel: session.thinkingLevel,
      isStreaming: session.isStreaming,
      sessionFile: session.sessionFile,
      sessionName: session.sessionName,
      isCompacting: !!session.compaction,
      ...(session.autoCompactionEnabled !== null ? { autoCompactionEnabled: session.autoCompactionEnabled } : {}),
    });
  }
  if (cmd === 'get_messages') return success({ entries: session.entries });
  if (cmd === 'live_session_snapshot_request') return { type: 'live_session_snapshot', sessionId: session.id, ...await session.snapshot() };
  if (cmd === 'set_auto_compaction' && typeof command.enabled !== 'boolean') return error('enabled must be true or false');
  // Pi's compact aborts a running reply before it compacts. Never throw a
  // reply away from a click; the user can stop the reply first.
  if (cmd === 'compact' && session.compaction) return { ...error('Compaction is already running.'), compactionStarted: false };
  if (cmd === 'compact' && session.isStreaming) return { ...error('Wait for the reply to finish, or stop it first.'), compactionStarted: false };

  // Session replacement moves every frontend of the same runtime.
  const native = new Set(['new_session', 'prompt', 'steer', 'follow_up', 'abort', 'compact', 'set_auto_compaction', 'cycle_model', 'set_thinking_level', 'cycle_thinking_level', 'get_session_stats', 'get_tree', 'get_entries', 'clear_queue', 'extension_ui_response']);
  if (!native.has(cmd ?? '') && !isReadOnlyCommand(String(cmd))) return error(`Unknown command: ${cmd}`);
  if (cmd === 'clear_queue' && command.confirmGlobal !== true) return error('Clearing the queue removes input from every frontend; explicit confirmation is required.');

  // While navigate_tree is moving the child's leaf (pi's stdin loop does not
  // serialize a new prompt behind a running extension command), a prompt
  // racing into that window could land its entries on the branch being
  // abandoned. Refuse it up front so the user's turn is never dropped or
  // misplaced without them knowing.
  if ((cmd === 'prompt' || cmd === 'steer' || cmd === 'follow_up') && isTreeNavigationInProgress(session.id)) {
    return error('A session-tree navigation is in progress for this session; wait a moment and send again');
  }

  // `set_thinking_level` is forwarded to pi but pi's response carries no
  // level/thinkingLevel field, so updateStateFromResponse would never update
  // session.thinkingLevel — yet touch(true)->broadcastUpdated would echo the
  // stale level to all clients (reverting a client's just-set optimistic
  // level). Record the level optimistically here and restore on pi failure.
  const requestIsCurrent = () => !!requestContext && requestContext.file === session.sessionFile
    && requestContext.runtimeContext.contextId === session.attachment?.inputContext?.contextId;
  const isSetThinkingLevel = cmd === 'set_thinking_level';
  let prevThinkingLevel: string | null = null;
  if (isSetThinkingLevel) {
    prevThinkingLevel = session.thinkingLevel;
    if (command.level) session.thinkingLevel = command.level;
  }

  // Pi answers compact only after the summary is written, which can take
  // minutes on a large context with a slow model.
  const timeoutMs = cmd === 'prompt' ? 10000 : cmd === 'compact' ? 10 * 60000 : 60000;
  const compactionRevision = session.compactionRevision;
  // Tells the browser whether Pi began compacting. Once it has, the
  // compaction events report the outcome, so a failed reply is not a
  // second error.
  const compactionStarted = () => (cmd === 'compact' ? { compactionStarted: session.compactionRevision !== compactionRevision } : {});
  try {
    const resp = cmd === 'extension_ui_response'
      ? await session.respondToDialog(command)
      : cmd === 'abort'
        ? await session.abort(command)
        : await session.send(command, { timeoutMs });
    if (isSetThinkingLevel && resp.success === false && prevThinkingLevel !== null && requestIsCurrent()) {
      session.thinkingLevel = prevThinkingLevel;
    }
    if (cmd === 'clear_queue' && resp.success !== false && requestIsCurrent()) liveManager.broadcast({ type: 'event', sessionId: session.id, event: { type: 'shared_queue_cleared' } });
    if (cmd === 'set_auto_compaction' && resp.success !== false) {
      session.autoCompactionEnabled = command.enabled === true;
      return success({ enabled: session.autoCompactionEnabled });
    }
    return { ...resp, success: resp.success !== false, ...(cmd === 'clear_queue' ? { recoveryContext: requestContext } : {}), ...(isInstruction && resp.success === false ? { delivery: resp.delivery === 'uncertain' ? 'uncertain' : 'rejected' } : {}), ...compactionStarted() };
  } catch (e) {
    if (isSetThinkingLevel && prevThinkingLevel !== null && requestIsCurrent()) session.thinkingLevel = prevThinkingLevel;
    // A timeout or broken transport does not establish whether Pi ran a prompt.
    return { ...error(errorMessage(e)), ...(isInstruction ? { delivery: e instanceof InputContextError ? 'rejected' : 'uncertain' } : {}), ...compactionStarted() };
  }
}

function serveStaticFile(req: IncomingMessage, res: ServerResponse) {
  if (!allowedRequestHost(req)) return json(res, 403, { error: 'Host not allowed' });
  const target = req.url || '/';
  let urlPath = target.split('?', 1)[0];
  if (authEnabled && target === '/login' && req.method === 'POST') {
    return submitLogin(req, res, isHttpsRequest(req));
  }
  const auth = checkAuth(req);
  if (!auth.ok && !isPublicRequest(req)) {
    if ((req.method === 'GET' || req.method === 'HEAD') && (urlPath === '/' || urlPath === '/index.html')) {
      return sendLoginPage(res);
    }
    return sendAuthRequired(res, req);
  }
  maybeSetSessionCookie(req, res, auth);
  if (target.startsWith('/api/')) return handleApiRoute(req, res, target);
  if (urlPath === '/') urlPath = '/index.html';
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(urlPath);
  } catch {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }
  const staticRoot = path.resolve(STATIC_DIR);
  const filePath = path.resolve(path.join(staticRoot, decodedPath));
  if (filePath !== staticRoot && !filePath.startsWith(staticRoot + path.sep)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.stat(filePath, (err: NodeJS.ErrnoException | null, stats: Stats) => {
    if (err || !stats.isFile()) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': (MIME_TYPES as Record<string, string>)[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
}

function isAllowedApiOrigin(req: IncomingMessage) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function setCorsForAllowedOrigin(req: IncomingMessage, res: ServerResponse) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (!isAllowedApiOrigin(req)) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  return true;
}

function handleApiRoute(req: IncomingMessage, res: ServerResponse, urlPath: string) {
  const originAllowed = setCorsForAllowedOrigin(req, res);
  if (req.method === 'OPTIONS') {
    if (!originAllowed) return json(res, 403, { error: 'Origin not allowed' });
    res.writeHead(200);
    res.end();
    return;
  }
  if (!originAllowed) return json(res, 403, { error: 'Origin not allowed' });

  const parsed = new URL(`http://localhost${req.url}`);
  const cleanPath = parsed.pathname;

  if (cleanPath === '/api/health') return json(res, 200, { status: 'ok', role: 'rpc-session-manager', liveSessionCount: liveManager.sessions.size, lanUrl, tailscaleUrl: tailscaleUrl || undefined, platform: process.platform });
  if (cleanPath === '/api/live-sessions' && req.method === 'GET') return json(res, 200, { sessions: liveManager.list() });
  if (cleanPath === '/api/live-sessions' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      if (!body.cwd) return json(res, 400, { error: 'cwd required' });
      let overrides: { args?: string[]; env?: Record<string, string>; sessionFile?: string };
      try {
        overrides = parseSpawnOverrides(body);
      } catch (e) { return json(res, 400, { error: errorMessage(e) }); }
      const refusal = overrides.sessionFile ? terminalOwnerRefusal(overrides.sessionFile, body.force === true) : null;
      if (refusal) return json(res, 409, refusal);
      try {
        const session = await liveManager.create({ cwd: body.cwd, model: body.model || '', ...overrides });
        liveManager.awaitViewer(session.id);
        json(res, 200, { session: session.metadata(), ...(session.attachment ? { attached: true } : {}) });
      } catch (e) { sendLifecycleError(res, e); }
    }).catch((e) => json(res, 400, { error: errorMessage(e) }));
    return;
  }
  if (cleanPath === '/api/live-sessions/resume' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      if (!body.filePath || typeof body.filePath !== 'string') return json(res, 400, { error: 'filePath required' });
      const rejectBeforeSpawn = (message: string) => json(res, 400, { error: message });
      let resolvedFile: string;
      let overrides: { args?: string[]; env?: Record<string, string> };
      try {
        resolvedFile = resolveSessionFile(body.filePath);
        overrides = parseSpawnOverrides({ args: body.args, env: body.env });
        if (body.model !== undefined && typeof body.model !== 'string') throw new Error('model must be a string');
        if (body.refresh !== undefined && typeof body.refresh !== 'boolean') throw new Error('refresh must be a boolean');
      } catch (e) { return rejectBeforeSpawn(errorMessage(e)); }
      const existing = liveManager.findBySessionFile(resolvedFile);
      if (existing && !existing.exited && body.refresh !== true && !existing.terminating && !liveManager.hasTerminatingResume(resolvedFile) && !liveManager.hasPendingResume(resolvedFile)) {
        liveManager.awaitViewer(existing.id);
        return json(res, 200, { session: existing.metadata(), reused: true, started: false, ...(existing.attachment ? { attached: true } : {}) });
      }
      const refusal = terminalOwnerRefusal(resolvedFile, body.force === true);
      if (refusal) return json(res, 409, refusal);
      let cwd: string | null = normalizeSessionCwd(body.cwd);
      if (!cwd) cwd = readSessionHeaderCwd(resolvedFile);
      try {
        if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
          return rejectBeforeSpawn('Cannot resume session because its project directory no longer exists');
        }
      } catch (e) { return rejectBeforeSpawn(errorMessage(e)); }
      const entries = readSessionEntries(resolvedFile) as JsonRecord[];
      const sessionName = deriveSessionNameFromEntries(entries);
      try {
        const { session, started, refreshed } = await liveManager.resume({ sessionFile: resolvedFile, cwd, model: body.model || '', entries, sessionName, refresh: body.refresh === true, ...overrides });
        liveManager.awaitViewer(session.id);
        json(res, 200, { session: session.metadata(), started, ...(!started ? { reused: true } : {}), ...(refreshed ? { refreshed: true } : {}), ...(session.attachment ? { attached: true } : {}) });
      } catch (e) { sendLifecycleError(res, e); }
    }).catch((e) => json(res, 400, { error: errorMessage(e) }));
    return;
  }
  // Attach to a pimux-shared Pi by its id (the agent overview, /switch tau).
  if (cleanPath === '/api/live-sessions/attach' && req.method === 'POST') {
    readBody(req).then(async (body) => {
      if (typeof body.muxId !== 'string' || !body.muxId) return json(res, 400, { error: 'muxId required' });
      try {
        const { session, started } = await liveManager.attachById(body.muxId);
        liveManager.awaitViewer(session.id);
        json(res, 200, { session: session.metadata(), attached: true, started, ...(!started ? { reused: true } : {}) });
      } catch (e) { sendLifecycleError(res, e); }
    }).catch((e) => json(res, 400, { error: errorMessage(e) }));
    return;
  }
  if (cleanPath === '/api/agents' && req.method === 'GET') return json(res, 200, { agents: agentOverview.list() });
  const closePanel = cleanPath.match(/^\/api\/panels\/([^/]+)\/close$/);
  if (closePanel && req.method === 'POST') {
    readBody(req).then(async body => {
      const panelId = decodeURIComponent(closePanel[1]);
      if (typeof body.name !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(body.name)
          || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/.test(panelId)) {
        return json(res, 400, { error: 'A valid panel name and control identity are required.' });
      }
      try {
        await closeRegisteredEmacsPanel(body.name, panelId);
        return json(res, 200, { panelId, state: 'closed' });
      } catch (error) { return sendLifecycleError(res, error); }
      finally { agentOverview.refresh(); }
    }).catch(error => json(res, 400, { error: errorMessage(error) }));
    return;
  }
  const stopAgent = cleanPath.match(/^\/api\/agents\/([^/]+)\/stop$/);
  if (stopAgent && req.method === 'POST') {
    readBody(req).then(async body => {
      if (body.operationId !== undefined && typeof body.operationId !== 'string') return json(res, 400, { error: 'operationId must be a string' });
      try {
        const muxId = decodeURIComponent(stopAgent[1]);
        const known = [...liveManager.sessions.values()].find(view => view.attachment?.muxId === muxId);
        const env = known?.attachment ? { ...process.env, PIMUX_DIR: path.dirname(known.attachment.socket) } : process.env;
        const task = readWorkerTask(muxId, env);
        if (task?.state === 'failed') throw new SessionOpenError(`Worker task cleanup failed: ${task.error}`, 503, muxId);
        const session = known ?? (pimuxEntryById(muxId, env.PIMUX_DIR)?.placement === 'worker'
          ? (await liveManager.attachById(muxId)).session : undefined);
        if (!session && task?.state === 'pending') throw new SessionOpenError('Worker task cleanup is still pending; no cancellation connection is available', 503, muxId);
        const receipt = session ? await session.stop(body.operationId as string | undefined)
          : await liveManager.runtime.stop(muxId, { operationId: body.operationId as string | undefined, env });
        for (const view of liveManager.sessions.values()) {
          if (view.attachment?.muxId === muxId) await liveManager.delete(view.id, 'closed_by_user', receipt);
        }
        const report = session?.attachedOwner?.placement === 'worker' || task ? workerExitReport(session?.attachment?.exit ?? receipt) : undefined;
        return json(res, 200, { receipt, ...report });
      } catch (error) { return sendLifecycleError(res, error); }
    }).catch(error => json(res, 400, { error: errorMessage(error) }));
    return;
  }
  const imageMatch = cleanPath.match(/^\/api\/live-sessions\/([^/]+)\/images\/(\d+)\/(\d+)\/(\d+)$/);
  if (imageMatch && req.method === 'GET') {
    let id;
    try {
      id = decodeURIComponent(imageMatch[1]);
    } catch {
      return json(res, 400, { error: 'Malformed live session id' });
    }
    const image = liveManager.get(id)?.historyImage(Number(imageMatch[2]), Number(imageMatch[3]), Number(imageMatch[4]));
    if (!image) return json(res, 404, { error: 'Image not found' });
    const bytes = Buffer.from(image.data, 'base64');
    res.writeHead(200, {
      // Only raster types are served as images. Anything else, SVG included,
      // could run script when opened directly from this origin.
      'Content-Type': HISTORY_IMAGE_TYPES.has(image.mimeType) ? image.mimeType : 'application/octet-stream',
      'Content-Length': bytes.length,
      'X-Content-Type-Options': 'nosniff',
      // A link names one history version, so its image never changes.
      'Cache-Control': 'private, max-age=31536000, immutable',
    });
    res.end(bytes);
    return;
  }
  const liveMatch = cleanPath.match(/^\/api\/live-sessions\/([^/]+)(?:\/(snapshot|stop))?$/);
  if (liveMatch) {
    let id;
    try {
      id = decodeURIComponent(liveMatch[1]);
    } catch {
      return json(res, 400, { error: 'Malformed live session id' });
    }
    const session = liveManager.get(id);
    if (!session) return json(res, 404, { error: 'Live session not found' });
    const subRoute = liveMatch[2];
    if (subRoute === 'stop' && req.method === 'POST') {
      readBody(req).then(async body => {
        if (body.operationId !== undefined && typeof body.operationId !== 'string') return json(res, 400, { error: 'operationId must be a string' });
        try {
          const receipt = await session.stop(body.operationId as string | undefined);
          await liveManager.delete(id, 'closed_by_user', receipt);
          const report = session.attachedOwner?.placement === 'worker' ? workerExitReport(session.attachment?.exit ?? receipt) : undefined;
          return json(res, 200, { receipt, ...report });
        }
        catch (error) { return sendLifecycleError(res, error); }
      }).catch(error => json(res, 400, { error: errorMessage(error) }));
      return;
    }
    if (subRoute === 'snapshot' && req.method === 'GET') {
      session.snapshot().then(
        (snapshot) => compressedJson(req, res, 200, snapshot),
        (error: unknown) => json(res, 503, { error: errorMessage(error) }),
      );
      return;
    }
    if (!subRoute && req.method === 'DELETE') {
      liveManager.disconnect(session).then(() => json(res, 200, { success: true }), error => sendLifecycleError(res, error));
      return;
    }
  }

  if (cleanPath === '/api/complete/directories' && req.method === 'GET') {
    const items = completeDirectories(parsed.searchParams.get('prefix') || '', TAU_SETTINGS.projectsDir || USER_HOME);
    return json(res, 200, { items });
  }
  if (cleanPath === '/api/sessions' && req.method === 'GET') return serveProjectSummaries(res);
  if (cleanPath === '/api/rpc' && req.method === 'POST') {
    readBody(req).then((body) => handleRpcCommand(body).then((resp) => json(res, 200, resp))).catch((e) => json(res, 400, { error: errorMessage(e) }));
    return;
  }
  const projectMatch = cleanPath.match(/^\/api\/sessions\/([^/]+)$/);
  if (projectMatch && req.method === 'GET') return serveProjectSessions(res, projectMatch[1]);
  const sessionMatch = cleanPath.match(/^\/api\/sessions\/([^/]+)\/([^/]+)$/);
  if (sessionMatch && req.method === 'GET') return serveSessionFile(res, sessionMatch[1], sessionMatch[2], parsed.searchParams.get('since'));

  json(res, 404, { error: 'Not found' });
}

function computeUrls(port: number) {
  let localIp = loopbackOnly ? (HOST === '::1' ? '[::1]' : HOST) : 'localhost';
  let tailscaleIp = '';
  if (!loopbackOnly) {
    const nets = os.networkInterfaces();
    for (const name of ['en0', 'en1', 'wlan0', 'eth0']) {
      for (const net of nets[name] || []) if (net.family === 'IPv4' && !net.internal) { localIp = net.address; break; }
      if (localIp !== 'localhost') break;
    }
    if (localIp === 'localhost') {
      outer: for (const name of Object.keys(nets)) {
        if (/^(bridge|utun|lo)/.test(name)) continue;
        for (const net of nets[name] || []) if (net.family === 'IPv4' && !net.internal) { localIp = net.address; break outer; }
      }
    }
    for (const name of Object.keys(nets)) for (const net of nets[name] || []) if (net.family === 'IPv4' && !net.internal && net.address.startsWith('100.')) tailscaleIp = net.address;
  }
  lanUrl = `https://${localIp}:${port}`;
  tailscaleUrl = tailscaleIp ? `https://${tailscaleIp}:${port}` : '';
}

// Plain HTTP serves only loopback; the network listener
// is HTTPS, created at startup once its certificate exists. Both share handlers.
const server = http.createServer(serveStaticFile);
let httpsServer: https.Server | null = null;
const wss = new WebSocketServer({ noServer: true });
const agentOverview = new AgentOverview({
  viewed: () => liveManager.viewedMuxIds(),
  onChange: (agents) => liveManager.broadcast({ type: 'pimux_agents', agents }),
});
liveManager.onAttachmentsChanged = () => agentOverview.refresh();
liveManager.onViewsChanged = () => agentOverview.refresh();
const voiceWss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
let voiceConfiguration = configuredVoice(PI_AGENT_DIR);

function handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer) {
  if (!allowedRequestHost(request) || !isAllowedApiOrigin(request)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  if (authEnabled && !checkAuth(request).ok) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="Tau"\r\n\r\n');
    socket.destroy();
    return;
  }
  if (request.url === '/ws') wss.handleUpgrade(request, socket, head, (ws: TauWs) => wss.emit('connection', ws, request));
  else if (request.url === VOICE_PATH) voiceWss.handleUpgrade(request, socket, head, (ws) => handleVoiceSocket(ws, voiceConfiguration));
  else socket.destroy();
}
server.on('upgrade', handleUpgrade);

wss.on('connection', (ws: TauWs) => {
  liveManager.addClient(ws);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.send(JSON.stringify({ type: 'state', liveSessions: liveManager.list(), agents: agentOverview.list() }));
  ws.on('message', async (data: Buffer) => {
    try {
      const command = JSON.parse(data.toString());
      // Which live session this browser shows; it has no response.
      if (command?.type === 'view') {
        if (command.sessionId !== null && typeof command.sessionId !== 'string') throw new Error('view sessionId must be a string or null');
        liveManager.view(ws, command.sessionId);
        return;
      }
      const resp = await handleRpcCommand(command);
      liveManager.sendTo(ws, JSON.stringify(resp));
    } catch (e) {
      liveManager.sendTo(ws, JSON.stringify({ type: 'error', message: errorMessage(e) }));
    }
  });
  ws.on('close', () => liveManager.removeClient(ws));
  ws.on('error', () => liveManager.removeClient(ws));
});

setInterval(() => {
  for (const client of liveManager.clients) {
    if (client.readyState !== WebSocket.OPEN) { liveManager.removeClient(client); continue; }
    if (!client.isAlive) { try { client.terminate(); } catch {} liveManager.removeClient(client); continue; }
    client.isAlive = false;
    try { client.ping(); } catch {}
  }
}, 20000).unref();

function listenOn(target: http.Server, port: number, host: string): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    const onListening = () => {
      target.off('error', onError);
      resolve(target.address() as AddressInfo);
    };
    const onError = (error: Error) => {
      target.off('listening', onListening);
      reject(error);
    };
    target.once('error', onError);
    target.listen(port, host, onListening);
  });
}

async function listen(soundRuntime?: SoundRuntime) {
  voiceConfiguration = configuredVoice(PI_AGENT_DIR, soundRuntime);
  if (!loopbackOnly && !authEnabled) throw new Error('Authentication is required outside loopback.');
  if (authEnabled) requireTauCredentials(TAU_SETTINGS);
  const tls = ensureTlsCertificate(TLS_DIR, TAU_SETTINGS.hostnames);
  httpsServer = https.createServer({ key: tls.key, cert: tls.cert }, serveStaticFile);
  httpsServer.on('upgrade', handleUpgrade);
  const local = await listenOn(server, HTTP_PORT, '127.0.0.1');
  const secure = await listenOn(httpsServer, PORT, HOST).catch(error => {
    // An unsuccessful startup must not leave the plain listener running.
    server.close();
    throw error;
  });
  computeUrls(secure.port);
  publishBrowserUrls(secure.port, secure.address);
  agentOverview.start();
  console.log(`[Tau] Server running on ${lanUrl}${tailscaleUrl ? `  •  Tailscale: ${tailscaleUrl}` : ''}`);
  console.log(`[Tau] Local orchestration (loopback HTTP): http://127.0.0.1:${local.port}`);
  console.log(`[Tau] TLS certificate authority (trust it once on other devices): ${tls.caFile}`);
  console.log(`[Tau] Static assets: ${STATIC_DIR}`);
  console.log(`[Tau] Pi command: ${PI_COMMAND}`);
  if (ARGS.open) openUrl(lanUrl).catch(() => {});
}

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[Tau] Shutting down (${signal}); disconnecting ${liveManager.sessions.size} agent view(s)...`);
  try { wss.close(); } catch {}
  agentOverview.stop();
  try { voiceWss.close(); } catch {}
  unpublishBrowserUrls();
  let exitCode = 0;
  try { await liveManager.shutdown(); }
  catch (error) {
    exitCode = 1;
    console.error(`[Tau] View disconnect failed: ${errorMessage(error)}`);
  }
  httpsServer?.close();
  server.close(() => process.exit(exitCode));
  setTimeout(() => process.exit(exitCode), 2500).unref();
}
/** Start the foreground server, optionally with an operator-supplied speech runtime. */
function startCli(soundRuntime?: SoundRuntime) {
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('exit', () => {
    unpublishBrowserUrls();
    for (const session of liveManager.sessions.values()) {
      session.transport?.abandon();
    }
  });
  process.on('uncaughtException', (err) => { console.error(err); shutdown('uncaughtException'); });
  process.on('unhandledRejection', (err) => { console.error(err); });
  listen(soundRuntime).catch((err: unknown) => {
    console.error(`[Tau] Failed to start: ${errorMessage(err)}`);
    process.exit(1);
  });
}

// Test-only helper to reset module-level auth state between cases.
function _setAuthForTest(enabled: boolean) { authEnabled = !!enabled; }

// Test-only helpers for the session-cookie flow: mutate the live credentials
// (tokens embed a credential fingerprint) and mint tokens at chosen expiries.
function _setCredentialsForTest(user: string, pass: string) { TAU_SETTINGS.user = user; TAU_SETTINGS.pass = pass; }
function _issueSessionTokenForTest(expiresAtSeconds?: number) { return issueSessionToken(expiresAtSeconds); }

export {
  parseArgs,
  expandHome,
  loadTauSettings,
  resolvePiCommand,
  PI_COMMAND,
  modelLabel,
  normalizeModel,
  parseModelSpecToModel,
  parsePiListModels,
  getAvailableModels,
  makeId,
  PiRpcSession,
  LiveSessionManager,
  liveManager,
  resolveSessionFile,
  updateLiveSessionName,
  isWithinPath,
  resolveExportOutputPath,
  openUrl,
  handleRpcCommand,
  entriesById,
  isTreeNavigationInProgress,
  leafDescendsFrom,
  navigateTree,
  pathFromRoot,
  selectNavigationTarget,
  parseSpawnOverrides,
  sessionOwner,
  sessionOwners,
  isAllowedApiOrigin,
  setCorsForAllowedOrigin,
  handleApiRoute,
  shouldCompress,
  serveStaticFile,
  server,
  wss,
  computeUrls,
  listen,
  startCli,
  SESSIONS_DIR,
  PI_AGENT_DIR,
  checkAuth,
  SESSION_COOKIE_NAME,
  _setAuthForTest,
  _setCredentialsForTest,
  _issueSessionTokenForTest,
  agentOverview,
  _setExecFileForTest,
  _clearModelListCacheForTest,
};
