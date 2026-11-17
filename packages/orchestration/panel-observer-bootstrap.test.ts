import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { readProcessIdentity } from "@phimacs/pimux/process-identity";
import type { HostTarget } from "./host-types.ts";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "panel-bootstrap-test-"));
  const directory = fs.mkdtempSync(path.join(root, ".pi-panel-"));
  const registry = path.join(root, "pi-orchestration-targets");
  fs.mkdirSync(registry, { mode: 0o700 });
  const owner = readProcessIdentity(process.pid)!;
  const target: HostTarget = { name: "bootstrap", host: "emacs", endpoint: path.join(root, "missing-emacs.sock"),
    id: "owned-private-id", kind: "shell", owner,
    observerErrorPath: path.join(directory, "observer-error.log") };
  const file = path.join(registry, "bootstrap.json");
  fs.writeFileSync(file, JSON.stringify({ target }), { mode: 0o600 });
  let child: ChildProcess | undefined;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { target, file, launch() {
    child = spawn(process.execPath, [fileURLToPath(new URL("./dist/panel-owner.js", import.meta.url)), JSON.stringify(target)], {
      env: { ...process.env, TMPDIR: root, HOME: root, PI_CODING_AGENT_DIR: path.join(root, "agent") },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    child.stderr!.resume();
    return child;
  } };
}

test("observer bootstrap fails before ready and preserves unreadable registry diagnostics", { timeout: 10_000 }, async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.file, "invalid registry JSON");
  const child = f.launch();
  const closed = once(child, "exit");
  const [message] = await once(child, "message", { signal: AbortSignal.timeout(5000) });
  assert.match(String(message), /^error:/);
  await closed;
  assert.equal(child.exitCode, 1);
  assert.match(fs.readFileSync(f.target.observerErrorPath!, "utf8"), /Native panel observer failed/);
  assert.equal(fs.readFileSync(f.file, "utf8"), "invalid registry JSON", "never overwrite uncertain ownership");
});

test("late detached observer errors remain readable after IPC/frontend disconnection", { timeout: 10_000 }, async (t) => {
  const f = fixture(t);
  const child = f.launch();
  const closed = once(child, "exit");
  assert.equal((await once(child, "message", { signal: AbortSignal.timeout(5000) }))[0], "ready");
  const started = once(child, "message", { signal: AbortSignal.timeout(5000) });
  child.send("start");
  assert.equal((await started)[0], "started");
  fs.writeFileSync(f.file, "late registry failure");
  child.disconnect();
  await closed;
  assert.equal(child.exitCode, 1);
  assert.match(fs.readFileSync(f.target.observerErrorPath!, "utf8"), /Native panel observer failed/);
});

for (const phase of ["before-observer", "ready", "started", "activation", "after-activation", "uncertain-rollback"] as const) {
  test(`ownPanel cancellation at ${phase} settles held ownership without releasing preactivation work`, { timeout: 15_000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "panel-cancel-test-"));
    const entry = path.join(root, "scenario.mjs");
    const runtime = new URL("./dist/panel-runtime.js", import.meta.url).href;
    const lifetime = new URL("./dist/panel-lifetime.js", import.meta.url).href;
    const workers = new URL("./dist/workers.js", import.meta.url).href;
    const identity = import.meta.resolve("@phimacs/pimux/process-identity");
    const observer = fileURLToPath(new URL("./dist/panel-owner.js", import.meta.url));
    fs.writeFileSync(entry, [
      'import fs from "node:fs"; import path from "node:path"; import {spawn} from "node:child_process"; import {once} from "node:events";',
      `import {createPanelBinding,panelWrapperArgv,waitPanelReady,activatePanel,savedPanelState} from ${JSON.stringify(runtime)};`,
      `import {ownPanel} from ${JSON.stringify(lifetime)}; import {saveTarget,readTarget} from ${JSON.stringify(workers)};`,
      `import {processIdentityStatus} from ${JSON.stringify(identity)};`,
      `const phase=${JSON.stringify(phase)}; const marker=${JSON.stringify(path.join(root, "command-ran"))};`,
      'let binding=createPanelBinding({argv:["/bin/sh","-c",`touch "${marker}"; read line`],cwd:"/tmp"});',
      'const argv=panelWrapperArgv(binding); const wrapper=spawn(argv[0],argv.slice(1),{stdio:"ignore"}); binding=await waitPanelReady(binding);',
      'const target={name:"cancel-test",host:"emacs",endpoint:"/missing-disposable-emacs",id:"owned",kind:"shell",owner:binding.creator,panel:binding}; saveTarget(target);',
      'const abort=new AbortController();',
      'if(phase==="uncertain-rollback"){const exited=once(wrapper,"close"); wrapper.kill("SIGKILL"); await exited;}',
      'if(phase==="before-observer" || phase==="uncertain-rollback") abort.abort();',
      'let launched=0; let error;',
      'try { await ownPanel(target,abort.signal,{',
      `launch(t){launched++;const child=spawn(process.execPath,[${JSON.stringify(observer)},JSON.stringify(t)],{detached:true,stdio:["ignore","ignore","pipe","ipc"]}); child.on("message",m=>{if(m===phase) abort.abort();});return child;},`,
      'async activate(b,signal){if(phase==="activation") abort.abort();await activatePanel(b,signal);if(phase==="after-activation") abort.abort();}',
      '}); } catch(failure){error=String(failure);}',
      'const state=savedPanelState(binding); process.send({phase,error,launched,ran:fs.existsSync(marker),state,alive:processIdentityStatus(binding.process),retained:!!readTarget(target.name),diagnostic:target.observerErrorPath&&fs.existsSync(target.observerErrorPath)});',
    ].join("\n"));
    const child = spawn(process.execPath, [entry], { env: { ...process.env, TMPDIR: root }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = ""; child.stderr!.on("data", chunk => { stderr += chunk.toString(); });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) { const closed = once(child, "close"); child.kill("SIGKILL"); await closed; }
      fs.rmSync(root, { recursive: true, force: true });
    });
    const closed = once(child, "exit");
    const [result] = await once(child, "message", { signal: AbortSignal.timeout(10_000) }) as [{ error: string; ran: boolean; launched: number; state: { closed: boolean }; alive: string; retained: boolean; diagnostic: boolean }];
    await closed;
    assert.equal(child.exitCode, 0, stderr);
    assert.match(result.error, /abort|cancel/i);
    assert.equal(result.alive, "dead", "rollback settled the exact wrapper before returning");
    assert.equal(result.retained, true, "tools, not ownPanel, release the registered name after acknowledged cleanup");
    assert.equal(result.diagnostic, true);
    if (phase !== "after-activation") assert.equal(result.ran, false, "held command was never released");
    if (phase === "before-observer" || phase === "uncertain-rollback") assert.equal(result.launched, 0);
    if (phase === "uncertain-rollback") {
      assert.match(result.error, /rollback uncertain[\s\S]*without acknowledged child cleanup/);
      assert.equal(result.state.closed, false, "uncertainty is retained, not presented as closure");
    } else assert.equal(result.state.closed, true);
  });
}
