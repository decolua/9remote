#!/usr/bin/env node

/**
 * Sync version from root package.json to cli/package.json
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
const serverPkgPath = path.join(ROOT, "agent/package.json");
const serverPkg = JSON.parse(fs.readFileSync(serverPkgPath, "utf-8"));

if (serverPkg.version !== rootPkg.version) {
  serverPkg.version = rootPkg.version;
  fs.writeFileSync(serverPkgPath, JSON.stringify(serverPkg, null, 2) + "\n");
  console.log(`✅ Synced version: ${rootPkg.version}`);
} else {
  console.log(`✅ Version already synced: ${rootPkg.version}`);
}
