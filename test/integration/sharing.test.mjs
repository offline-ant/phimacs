// Explicit long native lane: two real Emacs clients, one service, synthetic inference.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { SharingPeer, SharingRig, until } from '../support/sharing-rig.mjs';

const skip = process.env.PHIMACS_SHARING === '1' ? false : 'Set PHIMACS_SHARING=1 for isolated equal-Emacs integration';
const quote = JSON.stringify;
const runtimeId = state => state.runtime['mux-id'];

async function journey(t, action, options) {
  const rig = await SharingRig.create(options);
  t.diagnostic(`Marked namespace: ${rig.root}; minimal source closure: ${rig.runtime.root}`);
  try { await action(rig); }
  catch (error) { rig.failure = error; throw error; }
  finally { await rig.cleanup(); }
}

async function prompt(rig, name, text, client = 'first') {
  await rig.el(`(sharing-host-prompt ${quote(name)} ${quote(text)})`, client);
  return rig.settled(name, client);
}

async function closed(rig, name, client) {
  const state = await until(async () => {
    const current = await rig.state(name, client);
    return !current.alive && current;
  }, `${client} authoritative chat disposal`);
  assert.equal(state.inputAlive, false);
  assert.equal(state.tracked, false);
  assert.deepEqual(state.confirmations, [], 'Close never asks for confirmation');
}

async function attachBoth(rig, name) {
  await rig.el(`(sharing-host-create ${quote(name)})`);
  const first = await rig.live(name);
  await rig.el(`(sharing-host-attach ${quote(runtimeId(first))} ${quote(name)})`, 'second');
  const second = await rig.live(name, 'second');
  assert.deepEqual(second.identity, first.identity);
  assert.equal(runtimeId(second), runtimeId(first));
  assert.equal(second.file, first.file);
  return { first, second, entry: (await rig.list()).find(entry => entry.muxId === runtimeId(first)) };
}

for (const [frame, error] of [['{invalid JSON}\n', SyntaxError], ['null\n', assert.AssertionError]]) {
  test(`malformed peer frame ${frame.trim()} rejects through awaited cleanup`, async () => {
    const socket = new EventEmitter();
    socket.destroy = () => socket.emit('close');
    const peer = new SharingPeer(socket, () => true);
    const response = peer.wait(() => false, 'a valid frame');
    socket.emit('data', Buffer.from(frame));
    await assert.rejects(response, error);
    assert.equal(peer.closed, true);
    assert.equal(peer.ready, false);
  });
}

test('two minimal Emacs installations share prompts, dialogs, queues and context-bound drafts without replay',
  { skip, timeout: 180_000 }, t => journey(t, async rig => {
    await rig.startService();
    await rig.startEmacs();
    await rig.startEmacs('second');
    const { first, entry } = await attachBoth(rig, 'shared');
    const peer = await rig.peer(entry);

    for (const [client, text] of [['first', 'first client sends once'], ['second', 'second client sends once']]) {
      await prompt(rig, 'shared', text, client);
      for (const label of ['first', 'second']) {
        await until(async () => (await rig.state('shared', label)).text.includes(`reply: ${text}`), `${label} renders ${text}`);
      }
    }
    const messages = (await peer.request({ type: 'get_messages' })).data.messages;
    for (const text of ['first client sends once', 'second client sends once']) {
      assert.equal(messages.filter(message => message.role === 'user' && JSON.stringify(message.content).includes(text)).length, 1);
    }

    const dialogStart = peer.records.length;
    await rig.el('(sharing-host-prompt "shared" "/fx-select")');
    const dialog = await peer.wait(record => record.type === 'extension_ui_request' && record.method === 'select', 'shared dialog', dialogStart);
    for (const label of ['first', 'second']) {
      await until(async () => (await rig.state('shared', label)).dialogs.length === 1, `${label} sees the same dialog`);
    }
    await rig.el('(sharing-host-answer "shared" "apple")', 'second');
    await peer.wait(record => record.type === 'pimux_dialog_closed' && record.id === dialog.id, 'first answer closes the dialog', dialogStart);
    await peer.wait(record => record.type === 'extension_ui_request' && record.message === 'picked:apple', 'single winning answer', dialogStart);
    peer.send({ type: 'extension_ui_response', id: dialog.id, value: 'pear' });
    await peer.request({ type: 'get_state' }); // Process the late answer before checking its absence.
    await rig.settled('shared');
    for (const label of ['first', 'second']) {
      await until(async () => (await rig.state('shared', label)).dialogs.length === 0, `${label} applies dialog closure`);
    }
    assert.equal(peer.records.slice(dialogStart).filter(record => record.type === 'extension_ui_request' && String(record.message).startsWith('picked:')).length, 1);

    await peer.request({ type: 'set_model', provider: 'fx-slow', modelId: 'one' });
    await until(async () => (await rig.state('shared', 'second')).model.provider === 'fx-slow', 'model reaches both clients');
    const streamStart = peer.records.length;
    await rig.el('(sharing-host-prompt "shared" "stream 100")');
    await peer.wait(record => record.type === 'message_update' && JSON.stringify(record).includes('word'), 'real streaming', streamStart);
    await rig.el('(sharing-host-prompt "shared" "second client steers" "steer")', 'second');
    await until(async () => !(await rig.state('shared')).busy && (await rig.state('shared')).text.includes('reply: second client steers'), 'shared stream/steering settles');
    await peer.request({ type: 'set_model', provider: 'fx', modelId: 'two' });
    await until(async () => (await rig.state('shared')).model.id === 'two', 'authoritative model selection');

    const generation = peer.snapshot.generation;
    const mark = peer.records.length;
    await peer.request({ type: 'pimux_bootstrap', include: ['entries', 'messages'] });
    const snapshot = await peer.wait(record => record.type === 'pimux_snapshot' && record.generation > generation, 'new flat-entry snapshot', mark);
    assert.ok(Array.isArray(snapshot.entries));
    assert.equal(snapshot.session.file, first.file);
    await peer.wait(record => record.type === 'pimux_live' && record.generation === snapshot.generation, 'matching live boundary', mark);

    await rig.el('(sharing-host-prompt "shared" "hold queue")');
    await until(async () => (await rig.state('shared')).busy, 'held run');
    await peer.request({ type: 'prompt', message: 'queued follow-up', streamingBehavior: 'followUp' });
    await peer.request({ type: 'prompt', message: 'queued steering', streamingBehavior: 'steer' });
    for (const label of ['first', 'second']) {
      await until(async () => (await rig.state('shared', label)).queued?.length >= 2, `${label} sees global queue`);
    }
    const cleared = await peer.request({ type: 'clear_queue' });
    assert.match(JSON.stringify(cleared.data), /queued follow-up/);
    assert.match(JSON.stringify(cleared.data), /queued steering/);
    for (const label of ['first', 'second']) {
      await until(async () => !(await rig.state('shared', label)).queued?.length, `${label} sees queue removal`);
      assert.ok(!(await rig.state('shared', label)).quarantine.some(item => JSON.stringify(item).includes('queued follow-up')), 'requester-only queue recovery is not broadcast');
    }
    fs.writeFileSync(path.join(rig.env.FX_HOLD_DIR, 'queue'), 'released');
    await until(async () => !(await rig.state('shared')).busy, 'accepted run completes after queue clear');
    assert.ok(!(await peer.request({ type: 'get_messages' })).data.messages.some(message => message.role === 'user' && /queued follow-up|queued steering/.test(JSON.stringify(message.content))));

    await rig.el('(sharing-host-draft "shared" "draft bound to old branch")');
    const oldContext = { ...peer.snapshot.inputContext };
    const history = (await peer.request({ type: 'get_entries' })).data;
    const target = history.entries.find(item => item.message?.role === 'user');
    assert.ok(target);
    await peer.request({ type: 'prompt', message: `/fx-tree ${target.id}` });
    await until(async () => (await rig.state('shared')).quarantine.some(item => JSON.stringify(item).includes('draft bound to old branch')), 'branch move quarantines old draft');
    await peer.request({ type: 'prompt', message: 'stale-context text must not run', pimuxContext: oldContext }, false);
    await rig.el('(sharing-host-draft "shared" "first old-file draft")');
    await rig.el('(sharing-host-draft "shared" "second old-file draft")', 'second');
    const oldFile = (await rig.state('shared')).file;
    await peer.request({ type: 'new_session' });
    for (const [label, text] of [['first', 'first old-file draft'], ['second', 'second old-file draft']]) {
      const state = await until(async () => { const value = await rig.state('shared', label); return value.file !== oldFile && value; }, `${label} adopts new file`);
      assert.equal(state.draft, '');
      assert.ok(state.quarantine.some(item => JSON.stringify(item).includes(text)));
      assert.equal(runtimeId(state), entry.muxId);
    }

    const saved = path.join(rig.root, 'desktop.eld');
    await rig.el('(sharing-host-draft "shared" "persisted unsent input")');
    await rig.el(`(sharing-host-save "shared" ${quote(saved)})`);
    await rig.el('(sharing-host-prompt "shared" "hold zero-clients")');
    await until(async () => (await rig.state('shared')).busy, 'accepted work before frontend loss');
    peer.close();
    await rig.stopEmacs('second');
    await rig.stopEmacs();
    assert.equal(rig.identities.processIdentityStatus(entry.piIdentity), 'alive');
    fs.writeFileSync(path.join(rig.env.FX_HOLD_DIR, 'zero-clients'), 'released');
    await until(async () => (await rig.list()).find(item => item.muxId === entry.muxId)?.status === 'idle', 'accepted work survives zero clients');
    await rig.startEmacs();
    await rig.el(`(sharing-host-restore "restored" ${quote(saved)})`);
    const restored = await rig.live('restored');
    assert.deepEqual(restored.identity, first.identity);
    assert.equal(restored.draft, '', 'accepted work advanced the saved leaf; do not reuse its old draft');
    assert.ok(restored.quarantine.some(item => JSON.stringify(item).includes('persisted unsent input')));
    const back = await rig.peer(entry);
    const resumedMessages = (await back.request({ type: 'get_messages' })).data.messages;
    assert.equal(resumedMessages.filter(message => message.role === 'user' && JSON.stringify(message.content).includes('hold zero-clients')).length, 1);
    assert.ok(!resumedMessages.some(message => message.role === 'user' && /persisted unsent|stale-context/.test(JSON.stringify(message.content))));
    assert.equal((await rig.list()).length, 1);
    await rig.el('(sharing-host-close "restored" t)');
    await back.wait(record => record.type === 'pimux_exit', 'peer observes explicit Close');
    await closed(rig, 'restored', 'first');
    await rig.el(`(sharing-host-restore "closed" ${quote(saved)})`);
    assert.equal((await rig.state('closed')).alive, false);
    assert.equal((await rig.list()).length, 0);
  }));

test('a second Emacs attaches mid-tool and survives creating-client loss, then deck Close reaches every peer',
  { skip, timeout: 90_000 }, t => journey(t, async rig => {
    await rig.startService();
    await rig.startEmacs();
    await rig.startEmacs('second');
    await rig.el('(sharing-host-create "tool-root")');
    const original = await rig.live('tool-root');
    const entry = (await rig.list()).find(item => item.muxId === runtimeId(original));
    const peer = await rig.peer(entry);
    await rig.el('(sharing-host-prompt "tool-root" "gated tool")');
    await peer.wait(record => record.type === 'tool_execution_start', 'held tool begins');
    await rig.el(`(sharing-host-attach ${quote(entry.muxId)} "attached")`, 'second');
    const attached = await rig.live('attached', 'second');
    assert.equal(attached.busy, true);
    assert.deepEqual(attached.identity, original.identity);
    await rig.stopEmacs();
    fs.writeFileSync(path.join(rig.env.FX_HOLD_DIR, 'tool'), 'released');
    await until(async () => (await rig.state('attached', 'second')).text.includes('tool done: fx_hold'), 'accepted tool completes after creator loss');
    await prompt(rig, 'attached', 'attached client continues', 'second');
    assert.equal((await rig.list()).length, 1);
    await rig.el('(sharing-host-close "attached" t)', 'second');
    await peer.wait(record => record.type === 'pimux_exit', 'global Close reaches protocol peer');
    await closed(rig, 'attached', 'second');
    assert.equal(rig.identities.processIdentityStatus(entry.piIdentity), 'dead');
    assert.equal((await rig.list()).length, 0);
  }));

test('service restart restores one idle successor and both real Emacs views without prompt or draft replay',
  { skip, timeout: 120_000 }, t => journey(t, async rig => {
    await rig.startService();
    await rig.startEmacs();
    await rig.startEmacs('second');
    const { entry } = await attachBoth(rig, 'root');
    const peer = await rig.peer(entry);
    const oldContext = { ...peer.snapshot.inputContext };
    const saved = path.join(rig.root, 'service-desktop.eld');
    await rig.el('(sharing-host-draft "root" "unsent before service restart")');
    await rig.el(`(sharing-host-save "root" ${quote(saved)})`);
    await rig.el('(sharing-host-prompt "root" "hold service-restart")');
    await until(async () => (await rig.state('root')).busy, 'run active before service loss');
    await rig.stopChild(rig.service);
    assert.equal(rig.identities.processIdentityStatus(entry.piIdentity), 'dead');
    await rig.startService();
    const first = await until(async () => {
      const state = await rig.state('root');
      return state.runtime?.state === 'live' && runtimeId(state) !== entry.muxId && state;
    }, 'first client follows authoritative successor');
    const second = await until(async () => {
      const state = await rig.state('root', 'second');
      return state.runtime?.state === 'live' && runtimeId(state) === runtimeId(first) && state;
    }, 'second client follows same successor');
    assert.equal(first.busy, false);
    assert.equal(second.busy, false);
    assert.deepEqual(second.identity, first.identity);
    assert.ok(first.quarantine.some(item => JSON.stringify(item).includes('unsent before service restart')));
    await rig.el(`(sharing-host-restore "saved" ${quote(saved)})`);
    assert.equal(runtimeId(await rig.live('saved')), runtimeId(first));
    const successor = (await rig.list()).find(item => item.muxId === runtimeId(first));
    const back = await rig.peer(successor);
    await back.request({ type: 'prompt', message: 'stale successor input', pimuxContext: oldContext }, false);
    const messages = (await back.request({ type: 'get_messages' })).data.messages;
    assert.equal(messages.filter(message => message.role === 'user' && JSON.stringify(message.content).includes('hold service-restart')).length, 1);
    assert.ok(!messages.some(message => message.role === 'user' && /unsent before|stale successor/.test(JSON.stringify(message.content))));
    assert.equal((await rig.list()).length, 1);
    await rig.command(rig.runtime.pimux, ['stop', '--json', '--id', entry.muxId]);
    assert.equal((await rig.list()).length, 1, 'old identity-bound Close cannot stop successor');
    await rig.el('(sharing-host-close "root" t)', 'second');
    await back.wait(record => record.type === 'pimux_exit', 'successor explicit Close');
    for (const [name, label] of [['root', 'first'], ['saved', 'first'], ['root', 'second']]) await closed(rig, name, label);
  }));

test('unconfirmed Close from either real Emacs removes idle, busy and dialog-blocked agents everywhere',
  { skip, timeout: 180_000 }, t => journey(t, async rig => {
    await rig.startService();
    await rig.startEmacs();
    await rig.startEmacs('second');
    for (const closer of ['first', 'second']) {
      for (const phase of ['idle', 'busy', 'dialog']) {
        const name = `close-${closer}-${phase}`;
        const { entry } = await attachBoth(rig, name);
        const peer = await rig.peer(entry);
        const saved = path.join(rig.root, `${name}.eld`);
        await rig.el(`(sharing-host-save ${quote(name)} ${quote(saved)})`);
        if (phase === 'busy') {
          await rig.el(`(sharing-host-prompt ${quote(name)} ${quote(`hold ${name}`)})`);
          await until(async () => (await rig.state(name)).busy, 'busy agent before Close');
        } else if (phase === 'dialog') {
          await rig.el(`(sharing-host-prompt ${quote(name)} "/fx-select")`);
          await peer.wait(record => record.type === 'extension_ui_request' && record.method === 'select', 'dialog-blocked agent');
          for (const label of ['first', 'second']) await until(async () => (await rig.state(name, label)).dialogs.length === 1, 'dialog visible in both clients');
        }
        await rig.el(`(sharing-host-close ${quote(name)} t)`, closer);
        await peer.wait(record => record.type === 'pimux_exit', 'Close reaches equal protocol peer');
        for (const label of ['first', 'second']) await closed(rig, name, label);
        assert.equal(rig.identities.processIdentityStatus(entry.piIdentity), 'dead');
        await rig.el(`(sharing-host-restore "offline" ${quote(saved)})`);
        assert.equal((await rig.state('offline')).alive, false);
        assert.equal((await rig.list()).length, 0);
        peer.close();
      }
    }
  }));

for (const managed of [true, false]) {
  const mode = managed ? 'launcher' : 'direct';
  test(`complete ${managed ? 'managed launcher' : 'orchestration-absent direct'} profile TTY completes a real prompt and automatically restores without replay`,
    { skip, timeout: 180_000 }, t => journey(t, async rig => {
      rig.stageProfile(managed);
      await rig.startService();
      await rig.startProfile(mode);
      const optional = await rig.el(`(list
        (cons 'tty (if (eq (framep (selected-frame)) t) t :json-false))
        (cons 'owner pi-deck--state-owner)
        (cons 'socket server-name)
        (cons 'task pilish-runtime-task-status-executable)
        (cons 'companion (if (featurep 'pi-orchestration) t :json-false))
        (cons 'sound (if (locate-library "pi-sound") t :json-false))
        (cons 'pilish (symbol-file 'pilish-configure-runtime 'defun))
        (cons 'host pilish-runtime-pi-executable))`, 'profile');
      assert.equal(optional.tty, true, 'public frontend actions execute in the actual TTY frame');
      assert.equal(optional.owner, path.join(rig.env.PHIMACS_STATE_DIR, 'sockets/phimacs'));
      assert.equal(optional.socket, optional.owner);
      assert.equal(optional.companion, managed);
      assert.equal(optional.sound, false);
      assert.equal(optional.host, rig.runtime.pi);
      assert.ok(optional.pilish.startsWith(path.join(rig.runtime.root, 'emacs/pilish/')));
      assert.ok(optional.pilish.endsWith('.elc'), 'prepared checkout Pilish loads compiled code');
      if (managed) assert.equal(optional.task, path.join(rig.runtime.root, 'packages/orchestration/dist/worker-task-cli.js'));
      else {
        assert.equal(optional.task, null);
        assert.equal(fs.existsSync(path.join(rig.runtime.root, 'packages/orchestration')), false);
        assert.equal(await rig.el('(if (or (locate-library "pi-orchestration") (executable-find "phimacs-task-status")) t :json-false)', 'profile'), false);
      }
      await rig.el('(sharing-host-create "profile-root")', 'profile');
      const original = await rig.live('profile-root', 'profile');
      await prompt(rig, 'profile-root', 'complete profile sends once', 'profile');
      await rig.el('(sharing-host-draft "profile-root" "profile unsent draft")', 'profile');
      const desktop = path.join(rig.env.PHIMACS_STATE_DIR, 'deck/state.eld');
      await until(() => fs.existsSync(desktop) && fs.readFileSync(desktop, 'utf8').includes('profile unsent draft'), 'automatic profile persistence');
      const entry = (await rig.list()).find(item => item.muxId === runtimeId(original));
      const transitions = managed ? ['direct'] : ['launcher', 'direct'];
      for (const next of transitions) {
        await rig.stopEmacs('profile');
        assert.equal(rig.identities.processIdentityStatus(entry.piIdentity), 'alive', 'profile loss only disconnects');
        await rig.startProfile(next);
        await until(async () => {
          try { return await rig.el(`(sharing-host-adopt "restored" ${quote(original.file)})`, 'profile'); }
          catch { return false; }
        }, `automatic deck restoration through ${next}`);
        const restored = await rig.live('restored', 'profile');
        assert.deepEqual(restored.identity, original.identity);
        assert.equal(restored.draft, 'profile unsent draft');
        assert.equal(runtimeId(restored), runtimeId(original));
        assert.equal(await rig.el('pi-deck--state-owner', 'profile'), optional.owner);
      }
      const peer = await rig.peer(entry);
      const messages = (await peer.request({ type: 'get_messages' })).data.messages;
      assert.equal(messages.filter(message => message.role === 'user' && JSON.stringify(message.content).includes('complete profile sends once')).length, 1);
      assert.ok(!messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('profile unsent draft')));
      assert.equal((await rig.list()).length, 1);
      await rig.el('(sharing-host-close "restored" t)', 'profile');
      await peer.wait(record => record.type === 'pimux_exit', 'profile Close acknowledged by actual runtime');
      await closed(rig, 'restored', 'profile');
      assert.equal((await rig.list()).length, 0);
    }, { profile: true }));
}

test('profile driver startup failure and a lost TTY wrapper still settle the exact private daemon',
  { skip, timeout: 90_000 }, t => journey(t, async rig => {
    rig.stageProfile(false);
    await rig.startService();
    fs.writeFileSync(path.join(rig.root, 'sharing-host.el'), '(error "synthetic profile driver failure")\n');
    await assert.rejects(rig.startProfile('launcher'), /synthetic profile driver failure/);
    const client = rig.clients.get('profile');
    const identity = client.identity;
    assert.ok(identity, 'startup ownership is known before fallible driver loading');
    await rig.stopChild(client.child);
    assert.equal(rig.identities.processIdentityStatus(identity), 'alive', 'losing the wrapper does not stop its detached server');
    delete client.identity; // Exercise cleanup from the private startup PID journal.
    await rig.stopEmacs('profile');
    assert.equal(rig.identities.processIdentityStatus(identity), 'dead');

    const gate = path.join(rig.root, 'before-profile.fifo');
    await rig.command('mkfifo', [gate]);
    rig.env.PHIMACS_TEST_PROFILE_GATE = gate;
    const startup = rig.startProfile('launcher');
    const failed = assert.rejects(startup, /Profile launcher failed/);
    await until(() => {
      const pending = rig.clients.get('profile');
      if (!pending || pending === client) return false;
      rig.captureProfileIdentity(pending);
      return pending.identity && pending;
    }, 'pre-profile process ownership');
    const pending = rig.clients.get('profile');
    await rig.stopChild(pending.child);
    await failed;
    assert.equal(rig.identities.processIdentityStatus(pending.identity), 'alive', 'pre-init daemon survives losing its launcher');
    await assert.rejects(rig.stopEmacs('profile'), /Emacs shutdown is uncertain/);
    assert.equal(rig.identities.processIdentityStatus(pending.identity), 'dead', 'exact pre-init process settled despite unavailable server');
  }, { profile: true }));
