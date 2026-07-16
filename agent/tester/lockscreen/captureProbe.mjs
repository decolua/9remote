// DXGI (node-screenshots) capture probe — same lib the agent uses on Windows.
// Captures every interval, detects BLACK frames (avg luminance) and FROZEN frames (hash).
// Run: node agent/tester/lockscreen/captureProbe.mjs [seconds] [intervalMs]
//   default: 120s, 1000ms. Then lock the machine (Win+L) mid-run and watch the log.
// Reads: agent deps (cd agent && npm install). Writes lockscreen-capture.log next to this file.
import { writeFileSync, appendFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createHash } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG = join(__dirname, "lockscreen-capture.log");
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

async function loadNs() {
  const ns = await import("node-screenshots");
  const Monitor = ns.Monitor || ns.default?.Monitor;
  const m = Monitor.all()[0];
  if (!m) throw new Error("No monitor via node-screenshots");
  return m;
}

function stats(buf) {
  let sum = 0;
  const step = 4096; // sample — full scan is slow on big buffers
  for (let i = 0; i < buf.length; i += step) sum += buf[i];
  const avg = sum / Math.ceil(buf.length / step);
  return { avg };
}

const m = await loadNs();
log(`DXGI monitor ${m.width}x${m.height} | duration=${durationMs}ms interval=${intervalMs}ms`);
const startedAt = Date.now();
let lastHash = null;
let frozenStreak = 0;
let blackStreak = 0;
let frames = 0;

while (Date.now() - startedAt < durationMs) {
  try {
    const img = await m.captureImage();
    const raw = await img.toRaw();
    const { avg } = stats(raw);
    const hash = createHash("md5").update(raw).digest("hex").slice(0, 8);
    frames++;
    const frozen = hash === lastHash;
    const black = avg < BLACK_AVG_CEIL;
    frozenStreak = frozen ? frozenStreak + 1 : 0;
    blackStreak = black ? blackStreak + 1 : 0;
    const flags = [
      `${img.width}x${img.height}`,
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
