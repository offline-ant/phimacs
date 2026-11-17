// `phimacs status`: what runs, what failed to restore and what setup is missing. Starts nothing.
import fs from 'node:fs';
import { probe } from './emacs-launch.mjs';
import { runtimePaths } from './runtime.mjs';
import { describeService } from './service.mjs';
import { orchestrationInstalled, preparedState } from './setup.mjs';
import { listShares } from './share-host.mjs';

const attempt = action => { try { return action(); } catch (error) { return { state: 'error', error: error.message }; } };

export async function collectStatus(options, env = process.env) {
  const host = attempt(() => {
    const runtime = runtimePaths(options.root, env);
    return { pi: runtime.pi, version: runtime.version };
  });
  const service = await describeService(env, options.root).catch(error => ({ state: 'error', error: error.message }));
  const emacs = attempt(() => {
    const identity = probe(options);
    if (identity) return { state: 'running', pid: identity.pid, socket: options.socket };
    return { state: fs.existsSync(options.socket) ? 'unanswered' : 'absent', socket: options.socket };
  });
  const setup = { missing: preparedState(options.state), orchestration: orchestrationInstalled(options.root, env) };
  const share = attempt(() => listShares(env));
  return { root: options.root, state: options.state, host, service, emacs, setup, share };
}

/** Human wording of the machine states that --json reports. */
const stateText = state => ({ absent: 'not running', unanswered: 'not answering' })[state] ?? state;

export function formatStatus(status) {
  const { host, service, emacs, setup, share } = status;
  const lines = [`checkout  ${status.root}`, `state     ${status.state}`,
    `pi        ${host.error ? `error: ${host.error}` : `${host.version} (${host.pi})`}`];
  if (service.state === 'ready' || service.state === 'stopping') {
    const counts = Object.entries(service.counts).map(([state, count]) => `${count} ${state}`).join(', ') || 'no agents';
    lines.push(`pimux     ${service.state}, pid ${service.pid}${service.root ? `, from ${service.root}` : ''}`,
      `          agents: ${counts}${service.pending ? `; ${service.pending} starting` : ''}`,
      `          journaled roots: ${service.roots.length}; restoration failures: ${service.failed.length}`);
    for (const root of service.failed) lines.push(`            ${root.muxId} (${root.cwd}): ${root.error}`);
  } else lines.push(`pimux     ${stateText(service.state)}${service.error ? `: ${service.error}` : ''} (${service.socket ?? 'unknown socket'})`);
  lines.push(`emacs     ${stateText(emacs.state)}${emacs.pid ? `, pid ${emacs.pid}` : ''}${emacs.error ? `: ${emacs.error}` : ''}${emacs.socket ? ` (${emacs.socket})` : ''}`);
  lines.push(`setup     ${setup.missing.length ? `missing ${setup.missing.join(', ')}; run phimacs setup` : 'Emacs packages and native assets prepared'}`,
    `          orchestration Pi extension ${setup.orchestration ? 'registered' : 'not registered'}`);
  if (share.error) lines.push(`share     error: ${share.error}`);
  else if (!share.connections.length) lines.push(`share     no devices (${share.directory})`);
  else {
    lines.push(`share     ${share.connections.length} device connection(s) in ${share.directory}, newest first:`);
    for (const connection of share.connections) lines.push(`            ${connection.id}: ${connection.kinds.join(' ')}`);
  }
  return lines.join('\n');
}
