#!/usr/bin/env node

/**
 * Build npm package with Next.js standalone + CLI bundle
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function run(cmd, options = {}) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: ROOT, ...options });
}

async function build() {
  console.log("🔨 Building npm package...\n");

  // Step 1: Build Next.js standalone
  console.log("📦 Step 1: Building Next.js standalone...");
  run("BUILD_STANDALONE=true npm run build");

  // Step 2: Bundle CLI
  console.log("\n📦 Step 2: Bundling CLI...");
  run("node scripts/buildCli.js");

  // Step 3: Copy standalone to dist
  console.log("\n📦 Step 3: Preparing package files...");
  
  const standalonePath = path.join(ROOT, ".next/standalone");
  const staticPath = path.join(ROOT, ".next/static");
  const distStandalone = path.join(ROOT, "dist/standalone");
  const distStatic = path.join(ROOT, "dist/standalone/.next/static");

  // Clean old dist/standalone
  if (fs.existsSync(distStandalone)) {
    fs.rmSync(distStandalone, { recursive: true });
  }

  // Copy standalone
  fs.cpSync(standalonePath, distStandalone, { recursive: true });
  
  // Copy static assets
  fs.cpSync(staticPath, distStatic, { recursive: true });
  
  // Copy public folder
  const publicPath = path.join(ROOT, "public");
  const distPublic = path.join(ROOT, "dist/standalone/public");
  if (fs.existsSync(publicPath)) {
    fs.cpSync(publicPath, distPublic, { recursive: true });
  }

  // Remove unnecessary files to reduce package size
  const unnecessaryPaths = [
    "dist/standalone/node_modules/typescript",
    "dist/standalone/node_modules/.package-lock.json"
  ];
  for (const p of unnecessaryPaths) {
    const fullPath = path.join(ROOT, p);
    if (fs.existsSync(fullPath)) {
      fs.rmSync(fullPath, { recursive: true });
    }
  }

  // Step 4: Create npm pack
  console.log("\n📦 Step 4: Creating npm package...");
  run("npm pack");

  console.log("\n✅ Package build complete!");
}

build().catch(err => {
  console.error("❌ Build failed:", err);
  process.exit(1);
});
