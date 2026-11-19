import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../../", import.meta.url));
const workspacePaths: string[] = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).workspaces;
const packages = workspacePaths.map((directory) => {
  const directoryPath = path.join(root, directory);
  return { directory: directoryPath, manifest: JSON.parse(fs.readFileSync(path.join(directoryPath, "package.json"), "utf8")) };
});
const workspaceNames = new Set(packages.map(({ manifest }) => manifest.name));
const hostPeers = new Set(["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]);

function files(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (["dist", "node_modules"].includes(entry.name)) return [];
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : [file];
  });
}

function leaves(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") return Object.values(value).flatMap(leaves);
  return [];
}

function packageName(specifier: string): string {
  return specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!;
}

test("source packages share one root workspace lock", () => {
  const sourcePackages = fs.readdirSync(path.join(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}`).sort();
  assert.deepEqual(sourcePackages, [...workspacePaths].sort());
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  assert.deepEqual([...workspaceNames].sort(), ["@phimacs/browser", "@phimacs/extensions", "@phimacs/orchestration", "@phimacs/pimux", "@phimacs/sound", "@phimacs/tau"]);
  assert.deepEqual(lock.packages[""].workspaces, workspacePaths);
  assert.equal(fs.existsSync(path.join(root, "packages/pagent")), false);
  assert.equal(Object.hasOwn(lock.packages, "packages/pagent"), false);
  assert.equal(Object.hasOwn(lock.packages, "node_modules/pagent"), false);
  for (const { directory, manifest } of packages) {
    const relative = path.relative(root, directory);
    assert.deepEqual(lock.packages[`node_modules/${manifest.name}`], { resolved: relative, link: true });
    assert.equal(lock.packages[relative].version, manifest.version);
    for (const group of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      assert.deepEqual(lock.packages[relative][group], manifest[group]);
      for (const name of ["pagent", "@phimacs/tau"]) {
        assert.equal(Object.hasOwn(manifest[group] ?? {}, name), false, `${manifest.name} must not depend on ${name}`);
      }
    }
  }
});

test("external requirements are exact and internal dependencies resolve locally", () => {
  for (const { directory, manifest } of packages) {
    for (const group of ["dependencies", "devDependencies"]) {
      for (const [name, version] of Object.entries(manifest[group] ?? {})) {
        if (workspaceNames.has(name)) {
          assert.equal(version, packages.find(item => item.manifest.name === name)!.manifest.version);
        } else assert.match(String(version), /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/, `${manifest.name} ${name} must be exact`);
      }
    }
    for (const [name, version] of Object.entries(manifest.peerDependencies ?? {})) {
      if (hostPeers.has(name)) assert.equal(version, "*", `${manifest.name} ${name} is provided by Pi`);
    }
    assert.ok(fs.existsSync(path.join(directory, "LICENSE")));
    assert.equal(fs.existsSync(path.join(directory, "package-lock.json")), false);
  }
});

test("original MIT components and Lisp packages name offline-ant as copyright holder", () => {
  const components = [".", "emacs/config", "emacs/pi-deck", ...workspacePaths.filter(directory => directory !== "packages/tau")];
  for (const component of components) {
    const license = fs.readFileSync(path.join(root, component, "LICENSE"), "utf8");
    assert.match(license, /^MIT License\n\nCopyright \(c\) \d{4} offline-ant\n/, `${component}/LICENSE`);
  }
  for (const file of ["emacs/pi-deck/pi-deck.el", "packages/orchestration/emacs/pi-orchestration.el", "packages/sound/emacs/pi-sound.el"]) {
    assert.match(fs.readFileSync(path.join(root, file), "utf8"), /^;; Author: offline-ant$/m, file);
  }
});

test("Tau is a private frontend and preserves the upstream MIT grant", () => {
  const tau = packages.find(({ manifest }) => manifest.name === "@phimacs/tau")!;
  assert.equal(tau.directory, path.join(root, "packages/tau"));
  assert.equal(tau.manifest.private, true);
  assert.equal(tau.manifest.license, "MIT");
  assert.match(fs.readFileSync(path.join(tau.directory, "LICENSE"), "utf8"), /^MIT License\n\nCopyright \(c\) 2026 deflating\n/);
  assert.match(fs.readFileSync(path.join(tau.directory, "NOTICE.md"), "utf8"), /github\.com\/milanglacier\/pi-tau-web-server/);
});

test("incorporated Pilish source keeps its GPL and recorded upstream identity", () => {
  const directory = path.join(root, "emacs/pilish");
  for (const file of ["pilish.el", "pilish-runtime.el", "pilish-grammars.el", "README.org", "AGENTS.md", "test/pilish-runtime-test.el"]) {
    assert.ok(fs.statSync(path.join(directory, file)).isFile(), file);
  }
  assert.match(fs.readFileSync(path.join(directory, "LICENSE"), "utf8"), /GNU GENERAL PUBLIC LICENSE/);
  assert.match(fs.readFileSync(path.join(directory, "pilish.el"), "utf8"), /GNU General Public License/);
  const provenance = JSON.parse(fs.readFileSync(path.join(root, "provenance/pilish-import.json"), "utf8"));
  assert.match(provenance.upstream.incorporatedRevision, /^[a-f0-9]{40}$/);
  assert.match(provenance.upstream.repository, /github\.com\/dnouri\/pilish/);
  assert.ok(provenance.selection.excludeDirectories.length > 0);
  assert.match(fs.readFileSync(path.join(directory, "NOTICE.md"), "utf8"), /Modified-version notice — \d{4}-\d{2}-\d{2}/);
  assert.equal(fs.existsSync(path.join(directory, ".git")), false, "Pilish is ordinary product source");
});

test("runtime imports use declared exports and form an acyclic package graph", () => {
  const edges = new Map<string, Set<string>>();
  for (const { directory, manifest } of packages) {
    const dependencies = new Set(Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }));
    const outgoing = new Set<string>();
    edges.set(manifest.name, outgoing);
    for (const file of files(directory)) {
      const relative = path.relative(directory, file);
      if (!file.endsWith(".ts") || file.endsWith(".test.ts") || /^(?:test|scripts)[/\\]/.test(relative)) continue;
      const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          const specifier = node.moduleSpecifier.text;
          if (specifier.startsWith(".")) {
            assert.ok(path.resolve(path.dirname(file), specifier).startsWith(directory + path.sep), `${relative} escapes its package: ${specifier}`);
          } else if (!specifier.startsWith("node:")) {
            const name = packageName(specifier);
            assert.ok(dependencies.has(name), `${manifest.name}/${relative} has undeclared runtime import ${specifier}`);
            if (workspaceNames.has(name)) {
              outgoing.add(name);
              const target = packages.find((item) => item.manifest.name === name)!;
              const subpath = specifier === name ? "." : `.${specifier.slice(name.length)}`;
              assert.ok(Object.hasOwn(target.manifest.exports ?? {}, subpath), `${specifier} is not exported`);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  const walk = (name: string, visiting: Set<string>, complete: Set<string>): void => {
    assert.ok(!visiting.has(name), `dependency cycle through ${name}`);
    if (complete.has(name)) return;
    visiting.add(name);
    for (const target of edges.get(name) ?? []) walk(target, visiting, complete);
    visiting.delete(name);
    complete.add(name);
  };
  const complete = new Set<string>();
  for (const name of edges.keys()) walk(name, new Set(), complete);
});

test("each extension package first shares exactly its Pi peers with its compiled extensions", () => {
  for (const { directory, manifest } of packages.filter(({ manifest }) => manifest.pi?.extensions)) {
    assert.equal(manifest.pi.extensions[0], "./host-modules.ts", `${manifest.name} must load host-modules.ts first`);
    assert.ok(manifest.files.includes("host-modules.ts"), `${manifest.name} must ship host-modules.ts`);
    const imports = ts.preProcessFile(fs.readFileSync(path.join(directory, "host-modules.ts"), "utf8")).importedFiles.map(({ fileName }) => fileName);
    const peers = Object.keys(manifest.peerDependencies ?? {}).filter((name) => hostPeers.has(name));
    assert.deepEqual(imports.filter((name) => name !== "@phimacs/pimux/host-modules").sort(), peers.sort(), `${manifest.name} host-modules.ts`);
  }
});

test("worker task status resolves through the root workspace", () => {
  const orchestration = packages.find(({ manifest }) => manifest.name === "@phimacs/orchestration")!;
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  assert.equal(orchestration.manifest.bin["phimacs-task-status"], "./dist/worker-task-cli.js");
  assert.equal(lock.packages["packages/orchestration"].bin["phimacs-task-status"], "dist/worker-task-cli.js");
  const executable = path.join(orchestration.directory, orchestration.manifest.bin["phimacs-task-status"]);
  assert.ok(fs.statSync(executable).isFile());
  fs.accessSync(executable, fs.constants.X_OK);
});

test("compiled exports, Pi entry points and installed assets exist", () => {
  for (const { directory, manifest } of packages) {
    for (const asset of [...leaves(manifest.exports), ...leaves(manifest.bin), ...(manifest.pi?.extensions ?? []), ...(manifest.pi?.skills ?? [])]) {
      assert.ok(fs.existsSync(path.resolve(directory, asset)), `${manifest.name}: missing ${asset}; run npm run compile`);
    }
    assert.equal(fs.existsSync(path.join(directory, "node_modules", "@earendil-works", "pi-coding-agent")), false, `${manifest.name} must not have a nested host SDK`);
  }
  const pimux = packages.find(({ manifest }) => manifest.name === "@phimacs/pimux")!;
  assert.equal(pimux.manifest.pi, undefined, "the private companion is never an auto-discovered extension");
  const pimuxBin = fs.readFileSync(path.join(pimux.directory, "bin", "pimux"), "utf8");
  assert.match(pimuxBin, /dist\/control\.js/);
  assert.match(pimuxBin, /dist\/launch-entry\.js/);
  const orchestration = path.join(root, "packages", "orchestration");
  for (const asset of ["emacs/pi-orchestration.el", "shell/osc133.bash", "shell/osc133.fish", "shell/osc133.gdb"]) {
    assert.ok(fs.existsSync(path.join(orchestration, asset)), asset);
  }
});
