// Start or attach the pimux service for the top-level launcher, and stop it safely.
// Emacs/Pilish/deck never start the service; only this explicit launcher does.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { expectedStateId, probeService, resumeService, serviceLeases, serviceSocket, serviceStatus, stopService }
  from '@phimacs/pimux/service-client';
import { processIdentityStatus, readProcessIdentity, sameProcessIdentity } from '@phimacs/pimux/process-identity';
import { detachedEnvironment } from './emacs-environment.mjs';
import { runtimeEnvironment } from './runtime.mjs';

const real = file => { try { return fs.realpathSync(file); } catch { return path.resolve(file); } };

/** Optional explicit supervisor: PHIMACS_PIMUX_SUPERVISOR_COMMAND with JSON start/stop argument arrays. */
export function pimuxSupervisor(env = process.env) {
  if (!env.PHIMACS_PIMUX_SUPERVISOR_COMMAND) return null;
  const parse = name => {
    let value;
    try { value = JSON.parse(env[name] ?? 'null'); } catch { value = null; }
    if (!Array.isArray(value) || !value.length || !value.every(item => typeof item === 'string')) {
      throw new Error(`${name} must be a non-empty JSON string array when PHIMACS_PIMUX_SUPERVISOR_COMMAND is set`);
    }
    return value;
  };
  return { command: env.PHIMACS_PIMUX_SUPERVISOR_COMMAND, start: parse('PHIMACS_PIMUX_SUPERVISOR_ARGS'),
    stop: parse('PHIMACS_PIMUX_SUPERVISOR_STOP_ARGS') };
}

/** The detached service's environment: the caller's selections, never its terminal or host identities. */
export function serviceEnvironment(runtime, state, env = process.env) {
  return { ...detachedEnvironment(env), ...runtimeEnvironment(runtime, {}), PHIMACS_STATE_DIR: state,
    PHIMACS_EMACS_LAUNCHER: path.join(runtime.root, 'scripts/emacs-launch.mjs') };
}

/**
 * Why the answering service is not this checkout's service for this state, or
 * undefined. It must name this checkout and the durable identity of the state
 * directory whose journal it keeps, and identify its process.
 */
export function serviceMismatch(greeting, root, env = process.env) {
  if (!greeting.root) return 'was not started from a Phimacs checkout';
  if (real(greeting.root) !== real(root)) return `runs from ${greeting.root}, not ${root}`;
  if (!greeting.stateId || greeting.stateId !== expectedStateId(env)) return 'keeps its journal in another state directory than this PHIMACS_STATE_DIR';
  const identity = greeting.process;
  if (!identity || !Number.isSafeInteger(identity.pid) || identity.pid <= 0 || typeof identity.startTime !== 'string'
    || !/^\d+$/.test(identity.startTime) || typeof identity.bootId !== 'string' || !identity.bootId) return 'does not report a valid process identity';
  if (processIdentityStatus(identity) !== 'alive') return `reports process ${identity.pid}, which is not running`;
  // Only the process holding both singleton leases is this state's authoritative service.
  const { service, endpoint } = serviceLeases(env);
  if (!service || !endpoint || !sameProcessIdentity(service.process, identity) || !sameProcessIdentity(endpoint.process, identity)) {
    return `reports process ${identity.pid}, which does not hold this state's service leases`;
  }
  return undefined;
}

function verify(greeting, root, env, socket) {
  const mismatch = serviceMismatch(greeting, root, env);
  if (mismatch) throw new Error(`pimux at ${socket} ${mismatch}; stop it where it was started, or select another PIMUX_DIR and PHIMACS_STATE_DIR`);
}

/** The identity this launcher binds its stop operations to. */
const self = () => readProcessIdentity(process.pid);

/**
 * A stopping service is attached only by recovering a stop whose caller is proven
 * dead; the service itself refuses to undo a live caller's operation.
 */
async function recoverAbandonedStop(greeting, env, socket) {
  const caller = (await serviceStatus(env)).stop?.caller;
  if (caller && processIdentityStatus(caller) === 'dead'
    && (await resumeService({ service: greeting.process, operationId: randomUUID(), caller: self(), env })).resumed) return;
  throw new Error(`pimux at ${socket} is stopping${caller ? ` (by running process ${caller.pid})` : ''}; wait for \`phimacs stop\` to finish`);
}

const refusal = (socket, why) => new Error(`pimux endpoint ${socket} ${why}. It is never replaced or removed automatically: `
  + 'check `phimacs status` and your pimux processes; only when no pimux process owns it, remove that socket and retry');

/**
 * Attach to a ready service or start exactly one. A concurrent launcher waits
 * for the service that wins pimux's singleton lease instead of starting another.
 * Returns `attached`, `started` or `supervisor-started`.
 */
export async function ensureService({ runtime, state, env = process.env, timeoutMs = 60_000, pause = delay,
  spawnProcess = spawn, run = spawnSync, supervisor = pimuxSupervisor(env) }) {
  const socket = serviceSocket(env);
  const log = path.join(state, 'pimux.log');
  /**
   * Wait for readiness; true when `child` is the service that became ready. A
   * child that lost the lease must exit first: left running, it could contend
   * again later and start a service after this launcher reported attachment.
   */
  const awaitReady = async (child) => {
    const deadline = Date.now() + timeoutMs;
    let exited = null;
    let ready = false;
    child?.once('exit', (code, signal) => { exited = signal ?? code; });
    for (;;) {
      const probe = await probeService(env);
      if (probe.state === 'answering') {
        verify(probe.greeting, runtime.root, env, socket);
        if (probe.greeting.stopping) await recoverAbandonedStop(probe.greeting, env, socket);
        ready = probe.greeting.ready;
        if (ready && child === undefined) return false;
        if (ready && serviceLeases(env).service?.process.pid === child.pid) return true;
      }
      if (child && exited !== null) {
        // Losing the lease to a concurrent launcher's service is not a failure.
        const { service } = serviceLeases(env);
        if (service?.status !== 'alive') throw new Error(`pimux exited (${exited}) before readiness; see ${log}`);
        child = undefined;
      }
      if (Date.now() >= deadline) {
        throw new Error(ready && child ? `pimux is ready, but the service this command started (pid ${child.pid}) did not exit after losing to it; check \`phimacs status\` and ${log}`
          : `pimux was not ready within ${timeoutMs / 1000} s and was left running; check \`phimacs status\` and ${log}`);
      }
      await pause(50);
    }
  };
  const first = await probeService(env);
  if (first.state === 'answering') {
    verify(first.greeting, runtime.root, env, socket);
    if (first.greeting.stopping) await recoverAbandonedStop(first.greeting, env, socket);
    if (!first.greeting.ready) await awaitReady();
    return { outcome: 'attached' };
  }
  if (first.state === 'unresponsive') throw refusal(socket, 'accepts connections but does not answer');
  const leases = serviceLeases(env);
  const holders = [leases.service, leases.endpoint].filter(Boolean);
  if (holders.some(lease => lease.status === 'unknown')) throw refusal(socket, 'has an owner whose liveness is uncertain');
  if (holders.some(lease => lease.status === 'alive')) {
    await awaitReady();
    return { outcome: 'attached' };
  }
  if (first.state === 'refused' && !leases.endpoint) throw refusal(socket, 'refuses connections and has no owner record');
  if (supervisor) {
    const result = run(supervisor.command, supervisor.start, { encoding: 'utf8', timeout: 60_000 });
    if (result.error || result.status !== 0) {
      throw new Error(`Configured pimux supervisor start failed (${(result.stderr || result.error?.message || `exit ${result.status}`).trim()}); no unmanaged service was started`);
    }
    await awaitReady();
    return { outcome: 'supervisor-started' };
  }
  const output = fs.openSync(log, 'a', 0o600);
  let child;
  try {
    child = spawnProcess(process.execPath, [runtime.pimux, 'serve'], {
      detached: true, cwd: state, stdio: ['ignore', output, output], env: serviceEnvironment(runtime, state, env),
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  } finally { fs.closeSync(output); }
  try { return { outcome: await awaitReady(child) ? 'started' : 'attached' }; }
  finally { child.unref(); }
}

async function exited(identity, { pause, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (processIdentityStatus(identity) !== 'dead') {
    if (Date.now() >= deadline) throw new Error(`pimux ${identity.pid} is still shutting down; check \`phimacs status\``);
    await pause(50);
  }
}

/**
 * Stop this checkout's service as one operation bound to its exact process:
 * `checkFrontends` may refuse first; the service then drains (refusing busy,
 * starting or unrestorable agents unless forced, refusing new agents and, unforced,
 * closing every agent's input before its idle check); `stopFrontends` runs; a
 * commit checks again and ends the service, or its supervisor ends it so it is
 * not restarted. Any failure resumes this operation only, which also undoes a
 * drain whose reply was lost; a commit whose reply was lost is confirmed by the
 * service process exiting.
 */
export async function stopAll({ env = process.env, root, force, checkFrontends = async () => {}, stopFrontends,
  run = spawnSync, pause = delay, timeoutMs = 30_000, supervisor = pimuxSupervisor(env),
  request = { stop: stopService, resume: resumeService } }) {
  const socket = serviceSocket(env);
  const probe = await probeService(env);
  if (probe.state === 'unresponsive') throw new Error(`pimux at ${socket} does not answer; check \`phimacs status\``);
  if (probe.state !== 'answering') {
    await checkFrontends();
    await stopFrontends();
    return { service: 'absent' };
  }
  const mismatch = serviceMismatch(probe.greeting, root, env);
  if (mismatch) throw new Error(`pimux at ${socket} ${mismatch}; this checkout does not stop it`);
  if (!probe.greeting.ready) throw new Error('pimux is still starting; retry `phimacs stop` once `phimacs status` shows it ready');
  await checkFrontends();
  const operation = { service: probe.greeting.process, operationId: randomUUID(), caller: self(), force, env };
  let drained;
  let committing = false;
  try {
    drained = await request.stop({ ...operation, phase: 'drain', exit: false });
    await stopFrontends();
    committing = true;
    if (supervisor) {
      await request.stop({ ...operation, phase: 'commit', exit: false });
      const result = run(supervisor.command, supervisor.stop, { encoding: 'utf8', timeout: 60_000 });
      if (result.error || result.status !== 0) throw new Error(`Configured pimux supervisor stop failed: ${(result.stderr || result.error?.message || `exit ${result.status}`).trim()}`);
    } else await request.stop({ ...operation, phase: 'commit', exit: true });
  } catch (error) {
    if (committing && !supervisor && (await probeService(env)).state !== 'answering') {
      // The commit may have been accepted before its reply was lost: the exit decides.
      try {
        await exited(operation.service, { pause, timeoutMs });
        return { service: 'stopped', roots: drained.roots.length };
      } catch { /* still alive: resume below */ }
    }
    let resumed;
    try { resumed = await request.resume(operation); }
    catch (cleanup) { throw new Error(`${error.message}; resuming pimux also failed: ${cleanup.message}`, { cause: error }); }
    throw new Error(`${error.message}; ${resumed.resumed ? 'pimux was resumed and accepts agents again' : 'pimux was not changed'}`, { cause: error });
  }
  await exited(operation.service, { pause, timeoutMs });
  return { service: 'stopped', roots: drained.roots.length };
}

/** Service facts for `phimacs status`; an absent or unresponsive service is a state, not an error. */
export async function describeService(env = process.env, root = undefined) {
  const socket = serviceSocket(env);
  const probe = await probeService(env);
  if (probe.state !== 'answering') return { state: probe.state, socket };
  const mismatch = root === undefined ? undefined : serviceMismatch(probe.greeting, root, env);
  if (mismatch) return { state: 'foreign', socket, root: probe.greeting.root, error: mismatch };
  if (!probe.greeting.ready) return { state: 'starting', socket, root: probe.greeting.root };
  const status = await serviceStatus(env);
  const counts = {};
  for (const agent of status.agents) counts[agent.status] = (counts[agent.status] ?? 0) + 1;
  return { state: status.stopping ? 'stopping' : 'ready', socket, pid: status.process.pid, root: status.root,
    pending: status.pending, counts, agents: status.agents, roots: status.roots,
    failed: status.roots.filter(root => root.error) };
}
