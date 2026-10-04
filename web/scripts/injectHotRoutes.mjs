// Post-build injection of hot session routes into the OpenNext worker bundle.
// Runs AFTER `opennextjs-cloudflare build` (and after injectSignalingDO.mjs —
// it anchors on the signaling route check that script inserts). Idempotent.
// Serves /api/session/{create,heartbeat,update} from the outer worker, before
// the Next pipeline: same logic at 1-2ms CPU instead of 35-75ms.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const workerPath = path.join(root, ".open-next/worker.js");
const hotSrcPath = path.join(root, "hotRoutes.js");

if (!existsSync(workerPath)) {
  console.error("[injectHotRoutes] .open-next/worker.js not found — run build:cf first");
  process.exit(1);
}

const MARKER = "// injectHotRoutes";

let src = readFileSync(workerPath, "utf8");
if (src.includes(MARKER)) {
  console.log("[injectHotRoutes] worker.js already patched — skip");
  process.exit(0);
}

const hotSrc = readFileSync(hotSrcPath, "utf8")
  .replace(/^import\s[^\n]*\n/gm, "") // none today, but keep the copy import-proof
  .trim();

// 1. Route check right after the signaling check (inserted by injectSignalingDO.mjs).
const anchor = 'if (url.pathname.startsWith("/signaling/")) return handleSignaling(request, env);';
if (!src.includes(anchor)) {
  console.error("[injectHotRoutes] signaling anchor not found — injectSignalingDO.mjs output changed?");
  process.exit(1);
}
const routeCheck = `
            ${MARKER} — hot session API served raw, falls through to Next when not owned
            if (url.pathname.startsWith("/api/session/")) {
              const hot = await handleHotRoutes(request, env);
              if (hot) return hot;
            }`;
src = src.replace(anchor, anchor + routeCheck);

// 2. Inline handlers before `export default`. A replacer FUNCTION, not a string:
// hotSrc contains regex literals whose replacement semantics would corrupt the
// bundle otherwise (same lesson as injectSignalingDO.mjs).
src = src.replace("export default", () => `\n${MARKER} — handlers (copied from app/api/session/*, keep in sync)\n${hotSrc}\n\nexport default`);

// Loud failure instead of a silent no-op patch (risk: bundle format drift).
if (!src.includes("handleHotRoutes(request, env)") || !src.includes("async function sessionHeartbeat")) {
  console.error("[injectHotRoutes] patch verification failed — refusing to write a half-patched worker");
  process.exit(1);
}

writeFileSync(workerPath, src);
console.log("[injectHotRoutes] worker.js patched (inlined handleHotRoutes)");
