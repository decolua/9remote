/**
 * RobotJS Screen Capture Test Script
 * Run: node test.js
 */

const robot = require("@hurdlegroup/robotjs");
const fs = require("fs");

console.log("=".repeat(60));
console.log("ROBOTJS SCREEN CAPTURE TEST");
console.log("=".repeat(60));

// System info
console.log("\n[SYSTEM INFO]");
console.log("Platform:", process.platform);
console.log("Arch:", process.arch);
console.log("Node version:", process.version);

// Screen size
console.log("\n[SCREEN SIZE]");
const screenSize = robot.getScreenSize();
console.log("getScreenSize():", screenSize);
console.log("  width:", screenSize.width);
console.log("  height:", screenSize.height);

// Test capture 1x1
console.log("\n[TEST CAPTURE 1x1]");
try {
  const test1x1 = robot.screen.capture(0, 0, 1, 1);
  console.log("capture(0, 0, 1, 1):");
  console.log("  width:", test1x1.width);
  console.log("  height:", test1x1.height);
  console.log("  byteWidth:", test1x1.byteWidth);
  console.log("  bytesPerPixel:", test1x1.bytesPerPixel);
  console.log("  image.length:", test1x1.image.length);
  console.log("  Calculated scale factor:", test1x1.byteWidth / test1x1.bytesPerPixel);
} catch (e) {
  console.log("ERROR:", e.message);
}

// Test capture 100x100
console.log("\n[TEST CAPTURE 100x100]");
try {
  const test100 = robot.screen.capture(0, 0, 100, 100);
  console.log("capture(0, 0, 100, 100):");
  console.log("  width:", test100.width);
  console.log("  height:", test100.height);
  console.log("  byteWidth:", test100.byteWidth);
  console.log("  bytesPerPixel:", test100.bytesPerPixel);
  console.log("  image.length:", test100.image.length);
  console.log("  Expected image.length (100x100x4):", 100 * 100 * 4);
} catch (e) {
  console.log("ERROR:", e.message);
}

// Test capture full screen with logical size
console.log("\n[TEST CAPTURE FULL SCREEN - LOGICAL SIZE]");
try {
  const fullLogical = robot.screen.capture(0, 0, screenSize.width, screenSize.height);
  console.log(`capture(0, 0, ${screenSize.width}, ${screenSize.height}):`);
  console.log("  width:", fullLogical.width);
  console.log("  height:", fullLogical.height);
  console.log("  byteWidth:", fullLogical.byteWidth);
  console.log("  bytesPerPixel:", fullLogical.bytesPerPixel);
  console.log("  image.length:", fullLogical.image.length);
  console.log("  Expected (w*h*4):", screenSize.width * screenSize.height * 4);
  console.log("  Actual pixels:", fullLogical.byteWidth / fullLogical.bytesPerPixel, "x", fullLogical.height);
} catch (e) {
  console.log("ERROR:", e.message);
}

// Test capture with different sizes
console.log("\n[TEST CAPTURE VARIOUS SIZES]");
const testSizes = [
  [screenSize.width / 2, screenSize.height / 2],
  [screenSize.width * 1.5, screenSize.height * 1.5],
  [screenSize.width * 2, screenSize.height * 2],
];

for (const [w, h] of testSizes) {
  try {
    const testCapture = robot.screen.capture(0, 0, Math.floor(w), Math.floor(h));
    console.log(`capture(0, 0, ${Math.floor(w)}, ${Math.floor(h)}):`);
    console.log(`  Result: ${testCapture.byteWidth / testCapture.bytesPerPixel}x${testCapture.height}`);
    console.log(`  image.length: ${testCapture.image.length}`);
  } catch (e) {
    console.log(`capture(0, 0, ${Math.floor(w)}, ${Math.floor(h)}): ERROR - ${e.message}`);
  }
}

// Check Windows DPI
if (process.platform === "win32") {
  console.log("\n[WINDOWS DPI CHECK]");
  console.log("Note: Windows may have DPI scaling enabled (100%, 125%, 150%, etc)");
  console.log("Check: Settings -> Display -> Scale and layout");
  
  // Try to detect actual screen resolution vs logical
  const actualPixels = robot.screen.capture(0, 0, screenSize.width, screenSize.height);
  const actualWidth = actualPixels.byteWidth / actualPixels.bytesPerPixel;
  const actualHeight = actualPixels.height;
  
  console.log("\nLogical size (getScreenSize):", screenSize.width, "x", screenSize.height);
  console.log("Actual captured pixels:", actualWidth, "x", actualHeight);
  
  if (actualWidth === screenSize.width && actualHeight === screenSize.height) {
    console.log("=> DPI scaling NOT applied to capture (1:1)");
  } else {
    const scaleX = actualWidth / screenSize.width;
    const scaleY = actualHeight / screenSize.height;
    console.log("=> DPI scale detected: X=" + scaleX + ", Y=" + scaleY);
  }
}

// Save test image
console.log("\n[SAVE TEST IMAGE]");
try {
  const capture = robot.screen.capture(0, 0, screenSize.width, screenSize.height);
  const width = capture.byteWidth / capture.bytesPerPixel;
  const height = capture.height;
  
  // Create simple PPM image (raw format, no dependencies needed)
  const ppmHeader = `P6\n${width} ${height}\n255\n`;
  const rgbData = Buffer.alloc(width * height * 3);
  
  // Convert BGRA to RGB
  for (let i = 0, j = 0; i < capture.image.length; i += 4, j += 3) {
    rgbData[j] = capture.image[i + 2];     // R
    rgbData[j + 1] = capture.image[i + 1]; // G
    rgbData[j + 2] = capture.image[i];     // B
  }
  
  fs.writeFileSync("screenshot.ppm", Buffer.concat([Buffer.from(ppmHeader), rgbData]));
  console.log("Saved: screenshot.ppm");
  console.log("  Size:", width, "x", height);
  console.log("  File size:", fs.statSync("screenshot.ppm").size, "bytes");
  console.log("\nTo view PPM on Windows: Open with IrfanView, GIMP, or online PPM viewer");
} catch (e) {
  console.log("ERROR saving image:", e.message);
}

console.log("\n" + "=".repeat(60));
console.log("TEST COMPLETE");
console.log("=".repeat(60));
