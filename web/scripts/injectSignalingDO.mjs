// Post-build injection of SignalingDO into the OpenNext worker bundle.
// Runs AFTER `opennextjs-cloudflare build`. Idempotent. Inlines the DO class +
// route handler directly into worker.js (avoids esbuild tree-shaking a class
// that nothing in the module graph imports).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const workerPath = path.join(root, ".open-next/worker.js");
const doSrcPath = path.join(root, "durable-objects/SignalingDO.js");

if (!existsSync(workerPath)) {
  console.error("[injectSignalingDO] .open-next/worker.js not found — run build:cf first");
  process.exit(1);
}

// DO source minus its own import line (worker gets a single shared import).
const doSrc = readFileSync(doSrcPath, "utf8")
  .replace(/^import\s*\{[^}]*DurableObject[^}]*\}\s*from\s*["']cloudflare:workers["'];?\s*/m, "")
  .trim();

let src = readFileSync(workerPath, "utf8");
if (src.includes("// injectSignalingDO")) {
  console.log("[injectSignalingDO] worker.js already patched — skip");
  process.exit(0);
}

// 1. Shared cloudflare:workers import near the top.
const importMarker = `// injectSignalingDO — added by scripts/injectSignalingDO.mjs (regenerated each build, do not edit)
// @ts-ignore injected
import { DurableObject } from "cloudflare:workers";

`;
// Anchor on the first existing top-level import; fall back to file head.
const anchor = src.match(/^(import\s|\/\/@ts-ignore[^\n]*\nimport\s)/m);
if (anchor) {
  src = src.replace(anchor[0], `${importMarker}${anchor[0]}`);
} else {
  src = importMarker + src;
}

// 2. Route /signaling/* before Next handler.
const routeCheck = `
            // injectSignalingDO — route WS upgrade to the signaling DO before Next handles it
            if (url.pathname.startsWith("/signaling/")) return handleSignaling(request, env);`;
src = src.replace(/(const url = new URL\(request\.url\);)/, "$1" + routeCheck);

// 3. Inline DO class + handler before `export default`.
src = src.replace(/(export default)/, `\n// injectSignalingDO — class + handler\n${doSrc}\n\n$1`);

writeFileSync(workerPath, src);
console.log("[injectSignalingDO] worker.js patched (inlined SignalingDO + handleSignaling)");
