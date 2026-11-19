import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createClaimTestEnvironment } from '@phimacs/pimux/ownership';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const user = 'tls-test-user';
const pass = 'synthetic-test-password';
const BASIC = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

function request(url: string, ca: Buffer, headers: Record<string, string> = {}): Promise<{ status: number; cookie: string }> {
  return new Promise((resolve, reject) => {
    https.get(url, { ca, headers }, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, cookie: String(res.headers['set-cookie'] ?? '') });
    }).on('error', reject);
  });
}

function refused(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, host);
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code === 'ECONNREFUSED'));
  });
}

test('the network listener is authenticated HTTPS and plain HTTP stays on loopback', async (t) => {
  const runtime = createClaimTestEnvironment();
  const agentDir = path.join(runtime.root, 'agent');
  t.after(() => fs.rmSync(runtime.root, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['bin/tau.js'], {
    cwd: PROJECT_ROOT,
    env: {
      ...runtime.env, HOME: runtime.root, PATH: process.env.PATH,
      PHIMACS_PI: fileURLToPath(new URL('./cli.js', import.meta.resolve('@earendil-works/pi-coding-agent'))),
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: runtime.sessions,
      TAU_HOST: '0.0.0.0', TAU_PORT: '0', TAU_HTTP_PORT: '0', TAU_HOSTNAMES: 'pc',
      TAU_USER: user, TAU_PASS: pass, TAU_STATIC_DIR: path.join(PROJECT_ROOT, 'public'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Tau did not start.\n${output}`)), 10_000);
    child.stdout.on('data', () => { if (output.includes('[Tau] Static assets')) { clearTimeout(timer); resolve(); } });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Tau exited.\n${output}`)); });
  });

  const caFile = path.join(agentDir, 'tau', 'tls', 'ca.crt');
  assert.ok(output.includes(caFile), 'startup names the CA to trust');
  const ca = fs.readFileSync(caFile);
  const published = JSON.parse(fs.readFileSync(path.join(agentDir, 'tau', 'server.json'), 'utf8'));
  assert.deepEqual(Object.keys(published).sort(), ['browserUrls', 'pid', 'startedAt']);
  const httpsPort = Number(new URL(published.browserUrls[0]).port);
  assert.equal(published.browserUrls[0], `https://pc:${httpsPort}`);
  assert.ok(published.browserUrls.includes(`https://127.0.0.1:${httpsPort}`));
  for (const value of published.browserUrls) {
    const url = new URL(value);
    assert.equal(url.protocol, 'https:');
    assert.equal(url.username + url.password, '');
  }

  // The local listener still serves health and authenticated sessions.
  const port = /\(loopback HTTP\): http:\/\/127\.0\.0\.1:(\d+)/.exec(output)?.[1];
  assert.ok(port, 'startup reports the loopback HTTP port');
  const originLocal = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(`${originLocal}/api/health`)).status, 200);
  const local = `${originLocal}/api/live-sessions`;
  assert.equal((await fetch(local)).status, 401);
  assert.equal((await fetch(local, { headers: { Authorization: BASIC } })).status, 200);
  for (const address of published.browserUrls.map((url: string) => new URL(url).hostname).filter((host: string) => net.isIPv4(host) && host !== '127.0.0.1')) {
    assert.ok(await refused(address, Number(port)), `plain HTTP is not reachable on ${address}`);
  }

  // Network listener: HTTPS trusted through the generated CA, same authentication.
  const secure = `https://127.0.0.1:${httpsPort}/api/live-sessions`;
  assert.equal((await request(secure, ca)).status, 401);
  const authed = await request(secure, ca, { Authorization: BASIC });
  assert.equal(authed.status, 200);
  assert.match(authed.cookie, /; Secure/);

  // The certificate also covers configured host names.
  const named = tls.connect({ host: '127.0.0.1', port: httpsPort, servername: 'pc', ca });
  await once(named, 'secureConnect');
  assert.equal(named.authorized, true);
  named.destroy();

  // The voice socket upgrades over TLS with the same origin and auth checks.
  const origin = `https://127.0.0.1:${httpsPort}`;
  const voice = new WebSocket(`wss://127.0.0.1:${httpsPort}/ws/voice`, { ca, headers: { Authorization: BASIC, Origin: origin } });
  await once(voice, 'open');
  voice.close();
  const rejected = new WebSocket(`wss://127.0.0.1:${httpsPort}/ws/voice`, { ca, headers: { Origin: origin } });
  const [, response] = await once(rejected, 'unexpected-response') as [unknown, { statusCode: number }];
  assert.equal(response.statusCode, 401);

  child.kill('SIGTERM');
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, output);
  assert.equal(fs.existsSync(path.join(agentDir, 'tau', 'server.json')), false);
});
