import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { spawnGatedHost } from "./bootstrap.ts";
import { verifyHost } from "./host-identity.ts";
import { acquireClaim, ClaimConflictError, lookupClaim, releaseClaim, type ClaimRecord } from "./ownership.ts";
import { processIdentityStatus, readProcessIdentity, type ProcessIdentity } from "./process-identity.ts";
import { BIN, PI, prepare, serviceReady, until } from "./test/harness.ts";

const CHECKPOINT = fileURLToPath(new URL("./test/startup-checkpoint.mjs", import.meta.url));

for (const mode of ["rpc", "tui"] as const) {
  for (const stage of ["spawned", "registering", "registered", "executing"] as const) {
    test(`${mode} owner SIGKILL at ${stage} never permits an unclaimed writer`, { timeout: 40_000 }, async (t) => {
      const input = prepare();
      const before = fs.readFileSync(input.sessionFile, "utf8").trimEnd();
      fs.writeFileSync(input.sessionFile, before, { mode: 0o600 });
      const args = mode === "rpc" ? ["start", "--json", "--", PI, ...input.piArgs]
        : ["tui", "--", PI, "--export", input.sessionFile, path.join(input.dir, "export.html")];
      let output = "";
      // An RPC start asks the running service, which spawns the faulted owner; it
      // receives the fault injection only through this request's environment.
      const service = mode === "rpc" ? spawn(process.execPath, [BIN, "serve"], { cwd: input.dir, env: input.env, stdio: ["ignore", "pipe", "pipe"] }) : undefined;
      service?.stderr!.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
      const serviceClosed = service && once(service, "close");
      // Settles the service even if readiness never arrives; the full cleanup below repeats it harmlessly.
      if (service) t.after(async () => { if (service.exitCode === null && service.signalCode === null) service.kill("SIGTERM"); await serviceClosed; });
      // Start only once the service announces readiness: a loaded machine can take
      // longer than a client's bounded availability wait to start the service.
      if (service) await serviceReady(service);
      const launcher = spawn(process.execPath, [BIN, ...args], { cwd: input.dir,
        env: { ...input.env, NODE_OPTIONS: `${input.env.NODE_OPTIONS ?? ""} --import ${CHECKPOINT}`, PHIMACS_STARTUP_CHECKPOINT: stage },
        stdio: ["ignore", "pipe", "pipe"] });
      const closed = once(launcher, "close");
      launcher.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
      launcher.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
      let observed: { owner: ProcessIdentity; child: ProcessIdentity; stage: string } | undefined;
      let replacement: ReturnType<typeof acquireClaim> | undefined;
      t.after(async () => {
        if (replacement) releaseClaim(replacement);
        for (const identity of [observed?.child, observed?.owner]) {
          if (identity && processIdentityStatus(identity) === "alive") process.kill(identity.pid, "SIGKILL");
          if (identity) await until(() => processIdentityStatus(identity) === "dead", "owned crash-test child exit");
        }
        if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill("SIGKILL");
        await closed;
        if (service && service.exitCode === null && service.signalCode === null) service.kill("SIGTERM");
        await serviceClosed;
        fs.rmSync(input.dir, { recursive: true, force: true });
      });
      observed = await until(() => {
        try { return JSON.parse(fs.readFileSync(path.join(input.dir, "startup-checkpoint.json"), "utf8")) as typeof observed; }
        catch { return undefined; }
      }, `${mode} ${stage} checkpoint: ${output}`, 25_000);
      assert.ok(observed);
      // The fault must hit the real claim owner at the requested point, or nothing is proven.
      assert.equal(observed.stage, stage);
      const parent = (pid: number): number => Number(fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[1]);
      if (mode === "rpc") assert.equal(parent(observed.owner.pid), service!.pid, "the faulted owner is the service's agent owner");
      else assert.equal(observed.owner.pid, launcher.pid, "the faulted owner is the re-executed TUI launcher");
      assert.equal(parent(observed.child.pid), observed.owner.pid, "the possible writer is that owner's child");
      assert.equal(processIdentityStatus(observed.child), "alive");
      process.kill(observed.child.pid, "SIGSTOP");
      // Registration checkpoints intentionally hold the writer transaction.
      // Inspect its already-published record without trying to acquire that
      // mutex until after the faulted owner has actually been killed.
      const records = path.join(input.isolation.claims, "records");
      const recordFile = fs.readdirSync(records).find((name) => /^[a-f0-9]{64}\.json$/.test(name))!;
      const initial = JSON.parse(fs.readFileSync(path.join(records, recordFile), "utf8")) as ClaimRecord;
      assert.equal(initial.owner.pi !== null, stage === "registered" || stage === "executing");
      assert.equal(initial.owner.wrapper.pid, observed.owner.pid, "the claim names the owner that will crash");
      if (initial.owner.pi) assert.equal(initial.owner.pi.pid, observed.child.pid, "the registered writer is the stopped child");
      process.kill(observed.owner.pid, "SIGKILL");
      await until(() => processIdentityStatus(observed!.owner) === "dead", "recorded owner crashed");
      assert.equal(processIdentityStatus(observed.child), "alive");
      if (stage === "spawned" || stage === "registering") {
        // This unregistered child is only the nonwriting bootstrap. Reclamation
        // is safe even while it is stopped: its only gate now has irreversible EOF.
        assert.equal(lookupClaim(input.sessionFile, input.isolation.options), undefined);
        replacement = acquireClaim(input.sessionFile, { id: "replacement", kind: "lease", wrapper: readProcessIdentity(process.pid)!, pi: null }, input.isolation.options);
        process.kill(observed.child.pid, "SIGCONT");
        await until(() => processIdentityStatus(observed!.child) === "dead", "unauthorized bootstrap observes EOF");
        assert.equal(lookupClaim(input.sessionFile, input.isolation.options)!.token, replacement.token);
      } else {
        assert.equal(lookupClaim(input.sessionFile, input.isolation.options)!.token, initial.token);
        assert.throws(() => acquireClaim(input.sessionFile, { id: "refused", kind: "lease", wrapper: readProcessIdentity(process.pid)!, pi: null }, input.isolation.options), ClaimConflictError);
        process.kill(observed.child.pid, "SIGKILL");
        await until(() => processIdentityStatus(observed!.child) === "dead", "registered possible writer exited");
        assert.equal(lookupClaim(input.sessionFile, input.isolation.options), undefined);
      }
      assert.equal(fs.readFileSync(input.sessionFile, "utf8"), before, "no repair-capable host open occurred without a registered identity");
      assert.equal(fs.existsSync(path.join(input.dir, "export.html")), false);
    });
  }
}

test("unauthorized bootstrap cannot run inherited host preloads and EOF cannot execute Pi", { timeout: 20_000 }, async (t) => {
  const input = prepare();
  const marker = path.join(input.dir, "host-preload-ran");
  const preload = path.join(input.dir, "host-preload.mjs");
  fs.writeFileSync(preload, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)},'executed');\n`);
  const claim = acquireClaim(input.sessionFile, { id: "no-authority", kind: "tui", wrapper: readProcessIdentity(process.pid)!, pi: null }, input.isolation.options);
  const gated = spawnGatedHost({ host: verifyHost(PI), args: ["--version"], cwd: input.dir,
    env: { ...input.env, NODE_OPTIONS: `--import ${preload}` }, claim, stdio: "pipe" });
  const closed = once(gated.child, "close");
  t.after(async () => {
    if (gated.child.exitCode === null && gated.child.signalCode === null) gated.child.kill("SIGKILL");
    await closed; releaseClaim(claim); fs.rmSync(input.dir, { recursive: true, force: true });
  });
  await once(gated.child, "spawn");
  await delay(150);
  assert.equal(fs.existsSync(marker), false);
  gated.child.stdio[3]!.destroy();
  const [code] = await closed;
  assert.equal(code, 1);
  assert.equal(fs.existsSync(marker), false);
});

test("authorized Node exec preserves the registered PID/start/boot identity and restores host env", { timeout: 20_000 }, async (t) => {
  const input = prepare();
  const marker = path.join(input.dir, "authorized.json");
  const preload = path.join(input.dir, "authorized.mjs");
  fs.writeFileSync(preload, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,exe:process.execPath,value:process.env.TEST_AUTH_VALUE}));\n`);
  const claim = acquireClaim(input.sessionFile, { id: "authorized", kind: "tui", wrapper: readProcessIdentity(process.pid)!, pi: null }, input.isolation.options);
  const gated = spawnGatedHost({ host: verifyHost(PI), args: ["--version"], cwd: input.dir,
    env: { ...input.env, NODE_OPTIONS: `--import ${preload}`, TEST_AUTH_VALUE: "preserved" }, claim, stdio: "pipe" });
  const closed = once(gated.child, "close");
  t.after(async () => {
    if (gated.child.exitCode === null && gated.child.signalCode === null) gated.child.kill("SIGKILL");
    await closed; releaseClaim(claim); fs.rmSync(input.dir, { recursive: true, force: true });
  });
  const identity = await gated.authorize();
  assert.deepEqual(lookupClaim(input.sessionFile, input.isolation.options)!.owner.pi, identity);
  const result = await until(() => fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, "utf8")) as { pid: number; exe: string; value: string } : undefined, "authorized host preload");
  assert.deepEqual(result, { pid: identity.pid, exe: process.execPath, value: "preserved" });
  assert.equal((await closed)[0], 0);
});
