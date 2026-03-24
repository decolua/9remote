#!/usr/bin/env node

/**
 * Generate desktop app icons from SVG
 */

import sharp from "sharp";
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SVG_SOURCE = join(ROOT, "web/public/icon-192.svg");
const ICONS_DIR = join(ROOT, "desktop/src-tauri/icons");

const sizes = [
  { size: 32, name: "32x32.png" },
  { size: 128, name: "128x128.png" },
  { size: 256, name: "128x128@2x.png" },
  { size: 512, name: "icon.png" },
];

async function generateIcons() {
  console.log("📦 Generating desktop icons from SVG...");
  
  const svgBuffer = readFileSync(SVG_SOURCE);
  
  for (const { size, name } of sizes) {
    const outputPath = join(ICONS_DIR, name);
    await sharp(svgBuffer)
      .resize(size, size)
      .png()
      .toFile(outputPath);
    console.log(`✅ Generated ${name} (${size}x${size})`);
  }
  
  console.log("\n✅ All icons generated!");
  console.log("Note: .icns and .ico files need to be generated manually:");
  console.log("  macOS: Use Icon Composer or iconutil");
  console.log("  Windows: Use ImageMagick or online converter");
}

generateIcons().catch((err) => {
  console.error("❌ Failed to generate icons:", err);
  process.exit(1);
});
