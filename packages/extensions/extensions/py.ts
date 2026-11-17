// One-off Python scripts executed through the session's existing shell tool, saved per call for later reuse.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createBashToolDefinition, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type TObject } from "typebox";

export const PY_TOOL = "py";

// Pi declares bash's output schema as a plain object; extending its properties keeps codemode's declaration flat.
const bashOutputSchema = createBashToolDefinition(process.cwd()).outputSchema as TObject;
const pyOutputSchema = Type.Object({
  ...bashOutputSchema.properties,
  py_dir: Type.Optional(Type.String({ description: "Folder holding this call's input.py and output; absent if the script did not finish" })),
});

const distributionName = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/** Checks the entire requirement before uv can interpret it as a path, URL or option. */
function parseDependency(requirement: string): { name: string; requirement: string } {
  const invalid = () => new Error(`Unsupported Python dependency ${JSON.stringify(requirement)}. Use a distribution name with optional extras and version comparisons.`);
  if (/[\r\n\u2028\u2029]/.test(requirement)) throw invalid();
  const match = /^[ \t]*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)(?:[ \t]*\[([A-Za-z0-9._ \t,-]+)\])?[ \t]*(.*?)[ \t]*$/.exec(requirement);
  if (!match) throw invalid();
  const name = normalizeName(match[1]);
  const extras = match[2]?.split(",").map((extra) => extra.trim()) ?? [];
  if (extras.some((extra) => !distributionName.test(extra))) throw invalid();
  let versions = match[3].trim();
  if (versions.startsWith("(") && versions.endsWith(")")) {
    versions = versions.slice(1, -1).trim();
    if (!versions) throw invalid();
  }
  if (versions && versions.split(",").some((version) => !/^(?:===|~=|==|!=|<=|>=|<|>)[ \t]*[A-Za-z0-9][A-Za-z0-9.*+!_-]*$/.test(version.trim()))) throw invalid();
  return {
    name,
    requirement: name + (extras.length ? `[${extras.map(normalizeName).join(",")}]` : "") + versions.replace(/[ \t]/g, ""),
  };
}

/** Reads user policy afresh; only a missing file means an empty whitelist. */
function approvedDependencies(dependencies: string[]): string[] {
  if (dependencies.length === 0) return [];
  const requested = dependencies.map(parseDependency);
  const configPath = join(getAgentDir(), "py.json");
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") config = { dependencies: [] };
    else throw new Error(`Cannot read Python dependency whitelist at ${configPath}. Ask the user to fix it; do not modify it yourself.`, { cause: error });
  }
  // The user-owned JSON file is a trust boundary, not a schema-validated tool argument.
  if (!config || typeof config !== "object" || !("dependencies" in config) || !Array.isArray(config.dependencies) ||
    config.dependencies.some((name: unknown) => typeof name !== "string" || name.trim() !== name || !distributionName.test(name))) {
    throw new Error(`Invalid Python dependency whitelist at ${configPath}: expected {"dependencies": [distribution names]}. Ask the user to fix it; do not modify it yourself.`);
  }
  const allowed = new Set((config.dependencies as string[]).map(normalizeName));
  for (const { name } of requested) {
    if (!allowed.has(name)) {
      throw new Error(`Python dependency ${JSON.stringify(name)} is not permitted. Ask the user to add ${JSON.stringify(name)} to the dependency whitelist in ${configPath}. Do not modify the whitelist yourself.`);
    }
  }
  return requested.map(({ requirement }) => requirement);
}

/** Shell script that saves the source to `$PY_DIR/input.py`, runs it from stdin and tees combined output to `$PY_DIR/output`. */
function pyCommand(code: string, dependencies: string[], id: string, marker: string): string {
  // A quoted, collision-free heredoc preserves source without shell expansion.
  const lines = new Set(code.split("\n"));
  let delimiter = "PI_PY";
  while (lines.has(delimiter)) delimiter += "_";
  const command = [
    "uv run --no-project --isolated --no-config --no-env-file --no-python-downloads --no-build --exclude-newer 30d --quiet",
    // Validated registry requirements contain no shell quotes or expansion syntax.
    ...dependencies.map((requirement) => `--with '${requirement}'`),
    '-- python -u -B - < "$PY_DIR/input.py" 2>&1 | tee "$PY_DIR/output"',
  ].join(" ");
  return [
    "umask 077",
    'base="${XDG_RUNTIME_DIR:-/tmp}/pi-py-$(id -u)"',
    // A shared /tmp base must be ours: refuse a pre-created directory or symlink.
    'mkdir -p "$base" && [ ! -L "$base" ] && [ -O "$base" ] || { echo "py: unsafe or unusable directory $base" >&2; exit 1; }',
    `export PY_DIR="$base/${id}"`,
    'mkdir -p "$PY_DIR" || exit $?',
    // Capturing the heredoc in a variable avoids a `cat > file` heredoc, which the file-rewrite lint flags.
    `code=$(cat <<'${delimiter}'\n${code}\n${delimiter}\n)`,
    `printf '%s\\n' "$code" > "$PY_DIR/input.py" || exit $?`,
    "set -o pipefail",
    // An explicit config environment variable overrides uv's --no-config discovery flag.
    "unset UV_CONFIG_FILE",
    // Invoke Python, not uv's script mode: inline dependency metadata must not install additional packages.
    // Stdin also keeps sys.path[0] at the working directory, as for an interactive snippet.
    command,
    "status=$?",
    `printf '\\n%s%s\\n' '${marker}' "$PY_DIR"`,
    "exit $status",
  ].join("\n");
}

/** Removes the last marker line, returning the stripped text and the folder it named. */
function takeMarker(text: string, marker: string): { text: string; dir?: string } {
  const start = text.lastIndexOf(`\n${marker}`);
  if (start < 0) return { text };
  const end = text.indexOf("\n", start + 1 + marker.length);
  if (end < 0) return { text };
  return { text: text.slice(0, start) + text.slice(end + 1), dir: text.slice(start + 1 + marker.length, end) };
}

export default function pyExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: PY_TOOL,
    label: "Py",
    defaultActive: true,
    description: "Run a one-off Python script in a fresh process in the current working directory, including on the session's remote host. " +
      "Nothing persists between calls: every call starts without the variables, functions or imports of earlier calls. " +
      "Use print() for results. Each call saves its source and combined output as input.py and output in its own folder, " +
      "available to the script as the PY_DIR environment variable and reported in the result. " +
      "To reuse results, save them to PY_DIR (for example as JSON or pickle) and load them from that path in a later call. " +
      "Uses uv to run in an isolated environment with optional explicit dependencies, without changing the project environment or lockfile " +
      "or downloading Python. Requires uv, an installed Python, and the bash tool enabled. " +
      "Has the same filesystem/network permissions as bash; this is not a sandbox. " +
      "Returns combined stdout/stderr, exit status and elapsed time; output limits and cancellation are the same as bash.",
    promptSnippet: "Run one-off Python scripts for computation and data analysis; nothing persists between calls",
    promptGuidelines: [
      "Use py for short computations and data analysis, codemode for tool orchestration, and bash for commands and saved scripts.",
      "Each py call is a fresh process: redefine what it uses, or load results an earlier call saved to its PY_DIR.",
      "Use read for inspecting files and edit/write for file changes so their normal feedback and lint results are preserved; py does not replace them.",
      "Use wait for readiness instead of Python sleeps or polling. Declare py dependencies in its dependencies parameter, not by installing from a script.",
    ],
    parameters: Type.Object({
      code: Type.String({ description: "Python source code, not a shell command. Use print() to return values." }),
      dependencies: Type.Optional(Type.Array(Type.String(), { description: "Python distribution requirements for this call, e.g. numpy or pandas>=2. Optional; defaults to []." })),
      timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "Timeout in seconds for dependency resolution and execution (optional; uses the bash default)" })),
    }),
    outputSchema: pyOutputSchema,
    reachesTools: () => ["bash"],
    async execute(toolCallId, { code, dependencies = [], timeout }, signal, onUpdate, ctx) {
      const requirements = approvedDependencies(dependencies);
      // Nested ids contain `/`; a short digest is a safe, unique folder name.
      const id = createHash("sha256").update(toolCallId).digest("hex").slice(0, 12);
      const marker = `PI_PY_DIR_${id}=`;
      const command = pyCommand(code, requirements, id, marker);
      const outcome = await ctx.executeTool("bash", { command, ...(timeout === undefined ? {} : { timeout }) }, { signal, onUpdate });
      const { result } = outcome;
      let dir: string | undefined;
      const content = result.content.map((item) => {
        if (item.type !== "text") return item;
        const taken = takeMarker(item.text, marker);
        dir ??= taken.dir;
        return { ...item, text: taken.text };
      });
      // The bash tool's output schema guarantees a string `output` whenever structured content is present.
      const structured = result.structuredContent as { output: string } | undefined;
      const output = structured && takeMarker(structured.output, marker);
      dir ??= output?.dir;
      if (dir) content.push({ type: "text", text: `Saved: ${dir}/input.py, ${dir}/output` });
      return {
        ...result,
        content,
        ...(structured && output ? { structuredContent: { ...structured, output: output.text, ...(dir ? { py_dir: dir } : {}) } } : {}),
        // Pi accounts for nested tool usage itself.
        usage: undefined,
        isError: outcome.isError,
      };
    },
  });
}
