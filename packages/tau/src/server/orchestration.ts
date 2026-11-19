// Publish the HTTPS origins for opening Tau in a browser.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isIP } from 'node:net';
import { writePrivateJson } from '@phimacs/pimux/private-files';
import { processExists } from '@phimacs/pimux/process-identity';

import { HOST, PI_AGENT_DIR, TAU_SETTINGS } from './config.js';
import { reachableAddresses } from './tls.js';

export const RUNTIME_DIR = path.join(PI_AGENT_DIR, 'tau');
export const RUNTIME_FILE = path.join(RUNTIME_DIR, 'server.json');

type RuntimeFile = { pid: number; startedAt: string; browserUrls: string[] };

/**
 * HTTPS origins for people opening Tau in a browser. Wildcard listeners list
 * configured host names and every reachable address on the listener's family.
 */
export function buildBrowserUrls(port: number, address = HOST, hostnames = TAU_SETTINGS.hostnames, interfaces = os.networkInterfaces()): string[] {
  const wildcard = address === '0.0.0.0' || address === '::';
  const family = address === '::' ? 6 : 4;
  const hosts = wildcard
    ? [...hostnames, ...reachableAddresses(interfaces).filter((host) => isIP(host) === family), family === 6 ? '::1' : '127.0.0.1']
    : isIP(address) && !address.includes('%') && !/^fe[89ab]/i.test(address) ? [address] : [];
  return [...new Set(hosts)].map((host) => `https://${host.includes(':') ? `[${host}]` : host}:${port}`);
}

function publishedPid(): number | null {
  try {
    const record = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'));
    return Number.isSafeInteger(record?.pid) && record.pid > 0 ? record.pid : null;
  } catch { return null; }
}

/** A second server must not replace the browser URLs of the running one. */
export function publishBrowserUrls(httpsPort: number, httpsAddress = HOST): void {
  const pid = publishedPid();
  if (pid !== null && pid !== process.pid && processExists(pid)) {
    console.log(`[Tau] Browser discovery keeps pointing at the running server (pid ${pid}) in ${RUNTIME_FILE}.`);
    return;
  }
  const record: RuntimeFile = { pid: process.pid, startedAt: new Date().toISOString(), browserUrls: buildBrowserUrls(httpsPort, httpsAddress) };
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
    writePrivateJson(RUNTIME_FILE, record);
  } catch (e) {
    console.warn(`[Tau] Could not publish browser URLs to ${RUNTIME_FILE}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function unpublishBrowserUrls(): void {
  if (publishedPid() !== process.pid) return;
  try { fs.rmSync(RUNTIME_FILE, { force: true }); } catch {}
}
