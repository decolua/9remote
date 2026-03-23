#!/usr/bin/env node

/**
 * Build npm package: CLI + Server + Daemon + UI
 */

import { execSync } from "child_process";
import * as esbuild from "esbuild";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SERVER_DIR = path.join(ROOT, "agent");
const DIST_DIR = path.join(SERVER_DIR, "dist");

// Read version from agent/package.json
const VERSION = JSON.parse(
  fs.readFileSync(path.join(SERVER_DIR, "package.json"), "utf-8")
).version;

function run(cmd, cwd = ROOT) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd });
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const baseConfig = {
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  minify: true,
  sourcemap: false,
  banner: { js: "const __importMetaUrl = require('url').pathToFileURL(__filename).href;" },
  define: {
    "import.meta.url": "__importMetaUrl",
    "__CLI_VERSION__": JSON.stringify(VERSION),
  },
};

async function buildCli() {
  console.log("\n📦 Bundling CLI...");
  const outfile = path.join(DIST_DIR, "cli.cjs");
  ensureDir(path.dirname(outfile));
  await esbuild.build({
    ...baseConfig,
    entryPoints: [path.join(SERVER_DIR, "cli/index.js")],
    outfile,
    external: ["node-pty", "sharp", "cloudflared", "@hurdlegroup/robotjs"],
  });
  console.log(`✅ CLI → agent/dist/cli.cjs (${(fs.statSync(outfile).size / 1024).toFixed(1)} KB)`);
}

async function buildServer() {
  console.log("\n📦 Bundling Server...");
  const outfile = path.join(DIST_DIR, "server.cjs");
  ensureDir(path.dirname(outfile));
  await esbuild.build({
    ...baseConfig,
    entryPoints: [path.join(SERVER_DIR, "index.js")],
    outfile,
    external: ["node-pty", "sharp", "@hurdlegroup/robotjs", "node-datachannel"],
  });
  console.log(`✅ Server → agent/dist/server.cjs (${(fs.statSync(outfile).size / 1024).toFixed(1)} KB)`);
}

async function buildDaemon() {
  console.log("\n📦 Bundling PTY Daemon...");
  const outfile = path.join(DIST_DIR, "ptyDaemon.cjs");
  ensureDir(path.dirname(outfile));
  await esbuild.build({
    ...baseConfig,
    entryPoints: [path.join(SERVER_DIR, "features/terminal/ptyDaemon.js")],
    outfile,
    external: ["node-pty"],
  });
  console.log(`✅ Daemon → agent/dist/ptyDaemon.cjs (${(fs.statSync(outfile).size / 1024).toFixed(1)} KB)`);
}

function buildUi() {
  console.log("\n🎨 Building Preact UI...");
  run("npm run build:ui", SERVER_DIR);

  // Copy agent/ui/dist/ → agent/dist/ui/
  const uiDist = path.join(SERVER_DIR, "ui/dist");
  const uiOut = path.join(DIST_DIR, "ui");
  if (fs.existsSync(uiOut)) fs.rmSync(uiOut, { recursive: true });
  fs.cpSync(uiDist, uiOut, { recursive: true });
  console.log("✅ UI → agent/dist/ui/");
}

async function build() {
  console.log("🔨 Building npm package...\n");

  if (fs.existsSync(DIST_DIR)) fs.rmSync(DIST_DIR, { recursive: true });

  buildUi();
  await buildCli();
  await buildServer();
  await buildDaemon();

  console.log("\n📦 Creating npm package...");
  run("npm pack", SERVER_DIR);

  // Move .tgz to root
  const tgzFiles = fs.readdirSync(SERVER_DIR).filter((f) => f.endsWith(".tgz"));
  for (const tgz of tgzFiles) {
    fs.renameSync(path.join(SERVER_DIR, tgz), path.join(ROOT, tgz));
    console.log(`📦 Package: ${tgz}`);
  }

  console.log("\n✅ Package build complete!");
}

build().catch((err) => {
  console.error("❌ Build failed:", err);
  process.exit(1);
});
