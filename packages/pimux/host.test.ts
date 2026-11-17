import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { exactSessionArgs, servesRpc, withExactOption } from "./host.ts";
import { resolveHost, verifyHost } from "./host-identity.ts";
import { parseArgs } from "@earendil-works/pi-coding-agent";
import { createClaimTestEnvironment } from "./ownership.ts";

test("reapplied exact options replace earlier occurrences instead of accumulating", () => {
  let args = ["--mode", "rpc", "--approve", "--session", "/s/a.jsonl", "--", "--model", "literal"];
  for (let restart = 0; restart < 3; restart++) {
    args = withExactOption(args, "session", "/s/b.jsonl");
    args = withExactOption(withExactOption(args, "provider", "p"), "model", "m");
    args = withExactOption(args, "thinking", "high");
  }
  assert.deepEqual(args, ["--mode", "rpc", "--approve", "--session", "/s/b.jsonl", "--provider", "p",
    "--model", "m", "--thinking", "high", "--", "--model", "literal"]);
  const parsed = parseArgs(args.slice(0, args.indexOf("--")));
  assert.equal(parsed.session, "/s/b.jsonl");
  assert.equal(parsed.model, "m");
});

test("managed exec accepts the actual Node entry, never a shell/shebang wrapper", (t) => {
  const isolated = createClaimTestEnvironment();
  t.after(() => fs.rmSync(isolated.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(isolated.root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.5.0" }));
  const command = path.join(isolated.root, "pi");
  fs.writeFileSync(command, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  assert.throws(() => verifyHost(command), /supported Node entry point/);
  fs.writeFileSync(command, "#!/usr/bin/env node\n// synthetic audited Node entry\n", { mode: 0o700 });
  assert.equal(verifyHost(command).executable, command);
});

test("the host is the global pi on PATH unless an absolute PHIMACS_PI overrides it", (t) => {
  const isolated = createClaimTestEnvironment();
  t.after(() => fs.rmSync(isolated.root, { recursive: true, force: true }));
  const install = (name: string, version: string): string => {
    const dir = path.join(isolated.root, name);
    fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version }));
    fs.writeFileSync(path.join(dir, "cli.js"), "#!/usr/bin/env node\n", { mode: 0o700 });
    fs.symlinkSync(path.join(dir, "cli.js"), path.join(dir, "bin", "pi"));
    return dir;
  };
  const global = install("global", "1.6.0");
  const override = install("override", "1.5.0");
  assert.deepEqual(resolveHost({ PATH: `/nonexistent:${path.join(global, "bin")}` }), { executable: path.join(global, "cli.js"), version: "1.6.0" });
  assert.equal(resolveHost({ PATH: path.join(global, "bin"), PHIMACS_PI: path.join(override, "cli.js") }).version, "1.5.0");
  assert.throws(() => resolveHost({ PATH: "/nonexistent" }), /No global pi on PATH/);
});

test("literal flag-like option values are parsed by Pi, not mistaken for session/export/mode switches", (t) => {
  const isolated = createClaimTestEnvironment();
  t.after(() => fs.rmSync(isolated.root, { recursive: true, force: true }));
  const file = path.join(isolated.sessions, "b.jsonl");
  fs.writeFileSync(file, "synthetic");
  const selected = exactSessionArgs(["--session", file, "--system-prompt", "--export", "A"], isolated.root, isolated.env, true);
  const parsed = parseArgs(selected.args);
  assert.equal(selected.file, file);
  assert.equal(parsed.session, file);
  assert.equal(parsed.export, undefined);
  assert.equal(parsed.systemPrompt, "--export");
  assert.deepEqual(parsed.messages, ["A"]);
  assert.equal(servesRpc(["--system-prompt", "--mode", "rpc"]), false);
  assert.equal(servesRpc(["--mode=rpc"]), false, "Pi does not parse this spelling as its mode option");
});

test("one canonical resolution is used for both the claim and actual Pi argument despite alias retarget", (t) => {
  const isolated = createClaimTestEnvironment();
  t.after(() => fs.rmSync(isolated.root, { recursive: true, force: true }));
  const a = path.join(isolated.sessions, "a.jsonl");
  const b = path.join(isolated.sessions, "b.jsonl");
  const alias = path.join(isolated.sessions, "alias.jsonl");
  fs.writeFileSync(a, "a"); fs.writeFileSync(b, "b"); fs.symlinkSync(a, alias);
  const original = fs.realpathSync.native;
  let retargeted = false;
  fs.realpathSync.native = ((file: fs.PathLike) => {
    const result = original(file);
    if (file === alias && !retargeted) { retargeted = true; fs.unlinkSync(alias); fs.symlinkSync(b, alias); }
    return result;
  }) as typeof original;
  try {
    const selected = exactSessionArgs(["--mode", "rpc", "--session", alias], isolated.root, isolated.env);
    assert.equal(selected.file, a);
    assert.equal(selected.args.at(-1), a);
    assert.equal(retargeted, true);
  } finally { fs.realpathSync.native = original; }
});
