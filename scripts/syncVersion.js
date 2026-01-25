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
const cliPkgPath = path.join(ROOT, "cli/package.json");
const cliPkg = JSON.parse(fs.readFileSync(cliPkgPath, "utf-8"));

if (cliPkg.version !== rootPkg.version) {
  cliPkg.version = rootPkg.version;
  fs.writeFileSync(cliPkgPath, JSON.stringify(cliPkg, null, 2) + "\n");
  console.log(`✅ Synced version: ${rootPkg.version}`);
} else {
  console.log(`✅ Version already synced: ${rootPkg.version}`);
}
