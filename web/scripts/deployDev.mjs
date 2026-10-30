// Deploys the dev Worker, bypassing `opennextjs-cloudflare deploy`.
//
// Two reasons it cannot be used here:
//   1. It boots miniflare to read env vars, and miniflare cannot emulate a DO
//      bound via script_name — it builds a JS identifier from the script name,
//      so "9remote-worker" becomes an invalid `9remote_worker_SignalingDO`.
//   2. That same step dumps [vars] into process.env, so wrangler would pick up
//      CLOUDFLARE_ACCOUNT_ID from the config as its deploy target by accident.
// Its own work (populateCache, skew protection) is inert for this project:
// caches are "dummy" and skewProtection is off.
//
// The account is explicit here, with the key pair from .dev.vars: the resources
// live in the prod account, while the OAuth login points at a different one.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const ACCOUNT_ID = "b8fd5ae88c77ff8e3e89f9199e22bea5";
const NEEDED = ["CLOUDFLARE_API_KEY", "CLOUDFLARE_EMAIL"];

// .dev.vars is Worker-secret source, uncommitted — the same file secrets:sync reads.
function readDevVars() {
  const out = {};
  const text = readFileSync(path.join(root, ".dev.vars"), "utf8");
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
  return out;
}

const vars = readDevVars();
const missing = NEEDED.filter((k) => !vars[k]);
if (missing.length) {
  console.error(`[deployDev] .dev.vars is missing ${missing.join(", ")} — cannot reach account ${ACCOUNT_ID}`);
  process.exit(1);
}

const res = spawnSync("npx", ["wrangler", "deploy", "--env", "dev"], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    CLOUDFLARE_API_KEY: vars.CLOUDFLARE_API_KEY,
    CLOUDFLARE_EMAIL: vars.CLOUDFLARE_EMAIL,
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
    // Without this wrangler sees a Next project and re-delegates to
    // `opennextjs-cloudflare deploy` — straight back into the miniflare failure.
    OPEN_NEXT_DEPLOY: "true",
  },
});
process.exit(res.status ?? 1);
