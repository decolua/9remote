#!/usr/bin/env node

/**
 * Prepare desktop sidecar before Tauri build:
 * 1. Copy bundled server.cjs + ptyDaemon.cjs into desktop/sidecar/
 * 2. Bundle desktop/sidecar/index.js → binary via @yao-pkg/pkg
 * 3. Rename binary to match Tauri target triple naming
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "cli/dist");
const SIDECAR_DIR = path.join(ROOT, "desktop/sidecar");
const TAURI_RESOURCES = path.join(ROOT, "desktop/src-tauri");

function run(cmd, cwd = ROOT) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd });
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Step 1: Copy server bundles into sidecar dir (sidecar/index.js auto-detects these)
console.log("\n📦 Copying server bundles to sidecar...");
ensureDir(SIDECAR_DIR);
for (const file of ["server.cjs", "ptyDaemon.cjs"]) {
  const src = path.join(DIST, file);
  const dest = path.join(SIDECAR_DIR, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`  ✅ ${file}`);
  } else {
    console.warn(`  ⚠️  ${file} not found in cli/dist — run build:pkg first`);
  }
}

// Step 2: Bundle sidecar via @yao-pkg/pkg
console.log("\n📦 Bundling sidecar binary...");
const platform = os.platform();
const arch = os.arch();

// Map to pkg target format
const pkgTargets = {
  darwin: { x64: "node18-macos-x64", arm64: "node18-macos-arm64" },
  win32:  { x64: "node18-win-x64" },
  linux:  { x64: "node18-linux-x64", arm64: "node18-linux-arm64" },
};

const pkgTarget = pkgTargets[platform]?.[arch];
if (!pkgTarget) {
  console.error(`❌ Unsupported platform: ${platform}/${arch}`);
  process.exit(1);
}

const sidecarOut = path.join(SIDECAR_DIR, "sidecar-raw");
run(`npx @yao-pkg/pkg desktop/sidecar/index.js --target ${pkgTarget} --output ${sidecarOut} --no-bytecode --public-packages "*"`, ROOT);

// Step 3: Rename to Tauri target triple format
// Tauri expects: sidecar-<target-triple>[.exe]
const tauriTriples = {
  "darwin-x64":  "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "win32-x64":   "x86_64-pc-windows-msvc",
  "linux-x64":   "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
};

const tripleKey = `${platform}-${arch}`;
const triple = tauriTriples[tripleKey];
if (!triple) {
  console.error(`❌ No Tauri triple for: ${tripleKey}`);
  process.exit(1);
}

const ext = platform === "win32" ? ".exe" : "";
const sidecarFinal = path.join(SIDECAR_DIR, `sidecar-${triple}${ext}`);

if (fs.existsSync(`${sidecarOut}${ext}`)) {
  fs.renameSync(`${sidecarOut}${ext}`, sidecarFinal);
  if (platform !== "win32") fs.chmodSync(sidecarFinal, "755");
  console.log(`\n✅ Sidecar binary: ${path.relative(ROOT, sidecarFinal)}`);
} else {
  console.error(`❌ pkg output not found: ${sidecarOut}${ext}`);
  process.exit(1);
}

// Step 4: Update tauri.conf.json to include externalBin
const tauriConf = path.join(TAURI_RESOURCES, "tauri.conf.json");
const conf = JSON.parse(fs.readFileSync(tauriConf, "utf-8"));
conf.bundle = conf.bundle || {};
conf.bundle.externalBin = ["../sidecar/sidecar"];
fs.writeFileSync(tauriConf, JSON.stringify(conf, null, 2));
console.log("✅ tauri.conf.json updated with externalBin");

console.log("\n✅ Desktop build prep complete!");
