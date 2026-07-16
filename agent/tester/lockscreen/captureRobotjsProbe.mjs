// robotjs (GDI BitBlt) capture probe — fallback lib used when node-screenshots fails.
// Same logic as captureProbe.mjs but via robotjs. Compare: does BitBlt see the lock screen?
// Run: node agent/tester/lockscreen/captureRobotjsProbe.mjs [seconds] [intervalMs]
import { writeFileSync, appendFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createHash } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG = join(__dirname, "lockscreen-robotjs.log");
const durationMs = (Number(process.argv[2]) || 120) * 1000;
const intervalMs = Number(process.argv[3]) || 1000;
const BLACK_AVG_CEIL = 8;

try { writeFileSync(LOG, ""); } catch {}

function log(line) {
  const ts = new Date().toISOString();
  const out = `[${ts}] ${line}`;
  console.log(out);
  appendFileSync(LOG, out + "\n");
}

async function loadRobot() {
  const mod = await import("@hurdlegroup/robotjs");
  return mod.default || mod;
}

function stats(buf) {
  let sum = 0;
  const step = 4096;
  for (let i = 0; i < buf.length; i += step) sum += buf[i];
  return { avg: sum / Math.ceil(buf.length / step) };
}

const robot = await loadRobot();
robot.setKeyboardDelay(0);
const { width, height } = robot.getScreenSize();
log(`robotjs BitBlt ${width}x${height} | duration=${durationMs}ms interval=${intervalMs}ms`);
const startedAt = Date.now();
let lastHash = null;
let frozenStreak = 0;
let blackStreak = 0;
let frames = 0;

while (Date.now() - startedAt < durationMs) {
  try {
    const bmp = robot.screen.capture(0, 0, width, height);
    const buf = Buffer.from(bmp.image);
    const actualW = bmp.byteWidth / bmp.bytesPerPixel;
    const { avg } = stats(buf);
    const hash = createHash("md5").update(buf).digest("hex").slice(0, 8);
    frames++;
    const frozen = hash === lastHash;
    const black = avg < BLACK_AVG_CEIL;
    frozenStreak = frozen ? frozenStreak + 1 : 0;
    blackStreak = black ? blackStreak + 1 : 0;
    const flags = [
      `${actualW}x${bmp.height}`,
      `avg=${avg.toFixed(1)}`,
      `h=${hash}`,
      frozen ? `FROZEN×${frozenStreak}` : "live",
      black ? `BLACK×${blackStreak}` : "ok",
    ].join(" ");
    log(flags);
    lastHash = hash;
  } catch (e) {
    log(`CAPTURE ERROR: ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, intervalMs));
}
log(`done: ${frames} frames captured`);
