#!/usr/bin/env node

/**
 * Build web app as static HTML/CSS/JS export for embedding into agent.
 * Temporarily moves app/api out of the way so Next.js static export succeeds without Cloudflare worker routes.
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const WEB_DIR = path.join(ROOT, "web");
const API_DIR = path.join(WEB_DIR, "app", "api");
const API_BACKUP_DIR = path.join(WEB_DIR, ".api_export_backup");
const OUT_DIR = path.join(WEB_DIR, "out");

export function buildWebStatic() {
  console.log("🌐 Building web static bundle...");
  let movedApi = false;

  // Auto-heal if a prior process was interrupted
  if (fs.existsSync(API_BACKUP_DIR) && !fs.existsSync(API_DIR)) {
    fs.renameSync(API_BACKUP_DIR, API_DIR);
  }

  try {
    if (fs.existsSync(API_DIR)) {
      if (fs.existsSync(API_BACKUP_DIR)) {
        fs.rmSync(API_BACKUP_DIR, { recursive: true, force: true });
      }
      fs.renameSync(API_DIR, API_BACKUP_DIR);
      movedApi = true;
    }

    if (fs.existsSync(OUT_DIR)) {
      fs.rmSync(OUT_DIR, { recursive: true, force: true });
    }

    execSync("STATIC_EXPORT=1 npx next build --webpack", {
      cwd: WEB_DIR,
      stdio: "inherit",
      env: {
        ...process.env,
        STATIC_EXPORT: "1",
        NODE_ENV: "production",
      },
    });

    console.log(`✅ Web static export complete: ${OUT_DIR}`);
    return OUT_DIR;
  } finally {
    if (movedApi && fs.existsSync(API_BACKUP_DIR)) {
      if (fs.existsSync(API_DIR)) {
        fs.rmSync(API_DIR, { recursive: true, force: true });
      }
      fs.renameSync(API_BACKUP_DIR, API_DIR);
    }
  }
}

// Allow direct execution: node scripts/buildWebStatic.mjs
const isDirect = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirect) {
  buildWebStatic();
}
