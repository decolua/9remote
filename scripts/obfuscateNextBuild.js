#!/usr/bin/env node

/**
 * Post-build for Next.js (Turbopack) client chunks:
 * Obfuscate .next/static/chunks/**\/*.js using browserPreset.
 */

import fs from "fs"; 
import path from "path";
import { fileURLToPath } from "url";
import JavaScriptObfuscator from "javascript-obfuscator";
import { browserPreset } from "./obfuscatorConfig.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TARGET_DIR = path.join(ROOT, "web/.next/static/chunks");

// Next internals are public, already minified — obfuscating only adds breakage risk.
const SKIP_PREFIX = ["framework-", "main-", "main-app-", "polyfills-", "webpack-"];

function walk(dir, files = [], skipped = []) {
  if (!fs.existsSync(dir)) return { files, skipped };
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, files, skipped);
    } else if (entry.isFile() && full.endsWith(".js")) {
      if (SKIP_PREFIX.some((p) => entry.name.startsWith(p))) skipped.push(full);
      else files.push(full);
    }
  }
  return { files, skipped };
}

function run() {
  if (!fs.existsSync(TARGET_DIR)) {
    console.error(`❌ Not found: ${TARGET_DIR}. Run 'next build' first.`);
    process.exit(1);
  }

  const { files, skipped } = walk(TARGET_DIR);
  console.log(`🔒 Obfuscating ${files.length} client chunk(s)... (skipped ${skipped.length} Next internal chunk(s))`);

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

run();
