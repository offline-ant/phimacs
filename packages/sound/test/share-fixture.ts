/** Fake share-protocol devices on real Unix sockets. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import type { TestContext } from 'node:test';

/** A private 0700 share directory removed after the test. */
export function shareDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sound-share-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export interface FakeBehaviour {
  /** Chunks a microphone streams, each separately, before waiting for the host to close. */
  send?: Buffer[];
  /** Never close after the host's EOF, like a stuck player. */
  hold?: boolean;
  /** Accept each connection, then close it without reading: a forward whose device listener is gone. */
  drop?: boolean | ((connection: number) => boolean);
  /** What a speaker/notify device writes back before closing; default `ok\n`, `''` none. */
  status?: string;
}

/** Device side of one forwarded socket. Speaker/notify payloads complete at the host's EOF;
 * the device then reports its player's status line and closes. */
export class FakeSocket {
  readonly file: string;
  readonly payloads: Buffer[] = [];
  connections = 0;
  readonly hostClosed: Promise<void>;
  private readonly server: net.Server;
  private readonly behaviour: FakeBehaviour;
  private readonly sockets = new Set<net.Socket>();
  private readonly waiters: ((payload: Buffer) => void)[] = [];
  private hostClose!: () => void;

  constructor(file: string, server: net.Server, behaviour: FakeBehaviour) {
    this.file = file;
    this.server = server;
    this.behaviour = behaviour;
    this.hostClosed = new Promise((resolve) => { this.hostClose = resolve; });
    server.on('connection', (socket) => this.accept(socket));
  }

  private accept(socket: net.Socket): void {
    this.connections++;
    const drop = this.behaviour.drop;
    if (typeof drop === 'function' ? drop(this.connections) : drop) { socket.destroy(); return; }
    this.sockets.add(socket);
    const chunks: Buffer[] = [];
    socket.on('error', () => {});
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('end', () => {
      this.hostClose();
      const payload = Buffer.concat(chunks);
      const waiter = this.waiters.shift();
      if (waiter) waiter(payload); else this.payloads.push(payload);
      if (!this.behaviour.hold) socket.end(this.behaviour.status ?? '');
    });
    if (this.behaviour.send) {
      const chunks = [...this.behaviour.send];
      const write = () => { const next = chunks.shift(); if (next) socket.write(next, () => setImmediate(write)); };
      write();
    }
  }

  next(): Promise<Buffer> {
    const payload = this.payloads.shift();
    return payload ? Promise.resolve(payload) : new Promise((resolve) => this.waiters.push(resolve));
  }

  close(): void {
    for (const socket of this.sockets) socket.destroy();
    this.server.close();
  }
}

/** Listen on DIR/ID.KIND.sock with BEHAVIOUR. */
export async function fakeSocket(t: TestContext, dir: string, id: string, kind: string,
  behaviour: FakeBehaviour = {}): Promise<FakeSocket> {
  const file = path.join(dir, `${id}.${kind}.sock`);
  const server = net.createServer({ allowHalfOpen: true });
  server.listen(file);
  await once(server, 'listening');
  // Microphones report no status.
  const device = new FakeSocket(file, server, { ...behaviour, status: kind === 'mic' ? '' : behaviour.status ?? 'ok\n' });
  t.after(() => device.close());
  return device;
}

/** A socket file whose listener died without cleanup, so connecting is refused. */
export function refusedSocket(file: string): void {
  const result = spawnSync(process.execPath, ['-e',
    `require('node:net').createServer().listen(${JSON.stringify(file)}, () => process.kill(process.pid, 'SIGKILL'))`]);
  assert.equal(result.signal, 'SIGKILL');
  assert.ok(fs.lstatSync(file).isSocket());
}

/** Set FILE's modification time AGE_MS in the past. */
export function age(file: string, ageMs: number): void {
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(file, when, when);
}
