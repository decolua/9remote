#!/usr/bin/env node

/**
 * Post-build obfuscator for Next.js (Turbopack) client chunks.
 * Scans .next/static/chunks/**\/*.js and obfuscates in-place using browserPreset.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import JavaScriptObfuscator from "javascript-obfuscator";
import { browserPreset } from "./obfuscatorConfig.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TARGET_DIR = path.join(ROOT, "web/.next/static/chunks");

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

run();
