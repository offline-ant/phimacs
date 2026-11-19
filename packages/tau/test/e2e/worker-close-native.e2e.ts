import { runtimeEnvironment } from '../runtime-environment.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fork, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { DiscoveryRecord } from '@phimacs/pimux/discovery';
import { readWorkerTask } from '@phimacs/orchestration/worker-task';
import { server, liveManager } from '../../bin/server-main.js';
import { until } from '../fake-pimux.ts';
import type { Browser, Response } from 'playwright';
import { launchBrowser } from './ui-correctness-harness.ts';

type Record_ = Record<string, unknown>;
const pimux = fileURLToPath(new URL('../../../pimux/bin/pimux', import.meta.url));
let base: string;
let service: ChildProcess;
let browser: Browser;
before(async () => {
  // The isolated foreground service owns this test's runtimes; Tau never starts it.
  service = spawn(process.execPath, [pimux, 'serve'], { cwd: runtimeEnvironment.root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  service.stdout!.on('data', data => { output += String(data); });
  service.stderr!.on('data', data => { output += String(data); });
  await until(() => {
    if (service.exitCode !== null) throw new Error(`pimux serve exited: ${output}`);
    return output.includes('pimux service ready');
  }, 'isolated pimux service', 15000);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await launchBrowser();
});
after(async () => {
  await browser?.close();
  await liveManager.shutdown();
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (service && service.exitCode === null && !service.signalCode) {
    const exited = once(service, 'exit');
    service.kill('SIGTERM');
    await exited;
  }
  fs.rmSync(runtimeEnvironment.root, { recursive: true, force: true });
});

for (const outcome of ['complete', 'failed'] as const) {
  test(`real managed parent final ${outcome} evidence, not worker exit, settles Tau Close`, { timeout: 60000 }, async t => {
    const child = fork(fileURLToPath(new URL('./fixtures/managed-worker-parent.ts', import.meta.url)), {
      env: { ...process.env, FX_TASK_ID: `native-${outcome}`, FX_CLEANUP_FAILURE: outcome === 'failed' ? '1' : '' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const messages: Record_[] = [];
    let diagnostics = '';
    child.stdout!.on('data', data => { diagnostics += String(data); });
    child.stderr!.on('data', data => { diagnostics += String(data); });
    child.on('message', message => { messages.push(message as Record_); });
    const message = async (type: string) => until(() => {
      const failure = messages.find(record => record.type === 'error');
      if (failure) throw new Error(String(failure.message));
      if (child.exitCode !== null || child.signalCode) throw new Error(`Parent exited before ${type}: ${diagnostics}`);
      return messages.find(record => record.type === type);
    }, type, 20000);
    t.after(async () => {
      await liveManager.shutdown();
      if (child.exitCode === null && !child.signalCode) {
        const closed = once(child, 'close');
        child.send('shutdown');
        const [code, signal] = await closed;
        assert.equal(signal, null, diagnostics);
        assert.equal(code, 0, diagnostics);
      }
    });
    const ready = await message('ready');
    const entry = ready.entry as DiscoveryRecord;
    assert.equal(entry.orchestration?.host, 'emacs');
    assert.equal(entry.placement, 'worker');
    assert.equal(liveManager.list().length, 0, 'external parent can publish without a Tau attachment');
    const context = await browser.newContext({ serviceWorkers: 'block' });
    t.after(() => context.close());
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    await page.goto(`${base}/#agent=${entry.muxId}`);
    await page.locator('#message-input:not([disabled])').waitFor();
    const session = liveManager.list().find(item => item.attached?.muxId === entry.muxId)!;
    const stopUrl = `${base}/api/live-sessions/${session.id}/stop`;
    const responses: Response[] = [];
    let stopRequests = 0;
    page.on('request', request => { if (request.url() === stopUrl && request.method() === 'POST') stopRequests++; });
    page.on('response', response => { if (response.url() === stopUrl) responses.push(response); });
    await page.locator('#header-menu-btn').click();
    await page.locator('.header-menu-item', { hasText: 'Close agent' }).click();
    await message('runtime-exited');
    assert.equal(readWorkerTask(entry.muxId)?.state, 'pending');
    assert.equal(fs.existsSync(String(ready.nameClaim)), true, 'parent cleanup/name release has not run');
    assert.equal(responses.length, 0, 'Pi exit does not acknowledge Close');
    assert.ok(liveManager.get(session.id));
    assert.equal(new URL(page.url()).hash, `#agent=${entry.muxId}`);
    child.send('finish');
    await message('task-finished');
    const response = await until(() => responses[0], 'browser Close response');
    assert.equal(stopRequests, 1);
    const body = await response.json() as Record_;
    assert.equal(fs.existsSync(String(ready.nameClaim)), false);
    assert.equal(readWorkerTask(entry.muxId)?.state, outcome);
    if (outcome === 'complete') {
      assert.equal(response.status(), 200, JSON.stringify(body));
      await page.waitForFunction(() => !location.hash);
      assert.equal((body.receipt as Record_).muxId, entry.muxId);
      assert.equal(liveManager.get(session.id), undefined);
    } else {
      assert.equal(response.status(), 503, JSON.stringify(body));
      await page.locator('#messages', { hasText: 'native cleanup failed' }).waitFor();
      assert.equal(new URL(page.url()).hash, `#agent=${entry.muxId}`);
      assert.match(String(body.error), /native cleanup failed/);
      // The parent can publish before Tau observes the socket close. Test recovery after both boundaries.
      await until(() => liveManager.get(session.id)?.exited, 'worker view disconnected');
      await assert.rejects(liveManager.attachById(entry.muxId), /native cleanup failed/);
      assert.ok(liveManager.get(session.id));
    }
  });
}
