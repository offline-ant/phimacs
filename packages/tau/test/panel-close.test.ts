import { runtimeEnvironment } from './runtime-environment.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { writeDiscovery } from '@phimacs/pimux/discovery';
import { readProcessIdentity } from '@phimacs/pimux/process-identity';
import { writePrivateJson } from '@phimacs/pimux/private-files';
import { agentOverview, server } from '../bin/server-main.js';

test('Tau panel Close dispatches only the exact registry binding and retires it after native acknowledgement', async t => {
  const tmp = process.env.TMPDIR!;
  assert.ok(tmp.startsWith(runtimeEnvironment.root + path.sep));
  const native = net.createServer(socket => socket.destroy());
  const endpoint = path.join(tmp, 'emacs.sock');
  native.listen(endpoint);
  await once(native, 'listening');
  t.after(() => new Promise<void>(resolve => native.close(() => resolve())));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const http = server.address();
  assert.ok(http && typeof http !== 'string');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));

  const nativeCalls = path.join(tmp, 'calls.jsonl');
  const control = path.join(tmp, 'emacsclient');
  fs.writeFileSync(control, `#!${process.execPath}\n` + `
const fs = require('node:fs');
const payload = process.argv.at(-1).match(/pi-orchestration-dispatch "([^"]+)"/)[1];
const call = JSON.parse(Buffer.from(payload, 'base64'));
fs.appendFileSync(${JSON.stringify(nativeCalls)}, JSON.stringify(call) + '\\n');
console.log(JSON.stringify(Buffer.from(JSON.stringify(fs.existsSync(${JSON.stringify(nativeCalls + '.ok')})
  ? {success: true} : {error: 'native view retained'})).toString('base64')));
`, { mode: 0o700 });
  const oldPath = process.env.PATH;
  process.env.PATH = tmp + ':' + oldPath;
  t.after(() => { process.env.PATH = oldPath; });
  const id = randomUUID();
  const owner = readProcessIdentity(process.pid)!;
  const muxId = randomUUID();
  const mux = process.env.PIMUX_DIR!;
  fs.mkdirSync(mux, { mode: 0o700 });
  const now = new Date().toISOString();
  writeDiscovery(path.join(mux, `${muxId}.json`), {
    protocol: 2, muxId, socket: path.join(mux, `${muxId}.sock`), pid: process.pid, piPid: process.pid,
    piIdentity: owner, cwd: tmp, startedAt: now, updatedAt: now, status: 'idle', blocked: null,
    session: null, model: null, thinkingLevel: null, placement: 'root', orchestration: null, parent: null,
  });
  const directory = fs.mkdtempSync(path.join(tmp, 'control-'));
  const registry = path.join(tmp, 'pi-orchestration-targets');
  fs.mkdirSync(registry, { mode: 0o700 });
  const registration = path.join(registry, 'owned.json');
  const outputPath = path.join(directory, 'capture');
  fs.writeFileSync(outputPath, 'captured output', { mode: 0o600 });
  writePrivateJson(registration, { target: { name: 'owned', host: 'emacs', endpoint, id: 'native-view', kind: 'shell',
    owner, panel: { id, directory, creator: owner }, outputPath } });
  // Simulate a wrapper that already acknowledged exact cleanup, but whose native view has not yet retired.
  writePrivateJson(path.join(directory, 'state.json'), { schema: 1, id, command: 'exited', closed: true,
    process: { ...owner, startTime: '0' } });
  agentOverview.start();
  t.after(() => agentOverview.stop());
  assert.ok(agentOverview.list().some(agent => agent.placement === 'panel' && agent.muxId === `panel:${id}` && agent.parentId === muxId));
  const close = (panelId: string) => fetch(`http://127.0.0.1:${http.port}/api/panels/${panelId}/close`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'owned' }),
  });
  const calls = () => fs.readFileSync(nativeCalls, 'utf8').trim().split('\n').map(line => JSON.parse(line));

  const stale = await close(randomUUID());
  assert.equal(stale.status, 409);
  assert.match((await stale.json()).error, /registration changed/);
  assert.equal(fs.existsSync(nativeCalls), false);

  const refused = await close(id);
  assert.equal(refused.ok, false);
  assert.match((await refused.json()).error, /native view retained/);
  assert.equal(calls().length, 1);
  assert.equal(fs.existsSync(registration), true);
  assert.equal(fs.readFileSync(outputPath, 'utf8'), 'captured output');

  fs.writeFileSync(nativeCalls + '.ok', '');
  const confirmed = await close(id);
  assert.equal(confirmed.status, 200);
  assert.deepEqual(await confirmed.json(), { panelId: id, state: 'closed' });
  assert.deepEqual(calls(), Array.from({ length: 2 }, () => ({ operation: 'close', id: 'native-view', detachOnly: true, taskOwned: false, panelId: id })));
  assert.equal(fs.existsSync(registration), false);
  assert.equal(fs.existsSync(outputPath), false);
  assert.ok(!agentOverview.list().some(agent => agent.placement === 'panel'));
  assert.ok(agentOverview.list().some(agent => agent.muxId === muxId), 'closing a panel never closes its Pi');
});
