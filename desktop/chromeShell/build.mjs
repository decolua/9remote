#!/usr/bin/env node
// Builds a macOS .app that opens the web app in a Chromium browser's --app window.
// WKWebView (what Tauri uses on macOS) drops keystrokes from Vietnamese input
// methods, so the shell borrows the browser the user already has instead.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, chmodSync, copyFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(join(root, "config.json"), "utf8")));
const version = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(resolve(root, "../../package.json"), "utf8"))).version;

const outDir = resolve(root, "../release/macos");
const appDir = join(outDir, `${cfg.appName}.app`);
const macOsDir = join(appDir, "Contents/MacOS");
const resDir = join(appDir, "Contents/Resources");
const iconSrc = resolve(root, "../src-tauri/icons/icon.icns");

rmSync(appDir, { recursive: true, force: true });
mkdirSync(macOsDir, { recursive: true });
mkdirSync(resDir, { recursive: true });

const launcher = `#!/bin/bash
# Launch the web app in the first Chromium-family browser found.
set -euo pipefail

URL="\${NINEREMOTE_WEB_URL:-${cfg.url}}"
PROFILE="$HOME/Library/Application Support/${cfg.profileDir}"

BROWSERS=(
${cfg.browsers.map((b) => `  "${b}"`).join("\n")}
)

for b in "\${BROWSERS[@]}"; do
  if [ -x "$b" ]; then
    exec "$b" --app="$URL" --user-data-dir="$PROFILE" --window-size=${cfg.windowSize} --class="${cfg.appName}"
  fi
done

osascript -e 'display alert "${cfg.appName}" message "Install Google Chrome, Edge, Brave, or Chromium to run this app." as critical'
exit 1
`;

const binName = "launcher";
writeFileSync(join(macOsDir, binName), launcher);
chmodSync(join(macOsDir, binName), 0o755);

if (existsSync(iconSrc)) copyFileSync(iconSrc, join(resDir, "icon.icns"));

writeFileSync(join(appDir, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${cfg.appName}</string>
  <key>CFBundleDisplayName</key><string>${cfg.appName}</string>
  <key>CFBundleIdentifier</key><string>${cfg.bundleId}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleExecutable</key><string>${binName}</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>10.15</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`);

// Ad-hoc signature: no Apple ID needed, but enough that Gatekeeper stops
// warning on every launch from a mounted dmg
execFileSync("codesign", ["--force", "--deep", "--sign", "-", appDir]);
execFileSync("touch", [appDir]);
console.log(`[ChromeShell] ${appDir}`);

// Package as a dmg so it installs like the other builds
const stage = execFileSync("mktemp", ["-d"]).toString().trim();
execFileSync("cp", ["-R", appDir, stage]);
execFileSync("ln", ["-s", "/Applications", join(stage, "Applications")]);
const dmg = join(outDir, `${cfg.appName}_${version}_chrome.dmg`);
execFileSync("hdiutil", ["create", "-volname", cfg.appName, "-srcfolder", stage, "-ov", "-format", "UDZO", dmg], { stdio: "inherit" });
rmSync(stage, { recursive: true, force: true });
console.log(`[ChromeShell] ${dmg}`);
