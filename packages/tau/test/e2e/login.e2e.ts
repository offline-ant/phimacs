import { runtimeEnvironment, agent, cwd } from '../runtime-environment.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, devices, type Browser } from 'playwright';
import { FakePimux, until } from '../fake-pimux.ts';

test('mobile sign-in opens authenticated Tau without URL credentials or a manual reload', { timeout: 20000 }, async t => {
  const username = 'mobile-test';
  const password = randomBytes(16).toString('base64url') + '+&';
  const fake = new FakePimux(process.env.PIMUX_DIR!, 'mobile-agent', {
    cwd,
    sessionFile: path.join(runtimeEnvironment.sessions, 'mobile.jsonl'),
  });
  await fake.listen();
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../bin/tau.js', import.meta.url))], {
    cwd,
    env: { ...process.env, TAU_AUTH_ENABLED: 'true', TAU_USER: username, TAU_PASS: password },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let browser: Browser | undefined;
  t.after(async () => {
    try {
      await browser?.close();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        await exited;
      }
      await fake.close();
      fs.rmSync(runtimeEnvironment.root, { recursive: true, force: true });
    }
  });
  let log = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { log += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { log += chunk; });
  const discoveryFile = path.join(agent, 'tau', 'server.json');
  const base = await until(() => {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Tau exited before startup:\n${log}`);
    if (!log.includes('[Tau] Server running') || !fs.existsSync(discoveryFile)) return;
    const record: { browserUrls: string[] } = JSON.parse(fs.readFileSync(discoveryFile, 'utf8'));
    return record.browserUrls[0];
  }, 'disposable Tau HTTPS listener');

  const executablePath = [process.env.CHROMIUM_BINARY, chromium.executablePath(), '/usr/bin/chromium', '/usr/bin/chromium-browser']
    .find(candidate => candidate && fs.existsSync(candidate));
  assert.ok(executablePath, 'Install Chromium or set CHROMIUM_BINARY');
  browser = await chromium.launch({ executablePath });
  // Tau generates a private test CA. No trusted live certificate or cached Basic credentials.
  const context = await browser.newContext({ ...devices['Pixel 7'], ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const landing = await page.goto(`${base}/`);
  assert.equal(landing?.status(), 401);
  assert.match((await landing!.headerValue('content-type')) ?? '', /^text\/html\b/);
  assert.match((await landing!.headerValue('cache-control')) ?? '', /\bno-store\b/);
  assert.equal(await landing!.headerValue('www-authenticate'), null, 'the browser shows the form, not a Basic dialog');
  assert.equal((await context.cookies()).length, 0);

  const userField = page.getByLabel('Username', { exact: true });
  const passField = page.getByLabel('Password', { exact: true });
  const submit = page.getByRole('button', { name: 'Sign in', exact: true });
  const loginResponse = () => page.waitForResponse(response => response.url() === `${base}/login` && response.request().method() === 'POST');
  await userField.fill(username);
  await passField.fill('not-the-password');
  const failed = loginResponse();
  await submit.tap();
  const rejection = await failed;
  assert.equal(rejection.status(), 401, `same-origin form returned ${rejection.status()} (Origin: ${await rejection.request().headerValue('origin')})`);
  assert.equal(await rejection.headerValue('set-cookie'), null);
  await page.getByText('Invalid username or password.', { exact: true }).waitFor();
  assert.equal(await passField.inputValue(), '', 'the form does not echo the rejected password');
  assert.equal((await context.cookies()).length, 0);

  // Listen before submitting: the app connects as soon as the 303 lands.
  const socketStates: unknown[] = [];
  page.on('websocket', socket => {
    if (socket.url() !== `${base.replace(/^https:/, 'wss:')}/ws`) return;
    socket.on('framereceived', ({ payload }) => {
      const message = JSON.parse(payload.toString());
      if (message.type === 'state') socketStates.push(message);
    });
  });
  await userField.fill(username);
  await passField.fill(password);
  const success = loginResponse();
  await submit.tap();
  const redirect = await success;
  assert.equal(redirect.status(), 303);
  assert.equal(await redirect.headerValue('location'), '/');
  await page.waitForURL(`${base}/`);
  const { username: urlUser, password: urlPassword } = new URL(page.url());
  assert.deepEqual([urlUser, urlPassword], ['', '']);

  const cookie = (await context.cookies()).find(item => item.name === 'tau_session');
  assert.ok(cookie);
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.secure, true);
  assert.equal(cookie.sameSite, 'Lax');
  assert.equal(cookie.expires, -1, 'the browser cookie lasts only for the session');
  const discovery = await page.evaluate(async () => {
    const response = await fetch('/api/agents');
    return { status: response.status, body: await response.json() };
  });
  assert.equal(discovery.status, 200);
  assert.ok(discovery.body.agents.some((item: { muxId: string }) => item.muxId === fake.muxId));
  const row = page.locator(`#agent-list .agent-row[data-mux-id="${fake.muxId}"]`);
  await row.waitFor();
  assert.partialDeepStrictEqual(await until(() => socketStates[0], 'authenticated WebSocket state'), {
    type: 'state', agents: [{ muxId: fake.muxId }],
  });
  assert.deepEqual(errors, []);
});
