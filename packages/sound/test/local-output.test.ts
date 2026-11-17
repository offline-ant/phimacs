import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import {
  BackendRegistry, localBackend, localTranscriber, notifyDevice, parseLocalOptions, playSound,
  soundFile, wav, wavSamples, type OutputSink,
} from '../src/index.ts';

async function server(handler: http.RequestListener) {
  const host = http.createServer(handler);
  host.listen(0, '127.0.0.1');
  await once(host, 'listening');
  const address = host.address();
  assert.ok(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}`, async close() {
    host.closeAllConnections();
    await new Promise<void>((resolve, reject) => host.close((error) => error ? reject(error) : resolve()));
  } };
}

test('local backend posts complete WAV, explicit model/language/headers and trims final text', async (t) => {
  const requests: { body: Buffer; url?: string; authorization?: string }[] = [];
  const host = await server(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const data of req) chunks.push(Buffer.from(data));
    requests.push({ body: Buffer.concat(chunks), url: req.url, authorization: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ text: ' hello from synthetic server ' }));
  });
  t.after(() => host.close());
  const registry = new BackendRegistry().register('local', localBackend);
  const backend = await registry.prepare('local', { url: host.url, model: 'example-model', headers: { Authorization: 'Bearer synthetic' } })
    .open({ partial() {}, error() {} }, new AbortController().signal);
  backend.write(Buffer.from([1, 2, 3, 4]));
  assert.equal(await backend.finish(), 'hello from synthetic server');
  assert.equal(await backend.finish(), 'hello from synthetic server');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/v1/audio/transcriptions');
  assert.equal(requests[0].authorization, 'Bearer synthetic');
  assert.ok(requests[0].body.includes(wav(Buffer.from([1, 2, 3, 4]))));
  assert.match(requests[0].body.toString(), /example-model/);
  assert.match(requests[0].body.toString(), /name="language"\r\n\r\nen/);
  backend.close(); backend.close();
});

test('local validation has no implicit endpoint and server errors do not expose response bodies', async (t) => {
  for (const value of [{}, { url: 'file:///x' }, { url: 'http://u:p@localhost' }, { url: 'http://localhost?secret=x' },
    { url: 'http://localhost', timeoutMs: 0 }, { url: 'http://localhost', headers: { a: 1 } }, { url: 'http://localhost', extra: true }]) {
    assert.throws(() => parseLocalOptions(value));
  }
  const host = await server((_req, res) => { res.statusCode = 401; res.end('synthetic-secret-echo'); });
  t.after(() => host.close());
  const backend = localTranscriber({ url: host.url });
  backend.write(Buffer.from([1, 2]));
  await assert.rejects(backend.finish(), (error: unknown) => error instanceof Error &&
    error.message.includes('HTTP 401') && !error.message.includes('synthetic-secret-echo'));
  backend.close();
});

test('local empty audio avoids networking; close cancels an in-flight request', async (t) => {
  const empty = localTranscriber({ url: 'http://127.0.0.1:1' });
  assert.equal(await empty.finish(), '');
  empty.close();
  let accepted!: () => void;
  const received = new Promise<void>((resolve) => { accepted = resolve; });
  const host = await server((_req, _res) => { accepted(); });
  t.after(() => host.close());
  const backend = localTranscriber({ url: host.url });
  backend.write(Buffer.from([1, 2]));
  const finished = backend.finish();
  await received;
  backend.close();
  await assert.rejects(finished, /cancelled/);
});

test('output is silent without an explicit sink and injected sinks get validated samples', async () => {
  assert.equal(await playSound(undefined, 'done'), null);
  assert.equal(await notifyDevice(undefined, 'unused'), null);
  const played: Buffer[] = [];
  const notices: string[][] = [];
  const sink: OutputSink = {
    async play(pcm) { played.push(pcm); return 'synthetic-output'; },
    async notify(title, body) { notices.push([title, body]); return 'synthetic-output'; },
  };
  for (const sound of ['done', 'request'] as const) {
    const samples = wavSamples(fs.readFileSync(soundFile(sound)));
    assert.ok(samples.length > 0 && samples.length % 2 === 0);
    assert.equal(await playSound(sink, sound), 'synthetic-output');
  }
  await notifyDevice(sink, 'hello\r\nworld', 'body');
  assert.equal(played.length, 2);
  assert.deepEqual(notices, [['hello world', 'body']]);
  assert.throws(() => wavSamples(Buffer.alloc(2)), /Not a WAV/);
  const truncated = fs.readFileSync(soundFile('done')).subarray(0, 40);
  assert.throws(() => wavSamples(truncated), /Truncated|no data/);
  assert.throws(() => wav(Buffer.from([1])), /complete/);
});
