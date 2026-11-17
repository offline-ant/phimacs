/** Lets natively imported extension modules share the module objects of the Pi that loads them. */
import { registerHooks } from "node:module";

// Pi gives its own SDK only to extension files jiti transpiles. It imports a
// package's compiled .js natively, and Node then resolves `@earendil-works/*`
// from the package's own node_modules: a second SDK copy (about 0.75 s per
// start), or a failed import in an npm install without peer copies.

/** Specifier -> module namespace, shared by every package of this process. */
type HostModules = Record<string, Record<string, unknown>>;

const REGISTRY = Symbol.for("phimacs.pimux.hostModules");
const SCHEME = "pi-host:";

/**
 * Serves MODULES to every later import of their specifiers in this process.
 * A specifier keeps the first object shared for it; one hook serves them all.
 */
export function shareHostModules(modules: HostModules): void {
  const global = globalThis as { [REGISTRY]?: HostModules };
  const registry = global[REGISTRY];
  if (registry) {
    for (const [specifier, namespace] of Object.entries(modules)) registry[specifier] ??= namespace;
    return;
  }
  const shared: HostModules = { ...modules };
  global[REGISTRY] = shared;
  registerHooks({
    resolve(specifier, context, next) {
      return Object.hasOwn(shared, specifier) ? { url: `${SCHEME}${specifier}`, shortCircuit: true } : next(specifier, context);
    },
    load(url, context, next) {
      if (!url.startsWith(SCHEME)) return next(url, context);
      const specifier = url.slice(SCHEME.length);
      const lines = [`const namespace = globalThis[Symbol.for("phimacs.pimux.hostModules")][${JSON.stringify(specifier)}];`];
      Object.keys(shared[specifier]!).forEach((name, index) => {
        lines.push(`const e${index} = namespace[${JSON.stringify(name)}];`, `export { e${index} as ${JSON.stringify(name)} };`);
      });
      return { format: "module", source: lines.join("\n"), shortCircuit: true };
    },
  });
}
