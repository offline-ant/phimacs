import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isIPv4 } from 'node:net';
import { fileURLToPath } from 'node:url';
import { resolveHost, verifyHost, type HostIdentity } from '@phimacs/pimux/host-identity';

import type { TauArgs, TauSettings, TauSettingsFile } from './types.js';

export function parseArgs(argv: string[]): TauArgs {
  const out: TauArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (key === 'open') { out.open = true; continue; }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i++; }
  }
  return out;
}

export const ARGS = parseArgs(process.argv.slice(2));
export const USER_HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
export const PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(USER_HOME, '.pi', 'agent');
export const SESSIONS_DIR = process.env.PI_CODING_AGENT_SESSION_DIR || path.join(PI_AGENT_DIR, 'sessions');

export function expandHome(p: string) {
  if (!p || typeof p !== 'string') return p;
  return p.startsWith('~') ? path.join(USER_HOME, p.slice(1)) : p;
}

// Operations use the global Pi on PATH (or PHIMACS_PI); --pi-command and
// TAU_PI_COMMAND select another explicitly validated executable.
export function resolvePiCommand(args: TauArgs, env: NodeJS.ProcessEnv = process.env): string {
  const flag = typeof args['pi-command'] === 'string' ? args['pi-command'].trim() : '';
  const command = flag || (env.TAU_PI_COMMAND || '').trim();
  return command ? verifyHost(expandHome(command)).executable : resolveHost(env).executable;
}

export const PI_COMMAND = resolvePiCommand(ARGS);
/** Reread on every launch/metadata/export operation, so a global Pi update is reported. */
export function runtimeHost(): HostIdentity {
  return verifyHost(PI_COMMAND);
}
export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || (isIPv4(host) && host.startsWith('127.'));
}

const authEnv = process.env.TAU_AUTH_ENABLED;
if (authEnv !== undefined && authEnv !== 'true' && authEnv !== 'false') {
  throw new Error('TAU_AUTH_ENABLED must be true or false.');
}
export const AUTH_OVERRIDE = authEnv === undefined ? undefined : authEnv === 'true';

export function loadTauSettings(): TauSettings {
  let settings: TauSettingsFile['tau'] = {};
  try {
    const settingsPath = path.join(PI_AGENT_DIR, 'settings.json');
    settings = ((JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as TauSettingsFile).tau || {});
  } catch (error) {
    // A broken or unreadable settings file must not turn authentication off.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error('Could not read Pi settings for Tau.');
    }
  }
  const host = ARGS.host ?? process.env.TAU_HOST ?? settings.host ?? '127.0.0.1';
  const user = process.env.TAU_USER ?? settings.user;
  const pass = process.env.TAU_PASS ?? settings.pass;
  if (AUTH_OVERRIDE === undefined && settings.authEnabled !== undefined && typeof settings.authEnabled !== 'boolean') {
    throw new Error('tau.authEnabled must be true or false.');
  }
  return {
    port: parsePort(ARGS.port ?? process.env.TAU_PORT ?? settings.port ?? 3443, 'HTTPS'),
    httpPort: parsePort(ARGS['http-port'] ?? process.env.TAU_HTTP_PORT ?? settings.httpPort ?? 3001, 'HTTP'),
    // Don't resolve a hostname when relying on a loopback-only bind.
    host: host === 'localhost' ? '127.0.0.1' : host,
    hostnames: process.env.TAU_HOSTNAMES !== undefined
      ? process.env.TAU_HOSTNAMES.split(',').map((name) => name.trim()).filter(Boolean)
      : settings.hostnames ?? [],
    user: user ?? '',
    pass: pass ?? '',
    authEnabled: AUTH_OVERRIDE ?? settings.authEnabled ?? (!isLoopbackHost(host) || user !== undefined || pass !== undefined),
    cookieSecret: process.env.TAU_COOKIE_SECRET || settings.cookieSecret || '',
    projectsDir: expandHome(ARGS['projects-dir'] || process.env.TAU_PROJECTS_DIR || settings.projectsDir || ''),
  };
}

function parsePort(value: string | number, protocol: string): number {
  if (!/^\d{1,5}$/.test(String(value)) || Number(value) > 65535) {
    throw new Error(`Tau ${protocol} port must be an integer from 0 to 65535.`);
  }
  return Number(value);
}

export const TAU_SETTINGS = loadTauSettings();
export const AUTH_CONFIGURED = typeof TAU_SETTINGS.user === 'string' && TAU_SETTINGS.user.length > 0
  && typeof TAU_SETTINGS.pass === 'string' && TAU_SETTINGS.pass.length > 0;

/** Validate before opening either listener; missing credentials never disable auth. */
export function requireTauCredentials(settings: Pick<TauSettings, 'user' | 'pass'>): void {
  if (typeof settings.user !== 'string' || !settings.user || typeof settings.pass !== 'string' || !settings.pass) {
    throw new Error('Authentication requires a nonempty username and password. Set TAU_USER and TAU_PASS, or tau.user and tau.pass in settings.json.');
  }
}
/** HTTPS port: the only listener reachable from the network. */
export const PORT = TAU_SETTINGS.port;
export const HOST = TAU_SETTINGS.host;
/** Plain HTTP port, always bound to loopback. */
export const HTTP_PORT = TAU_SETTINGS.httpPort;
export const TLS_DIR = path.join(PI_AGENT_DIR, 'tau', 'tls');
export const STATIC_DIR = process.env.TAU_STATIC_DIR || findPublicDir();

function findPublicDir() {
  const candidates: string[] = [];
  const add = (p: string) => candidates.push(path.resolve(p));
  add(path.join(import.meta.dirname, '..', 'public'));
  add(path.join(process.cwd(), 'public'));
  try {
    const pkgUrl = import.meta.resolve('@phimacs/tau/package.json');
    add(path.join(path.dirname(fileURLToPath(pkgUrl)), 'public'));
  } catch {}
  add(path.join(process.cwd(), 'node_modules', '@phimacs', 'tau', 'public'));
  return candidates.find((c) => fs.existsSync(path.join(c, 'index.html'))) || candidates[0];
}

export const MIME_TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export function saveTauSetting(key: string, value: unknown): boolean {
  const settingsPath = path.join(PI_AGENT_DIR, 'settings.json');
  try {
    let settings: TauSettingsFile = {};
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as TauSettingsFile; } catch {}
    if (!settings.tau) settings.tau = {};
    settings.tau[key] = value;
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    return true;
  } catch {
    return false;
  }
}
