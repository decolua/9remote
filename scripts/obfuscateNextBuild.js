#!/usr/bin/env node

/**
 * Post-build for Next.js (Turbopack) client chunks:
 * 1. Obfuscate .next/static/chunks/**\/*.js using browserPreset.
 * 2. Flatten standalone output for monorepo — move .next/standalone/web/*
 *    up to .next/standalone/* so opennextjs-cloudflare (which expects flat
 *    layout) can find .next/server/pages-manifest.json. Needed because
 *    outputFileTracingRoot=monorepoRoot nests by workspace name.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import JavaScriptObfuscator from "javascript-obfuscator";
import { browserPreset } from "./obfuscatorConfig.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TARGET_DIR = path.join(ROOT, "web/.next/static/chunks");
const STANDALONE_DIR = path.join(ROOT, "web/.next/standalone");
const STANDALONE_WEB_DIR = path.join(STANDALONE_DIR, "web");

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.isFile() && full.endsWith(".js")) files.push(full);
  }
  return files;
}

function run() {
  if (!fs.existsSync(TARGET_DIR)) {
    console.error(`❌ Not found: ${TARGET_DIR}. Run 'next build' first.`);
    process.exit(1);
  }

  const files = walk(TARGET_DIR);
  console.log(`🔒 Obfuscating ${files.length} client chunk(s)...`);

  let totalBefore = 0;
  let totalAfter = 0;
  for (const file of files) {
    const code = fs.readFileSync(file, "utf-8");
    totalBefore += code.length;
    const result = JavaScriptObfuscator.obfuscate(code, browserPreset).getObfuscatedCode();
    fs.writeFileSync(file, result);
    totalAfter += result.length;
  }

  const mb = (n) => (n / 1024 / 1024).toFixed(2);
  console.log(`✅ Obfuscated ${files.length} file(s): ${mb(totalBefore)}MB → ${mb(totalAfter)}MB`);
}

// Flatten .next/standalone/web/* → .next/standalone/* (monorepo workaround).
// Skip if standalone wasn't produced (plain `next build` without NEXT_PRIVATE_STANDALONE).
function flattenStandalone() {
  if (!fs.existsSync(STANDALONE_WEB_DIR)) return;
  console.log("📦 Flattening standalone output for monorepo...");
  for (const entry of fs.readdirSync(STANDALONE_WEB_DIR, { withFileTypes: true })) {
    const src = path.join(STANDALONE_WEB_DIR, entry.name);
    const dest = path.join(STANDALONE_DIR, entry.name);
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(src, dest);
  }
  fs.rmdirSync(STANDALONE_WEB_DIR);
  console.log("✅ Standalone flattened.");
}

run();
flattenStandalone();
