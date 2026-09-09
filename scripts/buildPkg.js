#!/usr/bin/env node

/**
 * Build npm package: CLI + Server + Daemon + UI
 */

import { execSync } from "child_process";
import * as esbuild from "esbuild";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildWebStatic } from "./buildWebStatic.mjs";
// import JavaScriptObfuscator from "javascript-obfuscator";
// import { nodePreset } from "./obfuscatorConfig.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SERVER_DIR = path.join(ROOT, "agent");
const DIST_DIR = path.join(SERVER_DIR, "dist");

// Read version from agent/package.json
const VERSION = JSON.parse(
  fs.readFileSync(path.join(SERVER_DIR, "package.json"), "utf-8")
).version;

// Package name override for beta/test builds (NREMOTE_PKG=9remote-beta)
const PKG_NAME = process.env.NREMOTE_PKG || "9remote";

function run(cmd, cwd = ROOT) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd });
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Disabled: obfuscation triggers Defender false positive (Trojan:JS/NpmSteal)
// function obfuscateFile(file) {
//   const code = fs.readFileSync(file, "utf-8");
//   const result = JavaScriptObfuscator.obfuscate(code, nodePreset).getObfuscatedCode();
//   fs.writeFileSync(file, result);
//   console.log(`🔒 Obfuscated → ${path.relative(ROOT, file)} (${(fs.statSync(file).size / 1024).toFixed(1)} KB)`);
// }

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
    "__PKG_NAME__": JSON.stringify(PKG_NAME),
    "__DEFAULT_WORKER_URL__": JSON.stringify(process.env.NREMOTE_WORKER_URL || "https://9remote.cc"),
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
    external: ["node-pty", "sharp", "cloudflared", "@hurdlegroup/robotjs", "node-datachannel", "node-screenshots", "koffi", "systray", "fsevents", "@julusian/jpeg-turbo"],
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
    external: ["node-pty", "sharp", "@hurdlegroup/robotjs", "node-datachannel", "node-screenshots", "koffi", "fsevents", "@julusian/jpeg-turbo"],
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

async function buildInstall() {
  console.log("\n📦 Bundling postinstall...");
  const outfile = path.join(DIST_DIR, "install.cjs");
  ensureDir(path.dirname(outfile));
  await esbuild.build({
    ...baseConfig,
    entryPoints: [path.join(SERVER_DIR, "cli/scripts/install.js")],
    outfile,
    external: ["@hurdlegroup/robotjs"],
  });
  console.log(`✅ Install → agent/dist/install.cjs (${(fs.statSync(outfile).size / 1024).toFixed(1)} KB)`);
}

function buildUi() {
  console.log("\n🎨 Building Preact UI...");
  // vite outDir is "../dist/ui" (relative to agent/ui/) → outputs directly to agent/dist/ui/
  run("npm run build:ui", SERVER_DIR);
  console.log("✅ UI → agent/dist/ui/");
}

function buildWeb() {
  console.log("\n🌐 Building Web static export...");
  const outDir = buildWebStatic();
  const destDir = path.join(DIST_DIR, "web");
  if (!fs.existsSync(outDir)) {
    throw new Error(`Web static export output directory not found: ${outDir}`);
  }
  ensureDir(destDir);
  fs.cpSync(outDir, destDir, { recursive: true });
  console.log("✅ Web → agent/dist/web/");
}

function copyAssets() {
  console.log("\n🖼️  Copying assets...");
  const srcDir = path.join(SERVER_DIR, "cli/utils/assets");
  const destDir = path.join(DIST_DIR, "assets");
  if (!fs.existsSync(srcDir)) return;
  ensureDir(destDir);
  for (const file of fs.readdirSync(srcDir)) {
    fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
  }
  console.log(`✅ Assets → agent/dist/assets/`);
}

// Ship C# sources for the Windows desktop-unlock bridge. .exe are compiled at
// runtime into ~/.9remote/bin/ (PATHS.BIN) so they survive autoupdate.
function copyDesktopBridge() {
  console.log("\n🖥️  Copying desktop-bridge sources...");
  const srcDir = path.join(SERVER_DIR, "lib/bin");
  const destDir = path.join(DIST_DIR, "bin");
  if (!fs.existsSync(srcDir)) return;
  ensureDir(destDir);
  for (const file of fs.readdirSync(srcDir)) {
    if (!file.endsWith(".cs")) continue;
    fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
  }
  console.log(`✅ desktop-bridge .cs → agent/dist/bin/`);
}

// Ship the scrcpy server jar for Android mirroring: dev layout
// agent/features/mobile/vendor/, dist agent/dist/vendor/.
function copyMobileVendor() {
  console.log("\n📱 Copying scrcpy server...");
  const srcDir = path.join(SERVER_DIR, "features/mobile/vendor");
  const destDir = path.join(DIST_DIR, "vendor");
  if (!fs.existsSync(srcDir)) return;
  ensureDir(destDir);
  for (const file of fs.readdirSync(srcDir)) {
    fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
  }
  console.log(`✅ scrcpy-server → agent/dist/vendor/`);
}

async function build() {
  console.log("🔨 Building npm package...\n");

  if (fs.existsSync(DIST_DIR)) fs.rmSync(DIST_DIR, { recursive: true });

  buildUi();
  buildWeb();
  await buildCli();
  await buildServer();
  await buildDaemon();
  await buildInstall();
  copyAssets();
  copyDesktopBridge();
  copyMobileVendor();

  // Disabled: obfuscation triggers Defender false positive (Trojan:JS/NpmSteal)
  // console.log("\n🔒 Obfuscating bundles...");
  // obfuscateFile(path.join(DIST_DIR, "cli.cjs"));
  // obfuscateFile(path.join(DIST_DIR, "server.cjs"));
  // obfuscateFile(path.join(DIST_DIR, "ptyDaemon.cjs"));
  // obfuscateFile(path.join(DIST_DIR, "install.cjs"));

  if (!process.env.NO_PACK) {
    console.log("\n📦 Creating npm package...");
    // Temporarily rewrite name + bin for beta/test builds, restore after pack
    const pkgPath = path.join(SERVER_DIR, "package.json");
    const pkgRaw = fs.readFileSync(pkgPath, "utf-8");
    if (PKG_NAME !== "9remote") {
      const pkg = JSON.parse(pkgRaw);
      pkg.name = PKG_NAME;
      pkg.bin = { [PKG_NAME]: "./dist/cli.cjs" };
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
      console.log(`📛 Package name → ${PKG_NAME}`);
    }
    try {
      run("npm pack", SERVER_DIR);
    } finally {
      if (PKG_NAME !== "9remote") fs.writeFileSync(pkgPath, pkgRaw);
    }

    // Move .tgz to root
    const tgzFiles = fs.readdirSync(SERVER_DIR).filter((f) => f.endsWith(".tgz"));
    for (const tgz of tgzFiles) {
      fs.renameSync(path.join(SERVER_DIR, tgz), path.join(ROOT, tgz));
      console.log(`📦 Package: ${tgz}`);
    }
  }

  console.log("\n✅ Package build complete!");
}

build().catch((err) => {
  console.error("❌ Build failed:", err);
  process.exit(1);
});
