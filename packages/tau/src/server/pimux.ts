/** Presentation helpers over pimux's owning discovery, identity and claim APIs. */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { discoveryOwnerAlive, listDiscovery, muxDirectory, readDiscovery, type DiscoveryRecord, type OrchestrationRef } from '@phimacs/pimux/discovery';
import { canonicalSessionPath, lookupClaim } from '@phimacs/pimux/ownership';
import { verifyPrivateDirectory } from '@phimacs/pimux/private-files';
import { isRecord, PROTOCOL_VERSION } from '@phimacs/pimux/protocol';
import { runtimeRequest } from '@phimacs/pimux/request';
import { validateSocket, type RuntimeReceipt } from '@phimacs/pimux/runtime';
import { LineSplitter } from '@phimacs/pimux/jsonl';
import type { JsonRecord } from './types.js';

export const PIMUX_PROTOCOL = PROTOCOL_VERSION;
export type PimuxEntry = DiscoveryRecord;
export type PimuxRef = OrchestrationRef;
export const pimuxDirectory = muxDirectory;
export function pimuxDisplayName(entry: PimuxEntry) {
  const base = path.basename(entry.cwd) || entry.cwd;
  if (entry.session?.name) return entry.session.name;
  const id = entry.orchestration?.id;
  if (!id) return base;
  if (/^\*pilish-chat:.*\*$/.test(id)) return /<([^<>]+)>\*$/.exec(id)?.[1] ?? base;
  return /^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(id) ? `worker ${id.slice(0, 8)}` : id;
}
export function listPimuxEntries(dir = muxDirectory()): PimuxEntry[] {
  if (!fs.existsSync(dir)) return [];
  verifyPrivateDirectory(dir);
  return listDiscovery(dir);
}
export function pimuxEntryById(id: string, dir = muxDirectory()): PimuxEntry | undefined {
  return listPimuxEntries(dir).find(entry => entry.muxId === id);
}
export function pimuxEntryForFile(file: string, dir = muxDirectory()): PimuxEntry | undefined {
  const claim = lookupClaim(file);
  if (claim) {
    if (claim.owner.kind !== 'rpc' || !claim.owner.socket) return undefined;
    const entry = readDiscovery(path.join(path.dirname(claim.owner.socket), `${claim.owner.id}.json`));
    if (entry?.muxId === claim.owner.id && entry.session?.file
      && canonicalSessionPath(entry.session.file) !== canonicalSessionPath(claim.file)) {
      throw Object.assign(new Error('This old file is retained by a runtime serving another conversation; no operation was sent to that conversation'), { status: 409 });
    }
    return entry?.muxId === claim.owner.id ? entry : undefined;
  }
  const matches = listPimuxEntries(dir).filter(entry => entry.session?.file && canonicalSessionPath(entry.session.file) === canonicalSessionPath(file));
  return matches.find(discoveryOwnerAlive) ?? matches[0];
}
export function pimuxFiles(dir = muxDirectory()): Map<string, string> {
  return new Map(listPimuxEntries(dir).filter(entry => !!entry.session?.file && discoveryOwnerAlive(entry))
    .map(entry => [canonicalSessionPath(entry.session!.file!), entry.muxId]));
}
export function receiptFor(entry: PimuxEntry): RuntimeReceipt {
  if (entry.protocol !== PROTOCOL_VERSION || entry.phase !== 'committed' || !entry.operationId || !entry.piPid || !entry.session?.file) {
    throw new Error('Runtime is unsupported or not committed; no replacement writer was started');
  }
  return { protocol: PROTOCOL_VERSION, muxId: entry.muxId, operationId: entry.operationId, socket: entry.socket,
    pid: entry.pid, piPid: entry.piPid, service: entry.service, sessionFile: entry.session.file, state: 'committed', outcome: 'attached' };
}
export type PimuxReachability = 'reachable' | 'unreachable' | 'stale';
export async function probePimux(entry: PimuxEntry, timeoutMs = 2000): Promise<PimuxReachability> {
  let receipt: RuntimeReceipt;
  try { receipt = receiptFor(entry); validateSocket(receipt.socket); }
  catch { return discoveryOwnerAlive(entry) ? 'unreachable' : 'stale'; }
  // Reachability proves this protected peer's hello, not application readiness.
  // The actual client still requires its complete snapshot/live boundary and
  // reports that boundary's failure rather than disguising it as owner absence.
  return new Promise(resolve => {
    const socket = net.connect(receipt.socket);
    let settled = false;
    const finish = (result: PimuxReachability) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy(); resolve(result);
    };
    const timer = setTimeout(() => finish('unreachable'), timeoutMs);
    const lines = new LineSplitter(line => {
      let record: unknown;
      try { record = JSON.parse(line); } catch { finish('unreachable'); return; }
      if (!isRecord(record) || record.type !== 'pimux_hello') return finish('unreachable');
      const capabilities = record.capabilities;
      finish(record.protocol === PROTOCOL_VERSION && record.muxId === receipt.muxId && record.piPid === receipt.piPid
        && Array.isArray(capabilities) && ['snapshot', 'stop', 'detached', 'contextual-input'].every(cap => capabilities.includes(cap)) ? 'reachable' : 'unreachable');
    }, 64 * 1024, () => finish('unreachable'));
    socket.on('data', (chunk: Buffer) => lines.push(chunk));
    socket.once('error', () => finish(discoveryOwnerAlive(entry) ? 'unreachable' : 'stale'));
    socket.once('close', () => finish(discoveryOwnerAlive(entry) ? 'unreachable' : 'stale'));
  });
}
export type PimuxSharing = { entry: PimuxEntry; reachability: Exclude<PimuxReachability, 'stale'> };
export async function pimuxSharing(file: string, dir = muxDirectory()): Promise<PimuxSharing | null> {
  const claim = lookupClaim(file);
  if (claim && (claim.owner.kind !== 'rpc' || claim.owner.protocol !== PROTOCOL_VERSION)) {
    throw Object.assign(new Error(`Session has a live or uncertain ${claim.owner.kind} owner; force cannot bypass ownership`), { status: 409 });
  }
  const entry = pimuxEntryForFile(file, dir);
  if (!entry) {
    if (claim) throw Object.assign(new Error('Session owner is unavailable; no replacement writer was started'), { status: 409 });
    return null;
  }
  const reachability = await probePimux(entry);
  if (reachability === 'stale' && !claim) return null;
  return { entry, reachability: reachability === 'stale' ? 'unreachable' : reachability };
}

/** One correlated operation, only after this connection validates its full boundary; never replayed. */
export function pimuxCommand(entry: PimuxEntry, command: JsonRecord, timeoutMs = 30000): Promise<JsonRecord> {
  return runtimeRequest(receiptFor(entry), command, undefined, timeoutMs);
}
