// Post-build injection of the sites-host branch into the OpenNext worker bundle.
// Runs AFTER `opennextjs-cloudflare build`. Idempotent. Mirrors
// injectSignalingDO.mjs: the check has to sit ahead of the Next handler, and
// inlining beats importing because nothing in the module graph would pull it in.
//
// The branch is what makes the second origin an isolation boundary rather than
// a second name for the same app: on the sites host, only the proxy page, the
// worker and the browse scope resolve. Everything else 404s, so a script in a
// browsed site has no API to talk to.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const workerPath = path.join(root, ".open-next/worker.js");
const srcPath = path.join(root, "shared/utils/sitesHost.js");

if (!existsSync(workerPath)) {
  console.error("[injectSitesHost] .open-next/worker.js not found — run build:cf first");
  process.exit(1);
}

// Module source minus its export keywords — it is inlined, not imported.
const hostSrc = readFileSync(srcPath, "utf8")
  .replace(/^export /gm, "")
  .trim();

let src = readFileSync(workerPath, "utf8");
if (src.includes("// injectSitesHost")) {
  console.log("[injectSitesHost] worker.js already patched — skip");
  process.exit(0);
}

// 1. Branch inside workerDefault.fetch, ahead of every other route — including
//    signaling, so the sites host cannot reach that either.
//
//    `const url = new URL(request.url)` appears in handleSignaling and in the
//    DO's own fetch as well, and a bare replace takes the first of them — which
//    lands the branch inside a function where `env` and the router do not mean
//    what they do here. Anchor on the signaling line instead: injectSignalingDO
//    runs first and writes exactly one of those, in the right function.
const anchor = `if (url.pathname.startsWith("/signaling/")) return handleSignaling(request, env);`;
const anchorCount = src.split(anchor).length - 1;
if (anchorCount !== 1) {
  console.error(`[injectSitesHost] expected 1 anchor, found ${anchorCount} — run injectSignalingDO first`);
  process.exit(1);
}
const routeCheck = `// injectSitesHost — the sites origin serves the proxy shell only
            if (isSitesHost(url.hostname)) return handleSitesHost(request, url, env);
            `;
src = src.replace(anchor, routeCheck + anchor);

// 2. Inline the host rules + handler before `export default`.
const handler = `
// injectSitesHost — host rules + handler
${hostSrc}

async function handleSitesHost(request, url, env) {
  const route = routeSitesRequest(url.pathname, url.hostname);
  if (!route) return new Response("Not found", { status: 404 });

  // Browse paths belong to the service worker. A request reaching the edge here
  // means the worker is not controlling the page yet (cold start, or it was
  // evicted), so hand back the proxy shell and let it register and retry.
  const asset = route.kind === "browse" ? "/proxy.html" : route.asset;

  const res = await env.ASSETS.fetch(new URL(asset, url.origin));
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(route.headers)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}
`;
// A replacer FUNCTION, not a template: the bundle contains regex literals whose
// source ends in `$/` followed by a string, and a `$1` in a replacement string
// would be substituted there too — silently rewriting SignalingDO's key regex.
src = src.replace("export default", () => `${handler}\nexport default`);

writeFileSync(workerPath, src);
console.log("[injectSitesHost] worker.js patched (sites host branch + handler)");
