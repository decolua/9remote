// ESM resolve hook — maps `@/<path>` to `<web-root>/<path>` via absolute file URL.
// web root is two levels up from this file (web/test/ → web/).
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function resolve(specifier, context, nextResolve) {
  // `@/` alias → web root
  if (specifier.startsWith("@/")) {
    let rel = specifier.slice(2);
    if (!/\.(js|mjs|json)$/.test(rel)) rel += ".js";
    const abs = path.join(WEB_ROOT, rel);
    // Directory import (e.g. `@/shared/i18n`) — the bundler resolves index.js;
    // mirror that so tests can import modules whose deps use directory imports.
    if (!fs.existsSync(abs) && fs.existsSync(path.join(abs.slice(0, -3), "index.js"))) {
      rel = rel.slice(0, -3) + "/index.js";
    }
    return nextResolve("file://" + WEB_ROOT.replace(/\\/g, "/") + "/" + rel, context);
  }
  // Extensionless relative imports (project convention) → append .js for Node ESM
  if (specifier.startsWith(".") && !/\.(js|mjs|json)$/.test(specifier)) {
    return nextResolve(specifier + ".js", context);
  }
  return nextResolve(specifier, context);
}
