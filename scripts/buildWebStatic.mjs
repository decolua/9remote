#!/usr/bin/env node

/**
 * Build web app as static HTML/CSS/JS export for embedding into host.
 * Builds in a mirror of web/ without app/api (Cloudflare worker routes can't be statically
 * exported), so the real tree is never touched. The mirror keeps its .next cache between runs.
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const WEB_DIR = path.join(ROOT, "web");
const MIRROR_DIR = path.join(WEB_DIR, ".staticBuild");
const OUT_DIR = path.join(WEB_DIR, "out");

// Top-level entries of web/ the mirror must not carry (build output, caches, secrets, other targets).
const SKIP_TOP = new Set([
  "node_modules", ".next", "out", ".open-next", ".wrangler", ".staticBuild",
  "test", "migrations", "durable-objects",
]);
const SKIP_TOP_PREFIX = [".dev.vars", ".secrets-hash", ".env.development", "wrangler"];
const SKIP_REL = new Set([path.join("app", "api")]);

function shouldCopy(src) {
  const rel = path.relative(WEB_DIR, src);
  if (!rel) return true;
  if (SKIP_REL.has(rel)) return false;
  if (rel.includes(path.sep)) return true;
  return !SKIP_TOP.has(rel) && !SKIP_TOP_PREFIX.some((p) => rel.startsWith(p));
}

export function buildWebStatic() {
  console.log("🌐 Building web static bundle...");

  // Drop everything but the cache so files deleted from web/ don't linger in the mirror
  fs.mkdirSync(MIRROR_DIR, { recursive: true });
  for (const name of fs.readdirSync(MIRROR_DIR)) {
    if (name === ".next") continue;
    fs.rmSync(path.join(MIRROR_DIR, name), { recursive: true, force: true });
  }
  // Per entry: cpSync refuses to copy web/ into its own subdirectory
  for (const name of fs.readdirSync(WEB_DIR)) {
    const src = path.join(WEB_DIR, name);
    if (!shouldCopy(src)) continue;
    fs.cpSync(src, path.join(MIRROR_DIR, name), { recursive: true, preserveTimestamps: true, filter: shouldCopy });
  }

  // Tailwind v4 scans everything not gitignored, and only honors .gitignore inside a git repo;
  // without both, it reads the .next build output as source and emits stray classes
  fs.writeFileSync(path.join(MIRROR_DIR, ".gitignore"), ".next/\nout/\n");
  if (!fs.existsSync(path.join(MIRROR_DIR, ".git"))) execSync("git init -q", { cwd: MIRROR_DIR });

  execSync("npx next build --webpack", {
    cwd: MIRROR_DIR,
    stdio: "inherit",
    env: { ...process.env, STATIC_EXPORT: "1", NODE_ENV: "production" },
  });

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.cpSync(path.join(MIRROR_DIR, "out"), OUT_DIR, { recursive: true });

  console.log(`✅ Web static export complete: ${OUT_DIR}`);
  return OUT_DIR;
}

// Allow direct execution: node scripts/buildWebStatic.mjs
const isDirect = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirect) {
  buildWebStatic();
}
