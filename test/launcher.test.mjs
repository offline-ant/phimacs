// The standalone Bash launcher: remote dispatch, client installation, device sharing
// (with recording ssh/socat stand-ins) and the host side of share protocol 1.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { listShares, prepareShare, releaseShare, shareDirectory, STALE_MS } from '../scripts/share-host.mjs';

const launcher = path.resolve(import.meta.dirname, '../bin/phimacs');
const which = name => spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();
const shells = ['sh', 'bash', 'fish'].filter(which);
/** The only system programs a device offers, so absent tools are really absent. */
const SYSTEM = ['bash', 'sh', 'fish', 'od', 'tr', 'mktemp', 'uname', 'date', 'sleep', 'readlink', 'dirname', 'cat',
  'flock', 'chmod', 'mkdir', 'rm', 'grep', 'mv', 'node', 'head', 'env', 'seq'];

/** The script `remote_line` sent: its octal escapes decoded. */
const remoteScript = line => Buffer.from([...line.matchAll(/\\([0-7]{3})/g)].map(match => parseInt(match[1], 8))).toString();

/** A process that has not ended; a zombie counts as ended. */
function alive(pid) {
  try { return !/^\d+ \(.*\) Z /s.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; }
}

/** Whether any process remains in the group led by PID. */
function groupAlive(pid) {
  try { process.kill(-pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

const exited = child => child.exitCode !== null || child.signalCode !== null
  ? Promise.resolve(child.exitCode ?? child.signalCode)
  : new Promise(resolve => child.once('exit', (code, signal) => resolve(code ?? signal)));

async function until(check, description, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    assert.ok(Date.now() < deadline, `Timed out: ${description}`);
    await delay(20);
  }
}

/** A disposable device: recording ssh that runs remote commands through a chosen login shell. */
function device(t, { shell = 'sh', tools = ['socat', 'parecord', 'pacat', 'notify-send'] } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phimacs-device-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'bin');
  const system = path.join(directory, 'system');
  const log = path.join(directory, 'ssh.log');
  fs.mkdirSync(bin);
  fs.mkdirSync(system);
  for (const name of SYSTEM) if (which(name)) fs.symlinkSync(which(name), path.join(system, name));
  fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/bash
# Records argv; runs a remote command line the way sshd does, through the login shell.
# exec keeps one PID, so ending this "client" also ends its simulated remote command.
# One printf is one write, so concurrent or killed stubs never split a record.
format=; for arg; do format+='%s\\0'; done
printf "$format\\n" "$@" >>${JSON.stringify(log)}
forward=
while [ $# -gt 0 ]; do
  case $1 in -N) forward=1; shift ;; -o|-R|-S) shift 2 ;; --) shift; break ;; -*) shift ;; *) break ;; esac
done
destination=$1
shift
# A forward is ready once recorded: forward.pids, and forward@DESTINATION.pids per host.
if [ -n "$forward" ]; then
  echo $$ >>${JSON.stringify(path.join(directory, 'forward.pids'))}
  echo $$ >>${JSON.stringify(directory)}/forward@$destination.pids
  exec sleep 1000
fi
[ $# -gt 0 ] || exit 0
exec ${shell} -c "exec $*"
`, { mode: 0o755 });
  for (const tool of tools) {
    fs.writeFileSync(path.join(bin, tool), tool === 'socat'
      ? `#!/bin/sh
printf '%s\\n' "$*" >>${JSON.stringify(path.join(directory, 'socat.log'))}
case $* in *mic.sock*) kind=mic ;; *speaker.sock*) kind=speaker ;; *) kind=notify ;; esac
echo $$ >>${JSON.stringify(directory)}/socat-$kind.pids
exec sleep 1000
`
      : '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  const env = { PATH: `${bin}:${system}`, HOME: path.join(directory, 'home'), TMPDIR: directory,
    PHIMACS_HOST: 'box', PHIMACS_REMOTE_COMMAND: launcher, PHIMACS_SHARE_DIR: path.join(directory, 'share') };
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '').split('\n').filter(Boolean)
    .map(line => line.split('\0').slice(0, -1));
  /** PIDs a stub recorded: `forward` (and `forward@HOST`) for ssh -N, `socat-KIND` for listeners. */
  const pids = name => {
    const file = path.join(directory, `${name}.pids`);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(Number) : [];
  };
  const state = path.join(directory, 'home/.local/state/phimacs-client');
  /** The persistent share's lock/pid file prefix for DESTINATION. */
  const shareFiles = (destination = 'box') => path.join(state, `share-${Buffer.from(destination).toString('hex')}`);
  return { directory, bin, env, calls, pids, state, shareFiles };
}

/** The connection ID and forwarded kinds of an ssh -N call. */
function forwarded(call) {
  const forwards = call.filter((_, index) => call[index - 1] === '-R');
  return { id: /\/([^/]+)\.(?:mic|speaker|notify)\.sock:/.exec(forwards[0])?.[1],
    kinds: forwards.map(forward => /\.(mic|speaker|notify)\.sock:/.exec(forward)[1]), destination: call.at(-1) };
}

/** A remote frame that serves share-host calls and otherwise records its PID and stays open. */
function blockingFrame(box) {
  const frame = path.join(box.directory, 'blocking-frame');
  fs.writeFileSync(frame, `#!/bin/sh
case $2 in share-host) exec ${JSON.stringify(launcher)} "$@" ;; esac
echo $$ >${JSON.stringify(path.join(box.directory, 'frame.pid'))}
exec sleep 1000
`, { mode: 0o755 });
  return frame;
}

for (const shell of shells) test(`remote commands reach the host verbatim through a ${shell} login shell`, t => {
  const box = device(t, { shell });
  const printer = path.join(box.directory, 'argv');
  fs.writeFileSync(printer, '#!/bin/sh\nfor a; do printf "%s\\0" "$a"; done\n', { mode: 0o755 });
  const hostile = ['a b', "it's", '\\', '\\\\\'', '$HOME', '"q"', '`id`', '$(id)', '', '*', 'new\nline', '%s%%', 'é', ';exit 3', '-x'];
  const result = spawnSync(launcher, ['status', ...hostile], { encoding: 'utf8', env: { ...box.env, PHIMACS_REMOTE_COMMAND: printer } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.split('\0').slice(0, -1), ['--local', 'status', ...hostile]);
  const [call] = box.calls();
  assert.equal(call[0], '-T', 'a non-interactive command gets no remote terminal');
  assert.equal(call.at(-2), 'box');
});

test('an interactive remote frame gets a terminal; an option-like PHIMACS_HOST is refused', t => {
  const box = device(t);
  const closed = path.join(box.directory, 'closed-frame');
  fs.writeFileSync(closed, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const result = spawnSync('/usr/bin/script', ['-qec', `'${launcher}' --gui`, '/dev/null'],
    { encoding: 'utf8', env: { ...box.env, PHIMACS_REMOTE_COMMAND: closed } });
  assert.equal(result.status, 0, result.stdout);
  const [call] = box.calls();
  assert.deepEqual(call.slice(0, 3), ['-t', '--', 'box']);
  assert.equal(remoteScript(call[3]), `exec '${closed}' --local '--gui'`);
  const option = spawnSync(launcher, ['status'], { encoding: 'utf8', env: { ...box.env, PHIMACS_HOST: '-oProxyCommand=sh' } });
  assert.equal(option.status, 1);
  assert.match(option.stderr, /PHIMACS_HOST must be an SSH destination, not an option/);
  assert.equal(box.calls().length, 1);
});

test('--local and device-only commands never use PHIMACS_HOST; client prints the script itself', t => {
  const box = device(t);
  const local = spawnSync(launcher, ['--local', 'client'], { encoding: 'utf8', env: box.env });
  assert.equal(local.status, 0, local.stderr);
  assert.equal(local.stdout, fs.readFileSync(launcher, 'utf8'));
  assert.deepEqual(box.calls(), []);
  const remote = spawnSync(launcher, ['client'], { encoding: 'utf8', env: box.env });
  assert.equal(remote.stdout, fs.readFileSync(launcher, 'utf8'));
  const [call] = box.calls();
  assert.deepEqual(call.slice(0, 3), ['-T', '--', 'box']);
  assert.equal(remoteScript(call[3]), `exec '${launcher}' --local 'client'`);
});

test('host commands need no HOME; sharing without HOME or XDG_STATE_HOME names what to set', t => {
  const box = device(t);
  const { HOME, ...homeless } = box.env;
  assert.ok(HOME);
  const share = path.join(box.directory, 'host-share');
  const prepared = spawnSync(launcher, ['--local', 'share-host', 'prepare'],
    { encoding: 'utf8', env: { ...homeless, PHIMACS_SHARE_DIR: share } });
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.equal(prepared.stdout.trim(), share);
  assert.equal(fs.statSync(share).mode & 0o777, 0o700);
  const printed = spawnSync(launcher, ['--local', 'client'], { encoding: 'utf8', env: homeless });
  assert.equal(printed.status, 0, printed.stderr);
  assert.equal(printed.stdout, fs.readFileSync(launcher, 'utf8'));
  for (const [args, env] of [[['share'], homeless], [['--gui'], { ...homeless, PHIMACS_SHARE: '1' }]]) {
    const refused = spawnSync(launcher, args, { encoding: 'utf8', env });
    assert.equal(refused.status, 1, args.join(' '));
    assert.match(refused.stderr, /^phimacs: sharing keeps its lock and log under XDG_STATE_HOME or HOME; set one of them$/m);
    assert.doesNotMatch(refused.stderr, /unbound variable/);
  }
  assert.deepEqual(box.calls(), []);
});

test('client install replaces the file atomically and keeps it on a failed download or verification', t => {
  const box = device(t);
  const target = path.join(box.directory, 'installed-phimacs');
  fs.writeFileSync(target, 'previous client\n', { mode: 0o755 });
  const install = env => spawnSync(launcher, ['client', 'install', target], { encoding: 'utf8', env });
  const leftovers = () => fs.readdirSync(box.directory).filter(name => name.startsWith('.phimacs-client.'));
  const broken = path.join(box.directory, 'broken');
  fs.writeFileSync(broken, '#!/bin/sh\necho "#!/usr/bin/env bash"; echo "not a phimacs client"\n', { mode: 0o755 });
  const failing = path.join(box.directory, 'failing');
  fs.writeFileSync(failing, '#!/bin/sh\nhead -c 100 "$0"; exit 1\n', { mode: 0o755 });
  for (const command of [broken, failing]) {
    const result = install({ ...box.env, PHIMACS_REMOTE_COMMAND: command });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /failed to download or verify; .* is unchanged/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'previous client\n');
    assert.deepEqual(leftovers(), []);
  }
  const result = install(box.env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(target, 'utf8'), fs.readFileSync(launcher, 'utf8'));
  assert.equal(fs.statSync(target).mode & 0o777, 0o755);
  assert.deepEqual(leftovers(), []);
});

test('a persistent share forwards each available kind under one fresh ID and releases only it', async t => {
  const box = device(t, { tools: ['socat', 'parecord', 'pacat'] });
  const share = spawn(launcher, ['share'], { env: box.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let stderr = '';
  share.stderr.on('data', chunk => { stderr += chunk; });
  t.after(() => { try { process.kill(-share.pid, 'SIGKILL'); } catch { /* settled */ } });
  const forward = await until(() => box.calls().find(call => call.includes('-N')), 'forwarding connection');
  // A ControlMaster from the user's SSH configuration would take over the forwards and end this client.
  assert.equal(forward[forward.indexOf('ControlPath=none') - 1], '-o', 'the forwarding connection is its own');
  const shareDirectory = box.env.PHIMACS_SHARE_DIR;
  assert.equal(fs.statSync(shareDirectory).mode & 0o777, 0o700, 'the host share directory was prepared privately');
  const forwards = forward.filter((_, index) => forward[index - 1] === '-R');
  const id = /\/([^/]+)\.mic\.sock:/.exec(forwards[0])?.[1];
  assert.match(id, /^[A-Za-z0-9_-]+-[0-9a-f]{8}$/);
  const local = path.dirname(forwards[0].split(':')[1]);
  assert.deepEqual(forwards, ['mic', 'speaker'].map(kind => `${shareDirectory}/${id}.${kind}.sock:${local}/${kind}.sock`));
  assert.match(stderr, /not sharing notify \(notify-send\): tool not installed/);
  const listeners = fs.readFileSync(path.join(box.directory, 'socat.log'), 'utf8');
  assert.match(listeners, new RegExp(`UNIX-LISTEN:${local}/mic\\.sock,fork,unlink-early,mode=600 EXEC:${local}/mic`));
  // The host settles playback when the device closes: socat waits for the player, not a short timer.
  assert.match(listeners, new RegExp(`^-t 3600 UNIX-LISTEN:${local}/speaker\\.sock,fork,unlink-early,mode=600 EXEC:${local}/speaker$`, 'm'));
  assert.equal(fs.readFileSync(`${box.shareFiles()}.pid`, 'utf8'), `${share.pid}\n`);
  const second = spawnSync(launcher, ['share'], { encoding: 'utf8', env: box.env });
  assert.equal(second.status, 1);
  assert.match(second.stderr, new RegExp(`a persistent share to box already runs \\(pid ${share.pid}\\)`));
  // Another device's sockets in the same directory are never touched by this one.
  fs.writeFileSync(path.join(shareDirectory, 'other-0011aabb.mic.sock'), '');
  const owned = [...box.pids('forward'), ...box.pids('socat-mic'), ...box.pids('socat-speaker')];
  assert.equal(owned.length, 3);
  share.kill('SIGTERM');
  assert.equal(await exited(share), 0);
  assert.deepEqual(owned.filter(alive), [], 'the forward and listeners were settled before the share ended');
  assert.equal(remoteScript(box.calls().at(-1).at(-1)), `exec '${launcher}' --local 'share-host' 'release' '${id}'`);
  assert.equal(fs.existsSync(local), false, 'the local share directory is removed');
  assert.equal(fs.existsSync(`${box.shareFiles()}.pid`), false);
  assert.ok(fs.existsSync(path.join(shareDirectory, 'other-0011aabb.mic.sock')));
});

test('device players and notifiers answer one status line only after their child exits', async t => {
  const box = device(t);
  // Recording stand-ins: they finish after a moment, print stray output that must stay
  // off the connection, and exit with the code in their control file (default 0).
  const exitCode = name => path.join(box.directory, `${name}.exit`);
  fs.writeFileSync(path.join(box.bin, 'pacat'), `#!/bin/sh
cat >${JSON.stringify(path.join(box.directory, 'played.part'))}
sleep 0.2; echo stray player output
mv ${JSON.stringify(path.join(box.directory, 'played.part'))} ${JSON.stringify(path.join(box.directory, 'played'))}
exit "$(cat ${JSON.stringify(exitCode('pacat'))} 2>/dev/null || echo 0)"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(box.bin, 'notify-send'), `#!/bin/sh
for a; do printf '%s\\0' "$a"; done >${JSON.stringify(path.join(box.directory, 'shown.part'))}
sleep 0.2; echo stray notifier output
mv ${JSON.stringify(path.join(box.directory, 'shown.part'))} ${JSON.stringify(path.join(box.directory, 'shown'))}
exit "$(cat ${JSON.stringify(exitCode('notify-send'))} 2>/dev/null || echo 0)"
`, { mode: 0o755 });
  const share = spawn(launcher, ['share'], { env: box.env, stdio: 'ignore', detached: true });
  t.after(() => { try { process.kill(-share.pid, 'SIGKILL'); } catch { /* settled */ } });
  // socat is a recording stand-in here: run the commands its listeners would EXEC.
  const local = await until(() => /EXEC:(\S+)\/speaker$/m.exec(fs.existsSync(path.join(box.directory, 'socat.log'))
    ? fs.readFileSync(path.join(box.directory, 'socat.log'), 'utf8') : '')?.[1], 'speaker listener');
  await until(() => box.pids('socat-notify').length === 1, 'notify listener');
  /** A connection's answer, and whether the child had finished before the first answer byte. */
  const answer = async (kind, input, record) => {
    for (const name of ['played', 'shown']) fs.rmSync(path.join(box.directory, name), { force: true });
    const child = spawn(path.join(local, kind), { env: box.env, stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    let finishedFirst;
    child.stdout.on('data', chunk => {
      finishedFirst ??= fs.existsSync(path.join(box.directory, record));
      stdout += chunk;
    });
    child.stdin.end(input);
    assert.equal(await exited(child), 0);
    return { stdout, finishedFirst, record: fs.readFileSync(path.join(box.directory, record)) };
  };
  const probe = await answer('speaker', Buffer.alloc(2), 'played');
  assert.deepEqual(probe, { stdout: 'ok\n', finishedFirst: true, record: Buffer.alloc(2) }, 'the 2-byte probe is played and answered');
  const pcm = Buffer.from(Array.from({ length: 4410 }, (_, index) => index % 251));
  assert.deepEqual(await answer('speaker', pcm, 'played'), { stdout: 'ok\n', finishedFirst: true, record: pcm });
  fs.writeFileSync(exitCode('pacat'), '3');
  assert.deepEqual(await answer('speaker', pcm, 'played'), { stdout: 'error 3\n', finishedFirst: true, record: pcm });
  const shown = await answer('notify', 'Agent finished\nAll tests pass', 'shown');
  assert.deepEqual([shown.stdout, shown.finishedFirst, shown.record.toString().split('\0').slice(0, -1)],
    ['ok\n', true, ['--app-name=Phimacs', '--', 'Agent finished', 'All tests pass']]);
  fs.writeFileSync(exitCode('notify-send'), '5');
  assert.equal((await answer('notify', 'Title only', 'shown')).stdout, 'error 5\n');
  share.kill('SIGTERM');
  assert.equal(await exited(share), 0);
});

test('a dead listener ends its forward; the share reconnects under a new ID with the listener restarted', async t => {
  const box = device(t);
  const share = spawn(launcher, ['share'], { env: box.env, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  let stderr = '';
  share.stderr.on('data', chunk => { stderr += chunk; });
  t.after(() => { try { process.kill(-share.pid, 'SIGKILL'); } catch { /* settled */ } });
  const forwards = () => box.calls().filter(call => call.includes('-N'));
  const first = forwarded(await until(() => forwards()[0], 'first forwarding connection'));
  assert.deepEqual(first.kinds, ['mic', 'speaker', 'notify']);
  const [forwarder] = await until(() => box.pids('forward').length === 1 && box.pids('forward'), 'forwarder PID');
  const [mic] = box.pids('socat-mic');
  process.kill(mic, 'SIGKILL');
  await until(() => !alive(forwarder), 'the forward of the dead listener ends');
  const second = forwarded(await until(() => forwards()[1], 'reconnection after the backoff', 15_000));
  assert.notEqual(second.id, first.id, 'a reconnection uses a new ID');
  assert.deepEqual(second.kinds, ['mic', 'speaker', 'notify'], 'every kind is forwarded again');
  assert.equal(box.pids('socat-mic').length, 2, 'only the dead listener was restarted');
  assert.ok(alive(box.pids('socat-mic')[1]));
  assert.deepEqual([box.pids('socat-speaker').length, box.pids('socat-notify').length], [1, 1]);
  const calls = box.calls();
  const release = calls.findIndex(call => remoteScript(call.at(-1)) === `exec '${launcher}' --local 'share-host' 'release' '${first.id}'`);
  assert.ok(release > 0, 'the first connection released its own sockets');
  assert.ok(release < calls.findLastIndex(call => call.includes('-N')), 'before the next connection forwarded');
  assert.match(stderr, /the mic listener stopped/);
  share.kill('SIGTERM');
  assert.equal(await exited(share), 0);
  assert.equal(groupAlive(share.pid), false, 'no process of the share outlives it');
});

test('killing a persistent share shell releases its lock although its children survive', async t => {
  const box = device(t);
  const share = spawn(launcher, ['share'], { env: box.env, stdio: 'ignore', detached: true });
  t.after(() => { try { process.kill(-share.pid, 'SIGKILL'); } catch { /* settled */ } });
  await until(() => box.pids('forward').length === 1, 'forwarding connection');
  const children = [...box.pids('forward'), ...box.pids('socat-mic'), ...box.pids('socat-speaker'), ...box.pids('socat-notify')];
  const lock = `${box.shareFiles()}.lock`;
  assert.equal(spawnSync('flock', ['-n', lock, 'true']).status, 1, 'the running share holds the lock');
  process.kill(share.pid, 'SIGKILL');
  await exited(share);
  assert.deepEqual(children.filter(pid => !alive(pid)), [], 'the orphaned children still run');
  assert.equal(spawnSync('flock', ['-n', lock, 'true']).status, 0, 'no orphaned child holds the lock');
  const next = spawn(launcher, ['share'], { env: box.env, stdio: 'ignore', detached: true });
  t.after(() => { try { process.kill(-next.pid, 'SIGKILL'); } catch { /* settled */ } });
  await until(() => box.pids('forward').length === 2, 'a new persistent share forwards');
  next.kill('SIGTERM');
  assert.equal(await exited(next), 0);
});

test('persistent shares and their detection are per destination', async t => {
  const box = device(t);
  const forwardsTo = destination => box.calls().filter(call => call.includes('-N') && call.at(-1) === destination);
  const toBox = spawn(launcher, ['share'], { env: box.env, stdio: 'ignore', detached: true });
  t.after(() => { try { process.kill(-toBox.pid, 'SIGKILL'); } catch { /* settled */ } });
  await until(() => forwardsTo('box').length === 1, 'persistent share to box');
  // A session to another host still shares, although box has a persistent share. Its
  // frame stays open until the session's forward to other is up and recorded: the
  // "sharing" log line comes before the forwarder starts, so it is no readiness signal.
  const frame = path.join(box.directory, 'frame');
  fs.writeFileSync(frame, `#!/bin/sh\ncase $2 in share-host) exec ${JSON.stringify(launcher)} "$@" ;; esac
until [ -s ${JSON.stringify(path.join(box.directory, 'forward@other.pids'))} ]; do sleep 0.02; done\n`, { mode: 0o755 });
  const session = spawnSync(launcher, [], { encoding: 'utf8', timeout: 15_000,
    env: { ...box.env, PHIMACS_HOST: 'other', PHIMACS_SHARE: '1', PHIMACS_REMOTE_COMMAND: frame } });
  assert.equal(session.status, 0, session.stderr);
  assert.equal(forwardsTo('other').length, 1, 'the session forwarded to its own host');
  assert.deepEqual(box.pids('forward@other').filter(alive), [], 'the session settled its forward when its frame closed');
  assert.match(fs.readFileSync(path.join(box.state, 'share.log'), 'utf8'), /sharing mic speaker notify as other:/);
  const toOther = spawn(launcher, ['share'], { env: { ...box.env, PHIMACS_HOST: 'other' }, stdio: 'ignore', detached: true });
  t.after(() => { try { process.kill(-toOther.pid, 'SIGKILL'); } catch { /* settled */ } });
  await until(() => forwardsTo('other').length === 2, 'persistent share to other beside the one to box');
  assert.equal(fs.readFileSync(`${box.shareFiles('other')}.pid`, 'utf8'), `${toOther.pid}\n`);
  const again = spawnSync(launcher, ['share'], { encoding: 'utf8', env: { ...box.env, PHIMACS_HOST: 'other' } });
  assert.equal(again.status, 1);
  assert.match(again.stderr, new RegExp(`a persistent share to other already runs \\(pid ${toOther.pid}\\)`));
  for (const share of [toBox, toOther]) share.kill('SIGTERM');
  assert.deepEqual(await Promise.all([exited(toBox), exited(toOther)]), [0, 0]);
});

test('PHIMACS_SHARE=1 shares for a remote session unless a persistent share already runs', async t => {
  const box = device(t);
  const shareLog = path.join(box.env.HOME, '.local/state/phimacs-client/share.log');
  // The remote frame stays open until the session share's forward is up and recorded
  // (the "sharing" log line precedes the forwarder, so it is no readiness signal).
  const frame = path.join(box.directory, 'frame');
  fs.writeFileSync(frame, `#!/bin/sh\ncase $2 in share-host) exec ${JSON.stringify(launcher)} "$@" ;; esac
until [ -s ${JSON.stringify(path.join(box.directory, 'forward@box.pids'))} ]; do sleep 0.02; done\n`, { mode: 0o755 });
  const env = { ...box.env, PHIMACS_SHARE: '1', PHIMACS_REMOTE_COMMAND: frame };
  const session = spawnSync(launcher, [], { encoding: 'utf8', env, timeout: 15_000 });
  assert.equal(session.status, 0, session.stderr);
  assert.match(fs.readFileSync(shareLog, 'utf8'), /sharing mic speaker notify as box:/, 'the session share ran while the remote frame was open');
  assert.equal(box.pids('forward@box').length, 1, 'the session forwarded once while its frame was open');
  assert.deepEqual(box.pids('forward@box').filter(alive), [], 'and settled that forward when the frame ended');
  assert.ok(remoteScript(box.calls().at(-1).at(-1)).includes("'share-host' 'release'"), 'the session share released its sockets when the frame ended');
  const persistent = spawn(launcher, ['share'], { env: box.env, stdio: 'ignore', detached: true });
  t.after(() => { try { process.kill(-persistent.pid, 'SIGKILL'); } catch { /* settled */ } });
  await until(() => box.pids('forward@box').length === 2, 'persistent share forwarding');
  const before = box.calls().length;
  const closed = path.join(box.directory, 'closed-frame');
  fs.writeFileSync(closed, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const quick = spawnSync(launcher, [], { encoding: 'utf8', env: { ...env, PHIMACS_REMOTE_COMMAND: closed } });
  assert.equal(quick.status, 0, quick.stderr);
  assert.deepEqual(box.calls().slice(before).map(call => remoteScript(call.at(-1))), [`exec '${closed}' --local`], 'only the frame connection was made');
  persistent.kill('SIGTERM');
  await exited(persistent);
});

for (const [signal, code] of [['SIGTERM', 143], ['SIGHUP', 129], ['SIGINT', 130]]) {
  test(`a ${signal} to a sharing remote session settles its frame, share and remote sockets`, async t => {
    const box = device(t);
    const frame = blockingFrame(box);
    const env = { ...box.env, PHIMACS_SHARE: '1', PHIMACS_REMOTE_COMMAND: frame };
    const session = spawn(launcher, [], { env, stdio: 'ignore', detached: true });
    t.after(() => { try { process.kill(-session.pid, 'SIGKILL'); } catch { /* settled */ } });
    const framePid = path.join(box.directory, 'frame.pid');
    await until(() => fs.existsSync(framePid) && box.pids('forward').length === 1, 'open frame and session share');
    const owned = [Number(fs.readFileSync(framePid, 'utf8')), ...box.pids('forward'),
      ...['mic', 'speaker', 'notify'].flatMap(kind => box.pids(`socat-${kind}`))];
    const { id } = forwarded(box.calls().find(call => call.includes('-N')));
    process.kill(session.pid, signal);
    assert.equal(await exited(session), code);
    assert.deepEqual(owned.filter(alive), []);
    assert.equal(groupAlive(session.pid), false, 'no process of the session outlives it');
    assert.ok(box.calls().some(call => remoteScript(call.at(-1)) === `exec '${frame}' --local 'share-host' 'release' '${id}'`),
      'the session share released its own remote sockets');
    assert.deepEqual(fs.readdirSync(box.directory).filter(name => name.startsWith('phimacs-share.')), [], 'its local sockets are removed');
  });
}

test('a sharing remote frame keeps the terminal as its input', t => {
  const box = device(t);
  const typed = path.join(box.directory, 'typed');
  const frame = path.join(box.directory, 'reading-frame');
  fs.writeFileSync(frame, `#!/bin/sh\ncase $2 in share-host) exec ${JSON.stringify(launcher)} "$@" ;; esac
IFS= read -r line; printf '%s' "$line" >${JSON.stringify(typed)}\n`, { mode: 0o755 });
  const result = spawnSync('/usr/bin/script', ['-qec', `'${launcher}'`, '/dev/null'], { encoding: 'utf8', input: 'typed line\n',
    timeout: 15_000, env: { ...box.env, PHIMACS_SHARE: '1', PHIMACS_REMOTE_COMMAND: frame } });
  assert.equal(result.status, 0, result.stdout);
  assert.equal(fs.readFileSync(typed, 'utf8'), 'typed line');
  assert.deepEqual(box.calls().find(call => remoteScript(call.at(-1)) === `exec '${frame}' --local`).slice(0, 3), ['-t', '--', 'box']);
});

test('the host share directory is private and prunes only proven-stale sockets', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phimacs-share-host-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const env = { PHIMACS_SHARE_DIR: path.join(directory, 'share') };
  assert.equal(await prepareShare(env), env.PHIMACS_SHARE_DIR);
  assert.equal(fs.statSync(env.PHIMACS_SHARE_DIR).mode & 0o777, 0o700);
  const socket = name => path.join(env.PHIMACS_SHARE_DIR, name);
  const holder = spawn(process.execPath, ['-e', `const net = require("net");
for (const name of ${JSON.stringify(['old-00000001.mic.sock', 'young-00000002.mic.sock'])}) net.createServer().listen(${JSON.stringify(env.PHIMACS_SHARE_DIR)} + "/" + name);
setTimeout(() => console.log("up"), 100);`], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise(resolve => holder.stdout.once('data', resolve));
  holder.kill('SIGKILL');
  await new Promise(resolve => holder.once('exit', resolve));
  const live = net.createServer();
  await new Promise(resolve => live.listen(socket('live-00000003.speaker.sock'), resolve));
  t.after(() => live.close());
  const old = (Date.now() - STALE_MS - 5000) / 1000;
  for (const name of ['old-00000001.mic.sock', 'live-00000003.speaker.sock']) fs.utimesSync(socket(name), old, old);
  await prepareShare(env);
  assert.deepEqual(fs.readdirSync(env.PHIMACS_SHARE_DIR).sort(), ['live-00000003.speaker.sock', 'young-00000002.mic.sock'],
    'a refusing socket younger than the bind window and a live one are kept');
  assert.deepEqual(listShares(env).connections.map(connection => [connection.id, connection.kinds]),
    [['young-00000002', ['mic']], ['live-00000003', ['speaker']]]);
  releaseShare('young-00000002', env);
  assert.deepEqual(fs.readdirSync(env.PHIMACS_SHARE_DIR), ['live-00000003.speaker.sock']);
  assert.throws(() => releaseShare('../escape', env), /Invalid share connection ID/);
  fs.chmodSync(env.PHIMACS_SHARE_DIR, 0o755);
  await assert.rejects(prepareShare(env), /must be your own non-symlink directory with mode 0700/);
});

test('the share directory rule: default, trailing slashes, parents, symlinks and exact 0700', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phimacs-share-rule-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const refused = /must be your own non-symlink directory with mode 0700/;
  assert.equal(shareDirectory({}), `/tmp/phimacs-share-${process.getuid()}`);
  assert.equal(shareDirectory({ PHIMACS_SHARE_DIR: '' }), `/tmp/phimacs-share-${process.getuid()}`, 'empty means unset');
  assert.throws(() => shareDirectory({ PHIMACS_SHARE_DIR: 'relative/share' }), /must be absolute/);
  assert.equal(shareDirectory({ PHIMACS_SHARE_DIR: `${directory}/share///` }), `${directory}/share`);
  // Missing parents are created; the share directory is exactly 0700 whatever the umask.
  const nested = path.join(directory, 'a/b/share');
  assert.equal(await prepareShare({ PHIMACS_SHARE_DIR: `${nested}/` }), nested);
  assert.ok(fs.statSync(path.join(directory, 'a/b')).isDirectory());
  assert.equal(fs.statSync(nested).mode & 0o777, 0o700);
  const umask = process.umask(0o277);
  try { await prepareShare({ PHIMACS_SHARE_DIR: path.join(directory, 'masked') }); } finally { process.umask(umask); }
  assert.equal(fs.statSync(path.join(directory, 'masked')).mode & 0o777, 0o700);
  // A trailing slash would make lstat follow a symlink; the rule checks the link itself.
  fs.symlinkSync(nested, path.join(directory, 'link'));
  for (const value of [`${directory}/link`, `${directory}/link/`, `${directory}/link//`]) {
    await assert.rejects(prepareShare({ PHIMACS_SHARE_DIR: value }), refused, value);
    assert.throws(() => listShares({ PHIMACS_SHARE_DIR: value }), refused, value);
  }
  fs.symlinkSync(path.join(directory, 'missing'), path.join(directory, 'dangling'));
  await assert.rejects(prepareShare({ PHIMACS_SHARE_DIR: path.join(directory, 'dangling') }), refused);
  // The permission bits must be exactly 0700; other mode bits such as setgid are allowed.
  fs.chmodSync(nested, 0o500);
  await assert.rejects(prepareShare({ PHIMACS_SHARE_DIR: nested }), refused, 'a read-only 0500 directory is refused');
  fs.chmodSync(nested, 0o2700);
  assert.equal(fs.statSync(nested).mode & 0o7777, 0o2700);
  assert.equal(await prepareShare({ PHIMACS_SHARE_DIR: nested }), nested);
});

test('pruning keeps a stale socket that a device replaced while it was probed', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phimacs-share-prune-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const env = { PHIMACS_SHARE_DIR: path.join(directory, 'share') };
  await prepareShare(env);
  const file = path.join(env.PHIMACS_SHARE_DIR, 'dev-00000001.notify.sock');
  const holder = spawn(process.execPath, ['-e', `require("net").createServer().listen(${JSON.stringify(file)}, () => console.log("up"))`],
    { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise(resolve => holder.stdout.once('data', resolve));
  holder.kill('SIGKILL');
  await exited(holder);
  const old = (Date.now() - STALE_MS - 5000) / 1000;
  fs.utimesSync(file, old, old);
  // prepareShare probes the refusing socket; meanwhile the device binds a new one at the same path.
  const pending = prepareShare(env);
  fs.unlinkSync(file);
  const replacement = net.createServer();
  replacement.listen(file);
  t.after(() => replacement.close());
  await pending;
  assert.ok(fs.existsSync(file), 'the replacement socket was not pruned');
  await new Promise((resolve, reject) => net.connect(file).once('connect', function () { this.destroy(); resolve(); }).once('error', reject));
});
