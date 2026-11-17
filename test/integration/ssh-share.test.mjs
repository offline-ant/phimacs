// Device sharing over real OpenSSH, an opt-in lane (PHIMACS_SSH_SHARE=1). A user-level
// sshd on a random localhost port with disposable keys and configuration carries the
// forwards of `bin/phimacs share` (real ssh and socat) to the compiled pi-sound CLI on
// the host side. Recording stand-ins replace parecord, pacat and notify-send, and a
// local HTTP server the speech/transcription backends: no audio device or provider.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(import.meta.dirname, '../..');
const launcher = path.join(root, 'bin/phimacs');
const soundCli = path.join(root, 'packages/sound/dist/main.js');
const executable = name => [...(process.env.PATH ?? '').split(':'), '/usr/sbin', '/usr/local/sbin', '/usr/bin', '/bin']
  .filter(Boolean).map(directory => path.join(directory, name)).find(file => {
    try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; }
  });
const tools = Object.fromEntries(['sshd', 'ssh', 'ssh-keygen', 'socat', 'pgrep'].map(name => [name, executable(name)]));
const missing = Object.keys(tools).filter(name => !tools[name]);
const skip = process.env.PHIMACS_SSH_SHARE !== '1' ? 'Set PHIMACS_SSH_SHARE=1 for device sharing through a disposable user-level sshd'
  : missing.length ? `Device sharing over SSH needs ${missing.join(', ')}` : false;
/** The device name the launcher derives from this machine's short host name. */
const deviceName = os.hostname().split('.')[0].replace(/[^A-Za-z0-9_-]/g, '_') || 'device';

async function until(check, description, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    assert.ok(Date.now() < deadline, `Timed out: ${description}`);
    await delay(50);
  }
}

function run(command, args, options) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 20_000, ...options });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}: ${result.error?.message ?? ''}${result.stderr}`);
  return result.stdout;
}

/** 16-bit PCM WAV, mono. */
function wav(samples, rate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + samples.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
}

test('a device shares its microphone, speaker and notifications through real OpenSSH', { skip, timeout: 120_000 }, async t => {
  for (const file of [soundCli, path.join(root, 'packages/pimux/dist/service-client.js')]) {
    assert.ok(fs.existsSync(file), `Missing ${file}; run npm run compile first`);
  }
  const { speakerSamples, wavSamples } = await import(path.join(root, 'packages/sound/dist/index.js'));
  // Short: forwarded socket paths must fit a Unix socket address.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'phimacs-ssh-'));
  fs.chmodSync(work, 0o700);
  const file = name => path.join(work, name);
  const children = [];
  t.after(async () => {
    for (const [child, group] of children.reverse()) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      try { process.kill(group ? -child.pid : child.pid, 'SIGTERM'); } catch { /* settled */ }
      await once(child, 'exit');
    }
    fs.rmSync(work, { recursive: true, force: true });
  });
  const share = file('share');
  const nodePath = `${path.dirname(process.execPath)}:/usr/bin:/bin`;

  for (const key of ['host', 'client']) run(tools['ssh-keygen'], ['-q', '-t', 'ed25519', '-N', '', '-C', `phimacs-test-${key}`, '-f', file(key)]);
  fs.copyFileSync(file('client.pub'), file('authorized_keys'));
  const port = await new Promise(resolve => {
    const probe = http.createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
  // Remote Unix-socket forwarding also needs TCP forwarding not to be disabled.
  fs.writeFileSync(file('sshd_config'), `Port ${port}
ListenAddress 127.0.0.1
HostKey ${file('host')}
PidFile ${file('sshd.pid')}
AuthorizedKeysFile ${file('authorized_keys')}
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
StrictModes no
PermitUserRC no
PrintMotd no
AllowStreamLocalForwarding yes
X11Forwarding no
SetEnv PHIMACS_SHARE_DIR=${share} PATH=${nodePath}
LogLevel VERBOSE
`);
  fs.writeFileSync(file('known_hosts'), `[127.0.0.1]:${port} ${fs.readFileSync(file('host.pub'), 'utf8')}`);
  fs.writeFileSync(file('ssh_config'), `Host phimacs-test
  HostName 127.0.0.1
  Port ${port}
  User ${os.userInfo().username}
  IdentityFile ${file('client')}
  IdentitiesOnly yes
  IdentityAgent none
  UserKnownHostsFile ${file('known_hosts')}
  GlobalKnownHostsFile /dev/null
  StrictHostKeyChecking yes
  ControlMaster no
  ControlPath none
`);
  const sshd = spawn(tools.sshd, ['-D', '-e', '-f', file('sshd_config')], { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'ignore', 'pipe'] });
  children.push([sshd, false]);
  let sshdLog = '';
  sshd.stderr.on('data', chunk => { sshdLog += chunk; });
  await until(() => /Server listening on 127\.0\.0\.1/.test(sshdLog) || sshd.exitCode !== null, 'sshd startup');
  assert.equal(sshd.exitCode, null, sshdLog);

  // The device: this ssh configuration, real socat and recording audio/notification tools.
  // Each player/notifier records its input only after "playing", so a delivery that
  // settled before the record exists closed before its child finished. They print stray
  // output, which must stay off the connection, and exit with their control file's code.
  const bin = file('device-bin');
  fs.mkdirSync(bin);
  const pcm = Buffer.alloc(3200);
  for (let index = 0; index < pcm.length; index += 2) pcm.writeInt16LE(index * 7 - 11_000, index);
  fs.writeFileSync(file('mic.pcm'), pcm);
  fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh\nexec ${tools.ssh} -F ${file('ssh_config')} "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'parecord'), `#!/bin/sh\nprintf '%s\\n' "$*" >${file('parecord.args')}\nexec cat ${file('mic.pcm')}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'pacat'), `#!/bin/sh
printf '%s\\n' "$*" >${file('pacat.args')}
played=${file('played')}/$(date +%s%N)
cat >"$played.part"
sleep 0.3; echo stray player output
mv "$played.part" "$played"
exit "$(cat ${file('player.exit')} 2>/dev/null || echo 0)"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'notify-send'), `#!/bin/sh
sleep 0.3; echo stray notifier output
for a; do printf '%s\\0' "$a"; done >${file('shown')}/$(date +%s%N)
exit "$(cat ${file('notifier.exit')} 2>/dev/null || echo 0)"
`, { mode: 0o755 });
  for (const directory of ['played', 'shown', 'tmp', 'device-home', 'host-home']) fs.mkdirSync(file(directory));
  const records = directory => fs.readdirSync(file(directory)).filter(name => !name.endsWith('.part')).sort()
    .map(name => fs.readFileSync(path.join(file(directory), name)));
  const deviceEnv = { PATH: `${bin}:${nodePath}`, HOME: file('device-home'), TMPDIR: file('tmp'), LANG: 'C.UTF-8',
    PHIMACS_HOST: 'phimacs-test', PHIMACS_REMOTE_COMMAND: launcher };
  const device = spawn(launcher, ['share'], { env: deviceEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  children.push([device, true]);
  let deviceLog = '';
  for (const stream of [device.stdout, device.stderr]) stream.on('data', chunk => { deviceLog += chunk; });
  const sockets = () => fs.existsSync(share) ? fs.readdirSync(share).sort() : [];
  const connected = () => {
    const ids = [...new Set(sockets().map(name => name.split('.')[0]))];
    return ids.length === 1 && sockets().length === 3 && ids[0];
  };
  const first = await until(connected, 'three forwarded sockets');
  assert.match(first, new RegExp(`^${deviceName}-[0-9a-f]{8}$`), deviceLog);
  assert.equal(fs.statSync(share).mode & 0o777, 0o700);
  for (const name of sockets()) assert.ok(fs.lstatSync(path.join(share, name)).isSocket(), name);

  // The host: the pi-sound CLI with shared devices and local synthetic backends.
  const synthesized = wav(Buffer.from(Array.from({ length: 4410 }, (_, index) => [index % 256, 8]).flat()), 22_050);
  let transcribed = Buffer.alloc(0);
  let speechRequests = 0;
  const backend = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (request.url === '/v1/audio/speech') { speechRequests++; return response.end(synthesized); }
    transcribed = Buffer.concat(chunks);
    response.setHeader('content-type', 'application/json');
    response.end('{"text":"shared microphone"}');
  }).listen(0, '127.0.0.1');
  await once(backend, 'listening');
  t.after(() => { backend.closeAllConnections(); backend.close(); });
  const url = `http://127.0.0.1:${backend.address().port}`;
  const agent = file('agent');
  fs.mkdirSync(agent, { mode: 0o700 });
  fs.writeFileSync(path.join(agent, 'voice.json'), JSON.stringify({ backend: 'local', options: { url }, mode: 'type', share: true,
    speech: { backend: 'openai-speech', options: { url, model: 'tts', voice: 'marin' } } }), { mode: 0o600 });
  const hostEnv = { PATH: nodePath, HOME: file('host-home'), PI_CODING_AGENT_DIR: agent, PHIMACS_SHARE_DIR: share };
  /** The CLI with an open standard input, as a frontend runs it. */
  const sound = async (...args) => {
    const child = spawn(process.execPath, [soundCli, ...args], { env: hostEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const [code] = await once(child, 'close');
    child.stdin.destroy();
    return { code, stdout, stderr };
  };

  // Speech probes with one silent sample, then plays; each delivery settled only after
  // playing, on the device's `ok` status line.
  const spoken = await sound('speak', '--play', 'Shared speech over SSH.');
  assert.equal(spoken.code, 0, spoken.stderr);
  assert.equal(speechRequests, 1);
  assert.deepEqual(JSON.parse(spoken.stdout), { type: 'played', backend: 'openai-speech', device: deviceName, chunks: 1 });
  assert.deepEqual(records('played'), [Buffer.alloc(2), speakerSamples(synthesized)]);
  assert.equal(fs.readFileSync(file('pacat.args'), 'utf8'), '--playback --raw --format=s16le --rate=44100 --channels=1\n');
  const done = await sound('play', 'done');
  assert.equal(done.code, 0, done.stderr);
  assert.deepEqual(records('played').at(-1), wavSamples(fs.readFileSync(path.join(root, 'packages/sound/sounds/done.wav'))));
  const shown = await sound('notify', 'Build finished', 'All checks passed\nsecond line');
  assert.equal(shown.code, 0, shown.stderr);
  assert.deepEqual(records('shown').map(record => record.toString().split('\0').slice(0, -1)),
    [['--app-name=Phimacs', '--', 'Build finished', 'All checks passed\nsecond line']]);
  const dictated = await sound('dictate');
  assert.equal(dictated.code, 0, dictated.stderr);
  assert.deepEqual(dictated.stdout.trim().split('\n').map(line => JSON.parse(line)).map(message => [message.type, message.device ?? message.text]),
    [['ready', deviceName], ['final', 'shared microphone']]);
  assert.ok(transcribed.includes(pcm), 'the transcription request carries the device microphone PCM');
  assert.equal(fs.readFileSync(file('parecord.args'), 'utf8'), '--raw --format=s16le --rate=16000 --channels=1\n');

  // A failing player or notifier is reported through the status line, never as delivered;
  // a failing probe stops speech before anything is synthesized.
  fs.writeFileSync(file('player.exit'), '3');
  const failedPlay = await sound('play', 'done');
  assert.equal(failedPlay.code, 1);
  assert.equal(failedPlay.stderr, `pi-sound: Shared speaker device ${deviceName} failed: player exited 3\n`);
  const failedProbe = await sound('speak', '--play', 'Not synthesized.');
  assert.equal(failedProbe.code, 1);
  assert.equal(failedProbe.stderr, `pi-sound: Shared speaker device ${deviceName} failed: player exited 3\n`);
  assert.deepEqual(records('played').at(-1), Buffer.alloc(2), 'the probe reached the failing player');
  assert.equal(speechRequests, 1, 'speech is never synthesized after a failed probe');
  fs.writeFileSync(file('notifier.exit'), '5');
  const failedNotify = await sound('notify', 'Not shown');
  assert.equal(failedNotify.code, 1);
  assert.equal(failedNotify.stderr, `pi-sound: Shared notification device ${deviceName} failed: notifier exited 5\n`);
  for (const control of ['player.exit', 'notifier.exit']) fs.rmSync(file(control));

  // A dead device listener: its forward ends, so no delivery can succeed on it; a new ID follows.
  const listener = run(tools.pgrep, ['-f', `UNIX-LISTEN:${file('tmp')}/phimacs-share\\..*/notify\\.sock`]).trim().split('\n').map(Number);
  assert.equal(listener.length, 1);
  process.kill(listener[0], 'SIGKILL');
  const lost = await sound('notify', 'Nobody', 'listens');
  assert.equal(lost.code, 1, 'a notification to a dead listener is never reported as shown');
  assert.match(lost.stderr, /No shared notification device answers|Shared notification device .* failed/);
  const second = await until(() => connected() !== first && connected(), 'reconnection under a new ID', 20_000);
  assert.deepEqual(sockets(), ['mic', 'notify', 'speaker'].map(kind => `${second}.${kind}.sock`), 'the first ID released its own sockets');
  assert.match(deviceLog, /the notify listener stopped/);
  const again = await sound('notify', 'Reconnected');
  assert.equal(again.code, 0, again.stderr);
  assert.equal(records('shown').length, 3, 'the shown, the failed and the reconnected notification');

  device.kill('SIGTERM');
  const [code] = await once(device, 'exit');
  assert.equal(code, 0, deviceLog);
  assert.deepEqual(sockets(), [], 'the stopped share released its remote sockets');
  assert.deepEqual(fs.readdirSync(file('tmp')), [], 'the device removed its local sockets');
  assert.throws(() => process.kill(-device.pid, 0), { code: 'ESRCH' }, 'no device process outlives the share');
});
