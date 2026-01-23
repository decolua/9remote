#!/usr/bin/env node

/**
 * Build CLI bundle using esbuild
 */

import * as esbuild from "esbuild";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

async function build() {
  console.log("🔨 Building CLI bundle...");

  // Ensure dist directory exists
  const distDir = path.join(ROOT, "dist");
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  try {
    await esbuild.build({
      entryPoints: [path.join(ROOT, "cli/index.js")],
      bundle: true,
      platform: "node",
      target: "node18",
      outfile: path.join(ROOT, "dist/cli.cjs"),
      format: "cjs",
      minify: true,
      sourcemap: false,
      banner: {
        js: "const __importMetaUrl = require('url').pathToFileURL(__filename).href;"
      },
      define: {
        "import.meta.url": "__importMetaUrl"
      },
      external: [
        // Native modules - cannot be bundled
        "node-pty-prebuilt-multiarch",
        "sharp",
        "@hurdlegroup/robotjs",
        // Cloudflared needs binary access
        "cloudflared"
      ]
    });

    console.log("✅ CLI bundled → dist/cli.cjs");

    // Show bundle size
    const stats = fs.statSync(path.join(ROOT, "dist/cli.cjs"));
    console.log(`📦 Size: ${(stats.size / 1024).toFixed(1)} KB`);

  } catch (error) {
    console.error("❌ Build failed:", error);
    process.exit(1);
  }
}

build();
