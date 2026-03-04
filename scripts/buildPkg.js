#!/usr/bin/env node

/**
 * Build npm package: CLI bundle + Server bundle (lightweight - no Next.js)
 */

import { execSync } from "child_process";
import * as esbuild from "esbuild";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// Read version from cli/package.json
const cliPackageJson = JSON.parse(
  fs.readFileSync(path.join(ROOT, "cli/package.json"), "utf-8")
);
const VERSION = cliPackageJson.version;

function run(cmd, cwd = ROOT) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd });
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
    "import.meta.url": "__importMetaUrl",
    "__CLI_VERSION__": JSON.stringify(VERSION)
  }
};

async function buildCli() {
  console.log("\n📦 Bundling CLI...");
  
  const outfile = path.join(ROOT, "cli/dist/cli.cjs");
  ensureDir(path.dirname(outfile));
  
  await esbuild.build({
    ...baseConfig,
    entryPoints: [path.join(ROOT, "cli/index.js")],
    outfile,
    external: ["node-pty", "sharp", "cloudflared", "@hurdlegroup/robotjs"]
  });
  
  const stats = fs.statSync(outfile);
  console.log(`✅ CLI → cli/dist/cli.cjs (${(stats.size / 1024).toFixed(1)} KB)`);
}

async function buildServer() {
  console.log("\n📦 Bundling Server...");
  
  const outfile = path.join(ROOT, "cli/dist/server.cjs");
  ensureDir(path.dirname(outfile));
  
  await esbuild.build({
    ...baseConfig,
    entryPoints: [path.join(ROOT, "server/index.js")],
    outfile,
    external: ["node-pty", "sharp", "@hurdlegroup/robotjs", "node-datachannel"]
  });
  
  const stats = fs.statSync(outfile);
  console.log(`✅ Server → cli/dist/server.cjs (${(stats.size / 1024).toFixed(1)} KB)`);
}

async function buildDaemon() {
  console.log("\n📦 Bundling PTY Daemon...");
  
  const outfile = path.join(ROOT, "cli/dist/ptyDaemon.cjs");
  ensureDir(path.dirname(outfile));
  
  await esbuild.build({
    ...baseConfig,
    entryPoints: [path.join(ROOT, "server/features/terminal/ptyDaemon.js")],
    outfile,
    external: ["node-pty"]
  });
  
  const stats = fs.statSync(outfile);
  console.log(`✅ Daemon → cli/dist/ptyDaemon.cjs (${(stats.size / 1024).toFixed(1)} KB)`);
}

async function build() {
  console.log("🔨 Building npm package (lightweight - no Next.js)...\n");

  // Clean old dist
  const distDir = path.join(ROOT, "cli/dist");
  if (fs.existsSync(distDir)) {
    fs.rmSync(distDir, { recursive: true });
  }

  // Bundle CLI + Server + Daemon into cli/dist/
  await buildCli();
  await buildServer();
  await buildDaemon();

  // Create npm pack from cli/
  console.log("\n📦 Creating npm package...");
  run("npm pack", path.join(ROOT, "cli"));

  // Move .tgz to root
  const tgzFiles = fs.readdirSync(path.join(ROOT, "cli")).filter(f => f.endsWith(".tgz"));
  for (const tgz of tgzFiles) {
    fs.renameSync(path.join(ROOT, "cli", tgz), path.join(ROOT, tgz));
    console.log(`📦 Package: ${tgz}`);
  }

  console.log("\n✅ Package build complete!");
}

build().catch(err => {
  console.error("❌ Build failed:", err);
  process.exit(1);
});
