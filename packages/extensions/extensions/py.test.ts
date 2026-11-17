import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createServer } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore, type ToolResultMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession, createCodemodeExtension, DefaultResourceLoader, initTheme, ModelRuntime, SessionManager, SettingsManager,
  type AgentToolResult, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { createRemoteToolDefinitions } from "../../orchestration/remote-tools.ts";
import { RemoteSession } from "../../orchestration/remote-session.ts";
import { installSshStub } from "../../orchestration/test/ssh-stub.ts";
import { TOOL_SELECTION_ENTRY } from "@phimacs/orchestration/session-tools";
import execLints from "./exec-lints.ts";
import pyExtension, { PY_TOOL } from "./py.ts";
import toolsExtension from "./tools.ts";

initTheme("dark");

function text(result: { content: ToolResultMessage["content"] }): string {
  return result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
}

type CapturedResult = ToolResultMessage & Pick<AgentToolResult, "structuredContent">;

function environment(t: TestContext, values: Record<string, string | undefined>): void {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  const apply = (entries: Record<string, string | undefined>) => {
    for (const [name, value] of Object.entries(entries)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  apply(values);
  t.after(() => apply(previous));
}

// A local PEP 691/700 index exercises real uv resolution without trusting PyPI or a shared cache.
async function packageIndex(t: TestContext, directory: string): Promise<void> {
  const root = path.join(directory, "index");
  fs.mkdirSync(root);
  const script = path.join(root, "build-fixtures.py");
  fs.writeFileSync(script, `import base64, csv, hashlib, io, json, pathlib, sys, tarfile, zipfile
from datetime import datetime, timedelta, timezone
root = pathlib.Path(sys.argv[1])
manifest = {}
old = (datetime.now(timezone.utc) - timedelta(days=60)).isoformat()
recent = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
def add(name, filename, uploaded):
    data = (root / filename).read_bytes()
    manifest.setdefault(name, []).append({"filename": filename, "url": "/files/" + filename,
        "hashes": {"sha256": hashlib.sha256(data).hexdigest()}, "size": len(data), "upload-time": uploaded})
def wheel(name, version, uploaded, requirements=""):
    module = name.replace("-", "_")
    info = module + "-" + version + ".dist-info"
    files = {module + ".py": "__version__ = " + repr(version) + "\\n",
        info + "/METADATA": "Metadata-Version: 2.3\\nName: " + name + "\\nVersion: " + version + "\\n" + requirements,
        info + "/WHEEL": "Wheel-Version: 1.0\\nGenerator: py-tool-test\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n"}
    record = io.StringIO()
    writer = csv.writer(record)
    for filename, content in files.items():
        data = content.encode()
        digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
        writer.writerow([filename, "sha256=" + digest, len(data)])
    writer.writerow([info + "/RECORD", "", ""])
    files[info + "/RECORD"] = record.getvalue()
    filename = module + "-" + version + "-py3-none-any.whl"
    with zipfile.ZipFile(root / filename, "w") as archive:
        for entry, content in files.items():
            archive.writestr(entry, content)
    add(name, filename, uploaded)
for version, uploaded in [("1.0.0", old), ("2.0.0", recent)]:
    wheel("pi-py-dependency-fixture", version, uploaded,
        'Requires-Dist: pi-py-transitive-fixture>=1\\nProvides-Extra: demo\\nProvides-Extra: source\\nRequires-Dist: pi-py-source-fixture; extra == "source"\\n')
    wheel("pi-py-transitive-fixture", version, uploaded)
wheel("pi-py-dependency-fixture-whl", "1.0.0", old)
filename = "pi_py_source_fixture-1.0.0.tar.gz"
with tarfile.open(root / filename, "w:gz") as archive:
    files = {"setup.py": "from pathlib import Path\\nPath(" + repr(str(root / "build-ran")) + ").touch()\\nraise RuntimeError('source build ran')\\n",
        "PKG-INFO": "Metadata-Version: 2.3\\nName: pi-py-source-fixture\\nVersion: 1.0.0\\n"}
    for entry, content in files.items():
        data = content.encode()
        info = tarfile.TarInfo("pi_py_source_fixture-1.0.0/" + entry)
        info.size = len(data)
        archive.addfile(info, io.BytesIO(data))
add("pi-py-source-fixture", filename, old)
(root / "manifest.json").write_text(json.dumps(manifest))
`);
  const python = spawnSync("uv", ["python", "find", "--offline", "--no-python-downloads"], { encoding: "utf8", timeout: 5_000 });
  assert.equal(python.status, 0, python.stderr);
  const built = spawnSync(python.stdout.trim(), [script, root], { encoding: "utf8", timeout: 5_000 });
  assert.equal(built.status, 0, built.stderr);
  interface IndexFile { filename: string; url: string; hashes: { sha256: string }; size: number; "upload-time": string }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")) as Record<string, IndexFile[]>;
  const server = createServer((request, response) => {
    const route = request.url ?? "";
    const name = /^\/simple\/([^/]+)\/$/.exec(route)?.[1];
    if (name && manifest[name]) {
      response.writeHead(200, { "Content-Type": "application/vnd.pypi.simple.v1+json" });
      response.end(JSON.stringify({
        meta: { "api-version": "1.1" }, name, files: manifest[name],
        versions: [...new Set(manifest[name].map((file) => file.filename.split("-")[1]!.replace(/\.tar\.gz$/, "")))],
      }));
      return;
    }
    const filename = /^\/files\/([^/]+)$/.exec(route)?.[1];
    if (filename && Object.values(manifest).some((files) => files.some((file) => file.filename === filename))) {
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      response.end(fs.readFileSync(path.join(root, filename)));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  environment(t, {
    UV_DEFAULT_INDEX: `http://127.0.0.1:${address.port}/simple`,
    UV_INDEX: undefined, UV_INDEX_URL: undefined, UV_EXTRA_INDEX_URL: undefined, UV_FIND_LINKS: undefined,
    // The tool's command-line cooldown must take precedence over inherited settings.
    UV_EXCLUDE_NEWER: "false",
  });
}

async function fixture(t: TestContext, options: { extensions?: ExtensionFactory[]; saved?: readonly string[]; branch?: readonly string[] } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-py-test-"));
  const agentDir = path.join(directory, "agent");
  fs.mkdirSync(agentDir);
  // Saved runs go to an isolated runtime directory outside the working directory.
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-py-runtime-"));
  environment(t, {
    PI_CODING_AGENT_DIR: agentDir, XDG_RUNTIME_DIR: runtimeDir,
    UV_CACHE_DIR: path.join(runtimeDir, "uv-cache"),
  });
  t.after(() => {
    fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });
  if (options.saved) fs.writeFileSync(path.join(agentDir, "tool-selection.json"), JSON.stringify({ enabledTools: options.saved }));
  const provider = fauxProvider({ provider: "py-test", tokensPerSecond: 1_000_000 });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: path.join(agentDir, "models-store.json"), allowModelNetwork: false,
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: directory, agentDir, settingsManager, noExtensions: true, noSkills: true,
    noContextFiles: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [(pi) => { pi.registerProvider(provider.provider); },
      pyExtension, createCodemodeExtension({ models: false }), toolsExtension, ...(options.extensions ?? [])],
  });
  await loader.reload();
  const sessionManager = SessionManager.create(directory, path.join(directory, "sessions"));
  if (options.branch) sessionManager.appendCustomEntry(TOOL_SELECTION_ENTRY, { enabledTools: options.branch });
  const created = await createAgentSession({
    cwd: directory, agentDir, modelRuntime, settingsManager, resourceLoader: loader,
    model: provider.getModel(), thinkingLevel: "off", sessionManager,
  });
  const session = created.session;
  t.after(() => session.dispose());
  assert.deepEqual(created.extensionsResult.errors, []);
  const errors: string[] = [];
  const structured = new Map<string, AgentToolResult["structuredContent"]>();
  session.subscribe((event) => {
    if (event.type === "tool_execution_end") structured.set(event.toolCallId, event.result.structuredContent);
  });
  await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.error) });
  await modelRuntime.setRuntimeApiKey(provider.provider.id, "fixture-key");
  await modelRuntime.getAvailable();
  t.after(() => assert.deepEqual(errors, []));
  let call = 0;
  async function run(args: Parameters<typeof fauxToolCall>[1], name = PY_TOOL): Promise<CapturedResult> {
    const id = `call-${++call}`;
    provider.setResponses([
      fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    await session.prompt("Run the scripted test tool call.");
    const result = sessionManager.getBranch().flatMap((entry) =>
      entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === id ? [entry.message] : []).at(-1);
    assert.ok(result);
    // Structured values are available to callers/events, not saved in the model transcript.
    return { ...result, structuredContent: structured.get(id) };
  }
  return { directory, agentDir, runtimeDir, session, run };
}

interface PyOutput {
  output: string;
  truncated: boolean;
  full_output_path?: string;
  exit_code: number;
  wall_time_seconds: number;
  py_dir?: string;
}

function output(result: CapturedResult): PyOutput {
  assert.ok(result.structuredContent);
  return result.structuredContent as unknown as PyOutput;
}

test("py is enabled by default in /tools; exact saved and branch selections override it", { timeout: 15_000 }, async (t) => {
  for (const [label, options, expected] of [
    ["default", {}, true],
    ["saved opt-out", { saved: ["bash"] }, false],
    ["saved opt-in", { saved: ["bash", PY_TOOL] }, true],
    ["branch opt-out", { saved: ["bash", PY_TOOL], branch: ["bash"] }, false],
  ] as const) await t.test(label, async (child) => {
    const f = await fixture(child, options);
    assert.equal(f.session.getActiveToolNames().includes(PY_TOOL), expected);
  });
});

test("each call saves its source and output in a private PY_DIR that later calls can load from", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  const code = "import json, os\njson.dump({'answer': 42}, open(os.path.join(os.environ['PY_DIR'], 'data.json'), 'w'))\nprint('saved')";
  const first = await f.run({ code });
  assert.equal(first.isError, false, text(first));
  const dir = output(first).py_dir;
  assert.ok(dir);
  const base = path.join(f.runtimeDir, `pi-py-${process.getuid!()}`);
  assert.equal(path.dirname(dir), base);
  assert.equal(fs.statSync(base).mode & 0o777, 0o700);
  assert.equal(output(first).output, "saved\n", "the folder marker is not part of the output");
  assert.equal(text(first), `saved\n\nSaved: ${dir}/input.py, ${dir}/output`);
  assert.equal(fs.readFileSync(path.join(dir, "input.py"), "utf8"), `${code}\n`);
  assert.equal(fs.readFileSync(path.join(dir, "output"), "utf8"), "saved\n");

  const next = await f.run({ code: `import json\nprint(json.load(open(${JSON.stringify(path.join(dir, "data.json"))}))['answer'])\nprint(open(${JSON.stringify(path.join(dir, "output"))}).read(), end='')` });
  assert.equal(output(next).output, "42\nsaved\n");
  assert.notEqual(output(next).py_dir, dir);

  const failed = await f.run({ code: "import sys\nprint('partial')\nsys.exit(3)" });
  assert.equal(failed.isError, true);
  assert.match(text(failed), /^partial\n[\s\S]*code 3[\s\S]*\nSaved: \S+\/input\.py, \S+\/output$/);
  assert.equal(fs.readFileSync(path.join(output(failed).py_dir!, "output"), "utf8"), "partial\n");
});

test("a base folder owned by someone else or replaced by a symlink is refused", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "pi-py-elsewhere-"));
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  fs.symlinkSync(elsewhere, path.join(f.runtimeDir, `pi-py-${process.getuid!()}`));
  const refused = await f.run({ code: "print('ran')" });
  assert.equal(refused.isError, true);
  assert.match(text(refused), /py: unsafe or unusable directory/);
  assert.doesNotMatch(text(refused), /ran/);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test("source survives shell metacharacters and heredoc collisions; cwd and globals are per call", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  const payload = "quotes ' \" $HOME $(touch shell-injected) `touch shell-injected` \\ 界面 unbalanced ) ( esac\nPI_PY\nPI_PY_\nend";
  const first = await f.run({ code: `import os\nx = 42\nprint(r"""${payload}""")\nprint(os.getcwd())` });
  assert.equal(first.isError, false);
  assert.equal(output(first).output, `${payload}\n${f.directory}\n`);
  assert.equal(fs.existsSync(path.join(f.directory, "shell-injected")), false);
  const next = await f.run({ code: "print('x' in globals(), 'os' in globals())" });
  assert.equal(output(next).output, "False False\n");
  assert.deepEqual(fs.readdirSync(f.directory).sort(), ["agent", "sessions"]);
});

test("uv isolates execution from an existing project environment while preserving cwd imports without env files or bytecode", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  const venv = spawnSync("uv", ["venv", "--offline", "--no-python-downloads", ".venv"], { cwd: f.directory, encoding: "utf8", timeout: 5_000 });
  assert.equal(venv.status, 0, venv.stderr);
  fs.writeFileSync(path.join(f.directory, "pyproject.toml"), '[project]\nname = "python-tool-fixture"\nversion = "0.0.0"\ndependencies = ["pi-python-test-must-not-be-installed==0.0.0"]\n');
  fs.writeFileSync(path.join(f.directory, ".env"), "PI_PYTHON_TEST_ENV_FILE=loaded\n");
  fs.writeFileSync(path.join(f.directory, "fixture_module.py"), "value = 42\n");
  const result = await f.run({ code: "import os, sys, fixture_module\nprint(sys.prefix)\nprint(fixture_module.value)\nprint(os.environ.get('PI_PYTHON_TEST_ENV_FILE', 'not loaded'))" });
  assert.equal(result.isError, false, text(result));
  const [prefix, value, env] = output(result).output.trim().split("\n");
  assert.notEqual(prefix, path.join(f.directory, ".venv"));
  assert.equal(value, "42");
  assert.equal(env, "not loaded");
  assert.equal(fs.existsSync(path.join(f.directory, "uv.lock")), false);
  assert.equal(fs.existsSync(path.join(f.directory, "__pycache__")), false);
});

test("a missing project environment stays absent; a missing interpreter fails without downloading Python", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.directory, "pyproject.toml"), '[project]\nname = "python-tool-fixture"\nversion = "0.0.0"\nrequires-python = ">=3.8"\n');
  const result = await f.run({ code: "print(42)" });
  assert.equal(fs.existsSync(path.join(f.directory, ".venv")), false);
  assert.equal(fs.existsSync(path.join(f.directory, "uv.lock")), false);
  assert.equal(result.isError, false, text(result));
  environment(t, { UV_PYTHON: "9.99.99" });
  const missing = await f.run({ code: "print(42)" });
  assert.equal(missing.isError, true);
  assert.match(text(missing), /9\.99\.99|not found|download|offline/i);
  assert.equal(fs.existsSync(path.join(f.directory, ".venv")), false);
});

test("explicit and discovered uv configuration cannot change isolated execution policy", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  const config = path.join(f.directory, "uv.toml");
  fs.writeFileSync(config, "not valid TOML [");
  environment(t, { UV_CONFIG_FILE: config });
  const result = await f.run({ code: "print(42)" });
  assert.equal(result.isError, false, text(result));
  assert.equal(output(result).output, "42\n");
});

test("stdin execution does not resolve dependency metadata embedded in Python source", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  const result = await f.run({ code: "# /// script\n# dependencies = ['pi-python-test-must-not-be-installed==0.0.0']\n# ///\nprint(42)" });
  assert.equal(result.isError, false, text(result));
  assert.equal(output(result).output, "42\n");
});

test("py exposes explicit dependencies without advertising the dependency whitelist", { timeout: 15_000 }, async (t) => {
  let metadata = "";
  await fixture(t, { extensions: [(pi) => {
    pi.on("session_start", () => {
      metadata = JSON.stringify(pi.getAllTools().find((tool) => tool.name === PY_TOOL));
    });
  }] });
  assert.match(metadata, /"dependencies"/);
  assert.match(metadata, /"timeout"/);
  assert.doesNotMatch(metadata, /whitelist|allowlist|py\.json/i);
});

test("missing, empty and malformed dependency whitelists fail before invoking bash", { timeout: 15_000 }, async (t) => {
  let shellCalls = 0;
  const f = await fixture(t, { extensions: [(pi) => {
    pi.on("tool_call", (event) => {
      if (event.toolName === "bash") shellCalls++;
    });
  }] });
  const config = path.join(f.agentDir, "py.json");
  const missing = await f.run({ code: "print('must-not-run')", dependencies: ["numpy"] });
  assert.equal(missing.isError, true);
  assert.match(text(missing), /numpy/i);
  assert.match(text(missing), /ask.*user/i);
  assert.match(text(missing), /whitelist/i);
  assert.match(text(missing), /not.*(?:modify|edit)|(?:modify|edit).*not/i);
  assert.ok(text(missing).includes(config));
  assert.equal(fs.existsSync(config), false, "a request cannot create its own whitelist");
  for (const contents of [
    '{"dependencies":[]}', "{", "[]", "null", '{"dependencies":"numpy"}',
    '{"dependencies":[42]}', '{"dependencies":["numpy>=2"]}',
  ]) {
    fs.writeFileSync(config, contents);
    const rejected = await f.run({ code: "print('must-not-run')", dependencies: ["numpy"] });
    assert.equal(rejected.isError, true, contents);
    assert.match(text(rejected), /py\.json|whitelist/i);
    assert.equal(fs.readFileSync(config, "utf8"), contents, "the tool never rewrites user policy");
  }
  fs.rmSync(config);
  fs.mkdirSync(config);
  const unreadable = await f.run({ code: "print('must-not-run')", dependencies: ["numpy"] });
  assert.equal(unreadable.isError, true);
  assert.equal(shellCalls, 0);
});

test("dependency requirements reject alternate sources, options and shell injection before invoking bash", { timeout: 15_000 }, async (t) => {
  let shellCalls = 0;
  const f = await fixture(t, { extensions: [(pi) => {
    pi.on("tool_call", (event) => {
      if (event.toolName === "bash") shellCalls++;
    });
  }] });
  fs.writeFileSync(path.join(f.agentDir, "py.json"), JSON.stringify({ dependencies: ["numpy"] }));
  for (const dependency of [
    "https://example.invalid/numpy.whl", "./numpy.whl", "/tmp/numpy.whl", "--with-editable=numpy",
    "numpy @ https://example.invalid/numpy.whl", "numpy @ file:///tmp/numpy.whl",
    'numpy; python_version >= "3.8"', "numpy\n--with evil", "numpy>=1; touch shell-injected",
    "numpy$(touch shell-injected)", "numpy[demo] @ git+https://example.invalid/repository",
  ]) {
    const rejected = await f.run({ code: "print('must-not-run')", dependencies: [dependency] });
    assert.equal(rejected.isError, true, dependency);
  }
  assert.equal(shellCalls, 0);
  assert.equal(fs.existsSync(path.join(f.directory, "shell-injected")), false);
});

test("real uv resolves normalized requirements and extras with a 30-day cooldown on direct and transitive wheels", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  await packageIndex(t, f.runtimeDir);
  const config = path.join(f.agentDir, "py.json");
  fs.writeFileSync(config, JSON.stringify({ dependencies: ["PI_PY.Dependency_Fixture"] }));
  const code = "import pi_py_dependency_fixture, pi_py_transitive_fixture\nprint(pi_py_dependency_fixture.__version__)\nprint(pi_py_transitive_fixture.__version__)";
  const resolved = await f.run({ code, dependencies: ["Pi.Py_Dependency_Fixture[demo]>=1,<3"], timeout: 5 });
  assert.equal(resolved.isError, false, text(resolved));
  assert.equal(output(resolved).output, "1.0.0\n1.0.0\n", "new direct and transitive releases are both excluded");
  assert.doesNotMatch(text(resolved), /whitelist|py\.json/i);
  const pinnedNew = await f.run({ code, dependencies: ["pi-py-dependency-fixture==2.0.0"], timeout: 5 });
  assert.equal(pinnedNew.isError, true, text(pinnedNew));
  assert.match(text(pinnedNew), /no solution|unsatisfiable|exclude|uploaded|before/i);

  const transitiveRequest = await f.run({ code: "print(42)", dependencies: ["pi-py-transitive-fixture"] });
  assert.equal(transitiveRequest.isError, true, "implicit transitive installation does not approve direct requests");
  assert.match(text(transitiveRequest), /ask.*user/i);
  fs.writeFileSync(config, JSON.stringify({ dependencies: [] }));
  const revoked = await f.run({ code, dependencies: ["pi-py-dependency-fixture"] });
  assert.equal(revoked.isError, true, "policy changes apply to the next call even when an environment is cached");
  assert.match(text(revoked), /whitelist/i);
});

test("archive-like distribution names resolve from the registry instead of a local file", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  await packageIndex(t, f.runtimeDir);
  fs.writeFileSync(path.join(f.agentDir, "py.json"), JSON.stringify({ dependencies: ["pi-py-dependency-fixture-whl"] }));
  fs.writeFileSync(path.join(f.directory, "pi_py_dependency_fixture.whl"), "not a wheel");
  const result = await f.run({ code: "import pi_py_dependency_fixture_whl\nprint(pi_py_dependency_fixture_whl.__version__)", dependencies: ["pi_py_dependency_fixture.whl"], timeout: 5 });
  assert.equal(result.isError, false, text(result));
  assert.equal(output(result).output, "1.0.0\n");
});

test("wheels-only resolution refuses a transitive source distribution without running its build script", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  await packageIndex(t, f.runtimeDir);
  fs.writeFileSync(path.join(f.agentDir, "py.json"), JSON.stringify({ dependencies: ["pi-py-dependency-fixture"] }));
  const rejected = await f.run({ code: "print('must-not-run')", dependencies: ["pi-py-dependency-fixture[source]"], timeout: 5 });
  assert.equal(rejected.isError, true, text(rejected));
  assert.match(text(rejected), /build|wheel|source/i);
  assert.equal(fs.existsSync(path.join(f.runtimeDir, "index", "build-ran")), false);
  assert.equal(fs.existsSync(path.join(f.directory, ".venv")), false);
  assert.equal(fs.existsSync(path.join(f.directory, "uv.lock")), false);
});

test("Python failures retain exit codes and nested shell permission failures remain errors", { timeout: 15_000 }, async (t) => {
  let deny = false;
  const f = await fixture(t, { extensions: [(pi) => {
    pi.on("tool_call", (event) => event.toolName === "bash" && deny ? { block: true, reason: "fixture denied nested shell" } : undefined);
  }] });
  const failed = await f.run({ code: "import sys\nprint('partial')\nsys.exit(7)" });
  assert.equal(failed.isError, true);
  assert.equal(output(failed).exit_code, 7);
  assert.equal(output(failed).output, "partial\n");
  const syntax = await f.run({ code: "if :" });
  assert.equal(syntax.isError, true);
  assert.match(text(syntax), /SyntaxError/);
  deny = true;
  const denied = await f.run({ code: "print(42)" });
  assert.equal(denied.isError, true);
  assert.match(text(denied), /fixture denied nested shell/);
  assert.equal(denied.structuredContent, undefined);
  deny = false;
  f.session.setActiveToolsByName([PY_TOOL]);
  const disabled = await f.run({ code: "print(42)" });
  assert.equal(disabled.isError, true);
  assert.match(text(disabled), /bash/);
});

test("the existing file-rewrite reminder runs on nested Python execution before any file changes", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t, { extensions: [execLints] });
  const harmless = await f.run({ code: "print('fine')" });
  assert.equal(harmless.isError, false, "saving input.py does not trip the shell rewrite reminder");
  fs.writeFileSync(path.join(f.directory, "file.txt"), "before");
  const code = "from pathlib import Path\np = Path('file.txt')\np.write_text(p.read_text().replace('before', 'after'))";
  const blocked = await f.run({ code });
  assert.equal(blocked.isError, true);
  assert.match(text(blocked), /Use `edit` for existing files/);
  assert.equal(fs.readFileSync(path.join(f.directory, "file.txt"), "utf8"), "before");
  const retried = await f.run({ code });
  assert.equal(retried.isError, false, text(retried));
  assert.equal(fs.readFileSync(path.join(f.directory, "file.txt"), "utf8"), "after");
});

test("codemode receives structured Python success and failure results through both levels of tool calls", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  f.session.setActiveToolsByName([...f.session.getActiveToolNames(), "codemode"]);
  const result = await f.run({ code: `const good = await tools.py({code: "print(6 * 7)"});
const bad = await tools.py({code: "raise ValueError('fixture failure')"});
return {answer: good.output.trim(), success: good.exit_code, failure: bad.exit_code, traceback: bad.output.includes('ValueError'),
  dirs: [good.py_dir, bad.py_dir].every((dir) => typeof dir === "string") && good.py_dir !== bad.py_dir};` }, "codemode");
  assert.equal(result.isError, false, text(result));
  assert.match(text(result), /"answer":"42"/);
  assert.match(text(result), /"success":0/);
  assert.match(text(result), /"failure":1/);
  assert.match(text(result), /"traceback":true/);
  assert.match(text(result), /"dirs":true/, "nested calls get distinct folders");
});

test("large output retains shell limits, full-output recovery and the structured output bound", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  const result = await f.run({ code: "print('x' * 1100000)" });
  assert.equal(result.isError, false);
  const data = output(result);
  assert.equal(data.truncated, true);
  assert.ok(Buffer.byteLength(data.output) < 1_050_000);
  assert.ok(text(result).length < 53_000);
  assert.ok(data.full_output_path);
  t.after(() => fs.rmSync(data.full_output_path!, { force: true }));
  assert.ok(data.py_dir);
  assert.equal(fs.statSync(path.join(data.py_dir, "output")).size, 1_100_001, "the saved output is complete");
  assert.ok(data.output.endsWith("x\n"), "the marker is removed from truncated output");
  assert.match(text(result), /Full output:/);
});

test("timeouts and cancellation stop a running Python snippet through the shell lifecycle", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  const timed = await f.run({ code: "import threading\nthreading.Event().wait()", timeout: 0.05 });
  assert.equal(timed.isError, true);
  assert.match(text(timed), /timed out/);
  let aborted: Promise<void> | undefined;
  const unsubscribe = f.session.subscribe((event) => {
    if (event.type === "tool_execution_update" && event.toolName === PY_TOOL && text(event.partialResult).includes("python-ready") && !aborted) {
      aborted = f.session.abort();
    }
  });
  t.after(unsubscribe);
  const cancelled = await f.run({ code: "import threading\nprint('python-ready', flush=True)\nthreading.Event().wait()", timeout: 5 });
  assert.ok(aborted, "streaming output triggers cancellation, not a fixed delay");
  await aborted;
  assert.equal(cancelled.isError, true);
  assert.match(text(cancelled), /aborted/i);
});

test("Python follows the actual remote shell backend and never falls back locally on connection failure", { timeout: 15_000 }, async (t) => {
  const stub = installSshStub(t);
  let target = `box:${stub.home}`;
  const f = await fixture(t, { extensions: [(pi) => {
    const local = createRemoteToolDefinitions(new RemoteSession(target), stub.root).find((tool) => tool.name === "bash")!;
    pi.registerTool({ ...local, async execute(id, args, signal, update, ctx) {
      const remote = createRemoteToolDefinitions(new RemoteSession(target), stub.root).find((tool) => tool.name === "bash")!;
      return remote.execute(id, args, signal, update, ctx);
    } });
  }] });
  await packageIndex(t, f.runtimeDir);
  fs.writeFileSync(path.join(f.agentDir, "py.json"), JSON.stringify({ dependencies: ["pi-py-dependency-fixture"] }));
  const remote = await f.run({ code: "import os, pi_py_dependency_fixture, pi_py_transitive_fixture\nprint(os.getcwd())\nprint(pi_py_dependency_fixture.__version__)\nprint(pi_py_transitive_fixture.__version__)\nfrom pathlib import Path\nPath('remote-marker').touch()", dependencies: ["pi-py-dependency-fixture"] });
  assert.equal(remote.isError, false, text(remote));
  assert.equal(output(remote).output, `${stub.home}\n1.0.0\n1.0.0\n`);
  assert.ok(stub.scripts().some(({ script }) => script.includes("--with ") && script.includes("pi-py-dependency-fixture")), "dependency execution is routed through SSH");
  assert.ok(fs.existsSync(path.join(stub.home, "remote-marker")));
  assert.equal(fs.existsSync(path.join(f.directory, "remote-marker")), false);
  target = `down:${stub.home}`;
  const down = await f.run({ code: "from pathlib import Path\nPath('local-fallback').touch()", dependencies: ["pi-py-dependency-fixture"] });
  assert.equal(down.isError, true);
  assert.match(text(down), /SSH connection to down failed/);
  assert.equal(fs.existsSync(path.join(f.directory, "local-fallback")), false);
  assert.equal(fs.existsSync(path.join(stub.home, "local-fallback")), false);
});
