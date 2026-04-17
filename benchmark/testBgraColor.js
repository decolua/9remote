// Test BGRA color handling: jpeg-turbo (no convert) vs sharp (need convert)
// Run: node testBgraColor.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import robot from "@hurdlegroup/robotjs";
import sharp from "sharp";
import jpegTurboModule from "@julusian/jpeg-turbo";

const jpegTurbo = jpegTurboModule.default || jpegTurboModule;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "output", "bgra-test");
fs.mkdirSync(OUT_DIR, { recursive: true });

// 1. Capture raw BGRA via robotjs
const { width: sw, height: sh } = robot.getScreenSize();
const bitmap = robot.screen.capture(0, 0, sw, sh);
const w = bitmap.byteWidth / bitmap.bytesPerPixel;
const h = bitmap.height;
const bgra = Buffer.from(bitmap.image);
console.log(`📸 Captured ${w}x${h} BGRA, ${(bgra.length / 1024 / 1024).toFixed(1)}MB`);

// 2. Encode WITHOUT convert (jpeg-turbo FORMAT_BGRA)
const jpg1 = jpegTurbo.compressSync(bgra, { width: w, height: h, format: jpegTurbo.FORMAT_BGRA, quality: 50 });
fs.writeFileSync(path.join(OUT_DIR, "1-turbo-bgra-NoConvert.jpg"), jpg1);

// 3. Encode WRONG: BGRA passed as RGBA to sharp (to show swap color bug)
const jpg2 = await sharp(bgra, { raw: { width: w, height: h, channels: 4 } }).jpeg({ quality: 50 }).toBuffer();
fs.writeFileSync(path.join(OUT_DIR, "2-sharp-bgra-AsRgba-WRONG.jpg"), jpg2);

// 4. Encode CORRECT: convert BGRA→RGBA then sharp
const rgba = Buffer.from(bgra);
const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.length >> 2);
for (let i = 0; i < u32.length; i++) {
  const p = u32[i];
  u32[i] = (p & 0xff00ff00) | ((p & 0x00ff0000) >> 16) | ((p & 0x000000ff) << 16);
}
const jpg3 = await sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).jpeg({ quality: 50 }).toBuffer();
fs.writeFileSync(path.join(OUT_DIR, "3-sharp-rgba-Converted-OK.jpg"), jpg3);

console.log(`\n✅ Output: ${OUT_DIR}`);
console.log(`  1-turbo-bgra-NoConvert.jpg       → should look CORRECT (jpeg-turbo handles BGRA natively)`);
console.log(`  2-sharp-bgra-AsRgba-WRONG.jpg    → should look WRONG (R↔B swapped, skin=blue, sky=red)`);
console.log(`  3-sharp-rgba-Converted-OK.jpg    → should look CORRECT (convert first)`);
