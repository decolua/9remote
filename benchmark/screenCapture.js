/**
 * Universal benchmark launcher
 * Auto-detects OS and runs appropriate script:
 *   - Windows → screenCapture.win.js (DXGI, no robotjs)
 *   - macOS/Linux → screenCapture.mac.js (uses robotjs)
 */
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const script = process.platform === "win32" ? "screenCapture.win.js" : "screenCapture.mac.js";
const scriptPath = path.join(__dirname, script);

console.log(`\n🔍 Detected OS: ${process.platform} ${process.arch}`);
console.log(`▶️  Running: ${script}\n`);

const child = spawn(process.execPath, [scriptPath], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code || 0));
