// Post-build injection of a `scheduled` handler into the OpenNext worker.
// Runs AFTER injectSignalingDO.mjs. The [triggers] cron in wrangler.toml calls
// scheduled() — without this export the hourly cron fired into nothing.
// Reuses the existing /api/cleanup route (auth + temp_keys purge + dead tunnels)
// by invoking the worker's own fetch handler with a synthetic URL.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const workerPath = path.join(root, ".open-next/worker.js");

if (!existsSync(workerPath)) {
  console.error("[injectScheduled] .open-next/worker.js not found — run build:cf first");
  process.exit(1);
}

let src = readFileSync(workerPath, "utf8");
if (src.includes("// injectScheduled")) {
  console.log("[injectScheduled] worker.js already patched — skip");
  process.exit(0);
}

// 1. Turn the default export into a named const so scheduled() can call it.
if (!src.includes("export default {")) {
  console.error("[injectScheduled] `export default {` not found — OpenNext output changed?");
  process.exit(1);
}
src = src.replace("export default {", "const workerDefault = {");

// 2. Re-export default + add scheduled.
src += `
// injectScheduled — added by scripts/injectScheduled.mjs (regenerated each build, do not edit)
export default workerDefault;

export async function scheduled(controller, env, ctx) {
  const secret = env.CRON_SECRET || env.APP_SECRET;
  if (!secret) return;
  ctx.waitUntil(workerDefault.fetch(
    new Request("https://cron.internal/api/cleanup", {
      headers: { Authorization: \`Bearer \${secret}\` },
    }),
    env,
    ctx,
  ));
}
`;

writeFileSync(workerPath, src);
console.log("[injectScheduled] worker.js patched (scheduled handler reusing /api/cleanup)");
