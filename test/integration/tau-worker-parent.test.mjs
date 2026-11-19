// A worker launched by a Tau-owned view keeps its actual parent in Tau and deck.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { waitForChild } from '../../emacs/pi-deck/scripts/native-fixture.mjs';
import { SharingRig, until } from '../support/sharing-rig.mjs';

const tau = fileURLToPath(new URL('../../packages/tau/bin/tau.js', import.meta.url));

test('a Tau-created root owns its real worker in Tau and Emacs', { timeout: 120_000 }, async () => {
  const rig = await SharingRig.create();
  try {
    rig.stageProfile(true);
    delete rig.env.PHIMACS_SHARING_PROFILE; // Use the minimal native daemon, with orchestration installed for Pi.
    await rig.startService();
    await rig.startEmacs();
    const socket = rig.clients.get('first').socket;
    const server = rig.child(process.execPath, [tau], { ...rig.env, PHIMACS_SERVER_SOCKET: socket,
      TAU_HOST: '127.0.0.1', TAU_AUTH_ENABLED: 'false', TAU_HTTP_PORT: '0', TAU_PORT: '0' });
    const listener = /Local orchestration \(loopback HTTP\): (http:\/\/127\.0\.0\.1:\d+)/;
    await waitForChild(server, () => listener.test(server.log), 'owned Tau readiness');
    const base = listener.exec(server.log)[1];
    const api = async (route, body) => {
      const res = await fetch(base + route, body === undefined ? undefined : {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await res.json();
      assert.ok(res.ok, JSON.stringify(data));
      return data;
    };
    const { session } = await api('/api/live-sessions', { cwd: rig.env.PHIMACS_SHARING_PROJECT, model: 'fx/one' });
    const root = (await rig.list()).find(item => item.muxId === session.runtime.muxId);
    assert.equal(root.orchestration.host, 'emacs');
    assert.equal(root.orchestration.endpoint, socket);
    assert.equal((await rig.el('(length (pi-deck-agents))')), 0, 'starting in Tau does not open an Emacs view');

    const result = await api('/api/rpc', { type: 'prompt', message: 'run worker hierarchy', sessionId: session.id,
      inputContext: { agentId: root.muxId, file: session.sessionFile, leafId: session.leafId, runtimeContext: session.runtimeContext } });
    assert.equal(result.success, true, JSON.stringify(result));
    const worker = await until(async () => (await rig.list()).find(item => item.placement === 'worker'), 'real worker discovery');
    for (const key of ['host', 'endpoint', 'id']) assert.equal(worker.parent?.[key], root.orchestration[key]);
    const listed = await until(async () => (await api('/api/agents')).agents.find(item => item.muxId === worker.muxId), 'worker reaches Tau');
    assert.equal(listed.parentId, root.muxId);

    const relationship = await until(() => rig.el(`(when (featurep 'pi-orchestration)
      (when-let* ((child (cl-find ${JSON.stringify(worker.muxId)} (pi-orchestration-targets)
                                  :key (lambda (target) (plist-get target :mux-id)) :test #'equal))
                  (buffer (plist-get child :buffer))
                  (agent (pi-deck-agent buffer))
                  (parent (pi-deck-agent-parent agent))
                  (runtime (pilish-session-runtime parent)))
        (plist-get runtime :mux-id)))`), 'Emacs deck child gets the same parent runtime');
    assert.equal(relationship, root.muxId);

    fs.writeFileSync(path.join(rig.env.FX_HOLD_DIR, 'hierarchy'), 'release');
    await until(async () => (await rig.list()).find(item => item.muxId === root.muxId)?.status === 'idle', 'worker result settles in the root');
  } catch (error) {
    rig.failure = error;
    throw error;
  } finally {
    await rig.cleanup();
  }
});
