#!/usr/bin/env node

/**
 * Sync version from root package.json to host + desktop manifests
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
const { version } = rootPkg;

// JSON manifests carrying a top-level "version"
const JSON_TARGETS = [
  "host/package.json",
  "desktop/package.json",
  "desktop/src-tauri/tauri.conf.json",
];

const updated = [];

for (const rel of JSON_TARGETS) {
  const file = path.join(ROOT, rel);
  const pkg = JSON.parse(fs.readFileSync(file, "utf-8"));
  if (pkg.version === version) continue;
  pkg.version = version;
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
  updated.push(rel);
}

// Cargo.toml: only the [package] version, never a dependency's
const cargoRel = "desktop/src-tauri/Cargo.toml";
const cargoFile = path.join(ROOT, cargoRel);
const cargo = fs.readFileSync(cargoFile, "utf-8");
const patched = cargo.replace(
  /(\[package\][\s\S]*?\nversion = ")[^"]+(")/,
  `$1${version}$2`
);
if (patched !== cargo) {
  fs.writeFileSync(cargoFile, patched);
  updated.push(cargoRel);
}

console.log(
  updated.length
    ? `✅ Synced version ${version}: ${updated.join(", ")}`
    : `✅ Version already synced: ${version}`
);
