#!/usr/bin/env node

/**
 * Build npm package: Next.js standalone + CLI bundle + Server bundle
 */

import { execSync } from "child_process";
import * as esbuild from "esbuild";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function run(cmd) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: ROOT });
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Shared esbuild config for Node.js bundles
const baseConfig = {
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  minify: true,
  sourcemap: false,
  banner: {
    js: "const __importMetaUrl = require('url').pathToFileURL(__filename).href;"
  },
  define: {
    "import.meta.url": "__importMetaUrl"
  }
};

async function buildCli() {
  console.log("\n📦 Bundling CLI...");
  
  await esbuild.build({
    ...baseConfig,
    entryPoints: [path.join(ROOT, "cli/index.js")],
    outfile: path.join(ROOT, "dist/cli.cjs"),
    external: ["@homebridge/node-pty-prebuilt-multiarch", "sharp", "@hurdlegroup/robotjs", "cloudflared"]
  });
  
  const stats = fs.statSync(path.join(ROOT, "dist/cli.cjs"));
  console.log(`✅ CLI → dist/cli.cjs (${(stats.size / 1024).toFixed(1)} KB)`);
}

async function buildServer() {
  console.log("\n📦 Bundling Server...");
  
  await esbuild.build({
    ...baseConfig,
    entryPoints: [path.join(ROOT, "src/server/standalone.js")],
    outfile: path.join(ROOT, "dist/server.cjs"),
    external: ["@homebridge/node-pty-prebuilt-multiarch", "sharp", "@hurdlegroup/robotjs", "next", "react", "react-dom"]
  });
  
  const stats = fs.statSync(path.join(ROOT, "dist/server.cjs"));
  console.log(`✅ Server → dist/server.cjs (${(stats.size / 1024).toFixed(1)} KB)`);
}

async function build() {
  console.log("🔨 Building npm package...\n");
  
  ensureDir(path.join(ROOT, "dist"));

  // Step 1: Build Next.js standalone
  console.log("📦 Building Next.js standalone...");
  run("BUILD_STANDALONE=true npm run build");

  // Step 2: Bundle CLI + Server
  await buildCli();
  await buildServer();

  // Step 3: Copy standalone to dist
  console.log("\n📦 Preparing package files...");
  
  const standalonePath = path.join(ROOT, ".next/standalone");
  const staticPath = path.join(ROOT, ".next/static");
  const distStandalone = path.join(ROOT, "dist/standalone");
  const distStatic = path.join(ROOT, "dist/standalone/.next/static");

  if (fs.existsSync(distStandalone)) fs.rmSync(distStandalone, { recursive: true });
  
  fs.cpSync(standalonePath, distStandalone, { recursive: true });
  fs.cpSync(staticPath, distStatic, { recursive: true });
  
  const publicPath = path.join(ROOT, "public");
  if (fs.existsSync(publicPath)) {
    fs.cpSync(publicPath, path.join(ROOT, "dist/standalone/public"), { recursive: true });
  }

  // Remove unnecessary files
  const cleanup = ["dist/standalone/node_modules/typescript", "dist/standalone/node_modules/.package-lock.json"];
  for (const p of cleanup) {
    const fullPath = path.join(ROOT, p);
    if (fs.existsSync(fullPath)) fs.rmSync(fullPath, { recursive: true });
  }

  // Step 4: Create npm pack
  console.log("\n📦 Creating npm package...");
  run("npm pack");

  console.log("\n✅ Package build complete!");
}

build().catch(err => {
  console.error("❌ Build failed:", err);
  process.exit(1);
});
