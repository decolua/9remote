#!/usr/bin/env node
// Merge per-platform updater artifacts into release/latest.json for tauri-plugin-updater.
// Keeps platforms already in latest.json whose artifacts are missing on this machine
// (e.g. Linux built in Docker, Windows cross-compiled — never all on one host).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, basename } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const version = JSON.parse(
  readFileSync(resolve(root, "src-tauri/tauri.conf.json"), "utf8"),
).version;
const outPath = resolve(root, "release/latest.json");
const releaseUrl = (asset) =>
  `https://github.com/decolua/9remote/releases/download/v${version}/${asset}`;

// platform key → candidate artifact paths (first match wins), release asset name
const PLATFORMS = {
  "darwin-aarch64": {
    paths: ["src-tauri/target/universal-apple-darwin/release/bundle/macos/9Remote.app.tar.gz"],
    asset: "9Remote.app.tar.gz",
  },
  "darwin-x86_64": {
    paths: ["src-tauri/target/universal-apple-darwin/release/bundle/macos/9Remote.app.tar.gz"],
    asset: "9Remote.app.tar.gz",
  },
  "windows-x86_64": {
    paths: [`src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/9Remote_${version}_x64-setup.exe`],
    asset: "9Remote-windows-x64-setup.exe",
  },
  "linux-aarch64": {
    paths: [
      `src-tauri/target-linux/native/appimage/9Remote_${version}_aarch64.AppImage`,
      `src-tauri/target-linux/native/bundle/appimage/9Remote_${version}_aarch64.AppImage`,
    ],
  },
  "linux-x86_64": {
    paths: [
      `src-tauri/target-linux/amd64/deb/9Remote_${version}_amd64.deb`,
      `src-tauri/target-linux/amd64/bundle/deb/9Remote_${version}_amd64.deb`,
    ],
  },
};

let existing = {};
try {
  existing = JSON.parse(readFileSync(outPath, "utf8")).platforms ?? {};
} catch {
  // first run — start fresh
}

const platforms = { ...existing };
const report = [];
for (const [key, { paths, asset }] of Object.entries(PLATFORMS)) {
  const file = paths.map((p) => resolve(root, p)).find((p) => {
    try {
      return readFileSync(p).length > 0;
    } catch {
      return false;
    }
  });
  if (!file) {
    report.push(`  skip  ${key} (artifact not found)`);
    continue;
  }
  let signature;
  try {
    signature = readFileSync(`${file}.sig`, "utf8").trim(); // .sig is already base64
  } catch {
    report.push(`  skip  ${key} (unsigned build — no .sig; build with TAURI_SIGNING_PRIVATE_KEY)`);
    continue;
  }
  platforms[key] = { signature, url: releaseUrl(asset ?? basename(file)) };
  report.push(`  ok    ${key} → ${asset ?? basename(file)}`);
}

writeFileSync(
  outPath,
  `${JSON.stringify({ version, pub_date: new Date().toISOString(), platforms }, null, 2)}\n`,
);
console.log(`[Desktop] latest.json v${version}:`);
console.log(report.join("\n"));
