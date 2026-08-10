// ESM resolve hook — maps `@/<path>` to `<web-root>/<path>` via absolute file URL.
// web root is two levels up from this file (web/test/ → web/).
import { fileURLToPath } from "node:url";
import path from "node:path";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function resolve(specifier, context, nextResolve) {
  // `@/` alias → web root
  if (specifier.startsWith("@/")) {
    let rel = specifier.slice(2);
    if (!/\.(js|mjs|json)$/.test(rel)) rel += ".js";
    return nextResolve("file://" + WEB_ROOT.replace(/\\/g, "/") + "/" + rel, context);
  }
  // Extensionless relative imports (project convention) → append .js for Node ESM
  if (specifier.startsWith(".") && !/\.(js|mjs|json)$/.test(specifier)) {
    return nextResolve(specifier + ".js", context);
  }
  return nextResolve(specifier, context);
}
