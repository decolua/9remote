// Sync web/.dev.vars → Cloudflare Workers secrets (prod + dev env)
// Usage: node scripts/syncSecrets.mjs [--env=production|dev|all] [--force]
// Skips envs whose .dev.vars hash is unchanged since last sync (cache in web/.secrets-hash-<env>).
import { readFileSync, existsSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.resolve(__dirname, "../web/.dev.vars");
const WEB_DIR = path.resolve(__dirname, "../web");

const args = process.argv.slice(2);
const envArg = args.find(a => a.startsWith("--env="))?.split("=")[1] || "all";
const force = args.includes("--force");
const targets = envArg === "all" ? ["production", "dev"] : [envArg];

if (!existsSync(ENV_FILE)) {
  console.error(`❌ Not found: ${ENV_FILE}`);
  process.exit(1);
}

const rawEnv = readFileSync(ENV_FILE, "utf8");
const fileHash = createHash("sha256").update(rawEnv).digest("hex").slice(0, 16);

// Parse KEY="value" lines (skip comments + empty)
const lines = rawEnv.split("\n");
const secrets = {};
for (const raw of lines) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*"?(.*?)"?$/);
  // empty value = placeholder not filled in yet; wrangler rejects empty secrets
  if (m && m[2]) secrets[m[1]] = m[2];
}

const names = Object.keys(secrets);
if (!names.length) {
  console.error("❌ No secrets parsed from .dev.vars");
  process.exit(1);
}

console.log(`📦 Found ${names.length} secrets: ${names.join(", ")}`);
console.log(`🎯 Targets: ${targets.join(", ")}\n`);

let syncedAny = false;
for (const target of targets) {
  const hashPath = path.join(WEB_DIR, `.secrets-hash-${target}`);
  if (!force && existsSync(hashPath) && readFileSync(hashPath, "utf8") === fileHash) {
    console.log(`━━━ ${target} ━━━ ⏭️  unchanged (use --force to re-sync)`);
    continue;
  }
  console.log(`━━━ ${target} ━━━`);
  syncedAny = true;
  for (const name of names) {
    const value = secrets[name];
    const envFlag = target === "production" ? "" : ` --env ${target}`;
    try {
      execSync(`npx wrangler secret put ${name}${envFlag}`, {
        cwd: WEB_DIR,
        input: value + "\n",
        stdio: ["pipe", "inherit", "inherit"]
      });
    } catch (e) {
      console.error(`❌ Failed: ${name} (${target})`);
    }
  }
  writeFileSync(hashPath, fileHash);
  console.log();
}

if (!syncedAny) console.log("✅ All targets up to date.");
else console.log("✅ Done.");
