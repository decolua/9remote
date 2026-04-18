// Capture one full-screen frame via captureAdapter and save as PNG.
// Usage: node agent/scripts/captureTest.js
// Output: .docs/benchmark/capture-test.png (plus meta.json)
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { initCapture, captureFull } from "../features/remote/adapters/captureAdapter.js";

async function main() {
  // Force node-screenshots path to avoid loading native robotjs in a standalone script
  const { REMOTE_CONFIG } = await import("../features/remote/REMOTE_CONFIG.js");
  REMOTE_CONFIG.pipeline.captureLib = "nodeScreenshots";

  await initCapture(null);
  const frame = await captureFull();

  const { buffer, width, height, channels, format } = frame;

  // Convert to standard RGBA for sharp. Input may be BGRA (robotjs) or RGBA.
  let rgba = buffer;
  if (format === "bgra" || format === "bgrx") {
    rgba = Buffer.alloc(buffer.length);
    for (let i = 0; i < buffer.length; i += 4) {
      rgba[i] = buffer[i + 2];
      rgba[i + 1] = buffer[i + 1];
      rgba[i + 2] = buffer[i];
      rgba[i + 3] = channels === 4 ? buffer[i + 3] : 255;
    }
  }

  // Always resolve relative to repo root (one level above /agent)
  const outDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../.docs/benchmark");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "capture-test.png");
  await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toFile(outFile);

  const meta = { width, height, channels, format, savedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(outDir, "capture-test.json"), JSON.stringify(meta, null, 2));
  console.log(`Saved ${outFile} (${width}x${height}, ${format})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
