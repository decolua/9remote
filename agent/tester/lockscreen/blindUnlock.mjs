// Blind unlock via robotjs SendInput. Types password + Enter after a countdown.
// Tests whether keyboard SendInput reaches the Winlogon lock screen (it usually does
// on the interactive session — that's the one Win+L locks).
// SECURITY: password is passed via argv and may appear in shell history / process list.
//   Prefer LOCKPW env var. Clear screen after typing.
// Run:
//   $env:LOCKPW="yourpass"; node agent/tester/lockscreen/blindUnlock.mjs [countdownSec]
//   or:  node agent/tester/lockscreen/blindUnlock.mjs [countdownSec] "yourpass"
import { writeFileSync, appendFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG = join(__dirname, "blindUnlock.log");
const pw = process.env.LOCKPW ?? process.argv[3];
const countdown = Number(process.argv[2]) || 5;

try { writeFileSync(LOG, ""); } catch {}
function log(line) {
  const ts = new Date().toISOString();
  const out = `[${ts}] ${line}`;
  console.log(out);
  appendFileSync(LOG, out + "\n");
}

if (!pw) {
  console.error("Missing password. Set LOCKPW env var or pass as 2nd argv.");
  process.exit(1);
}

const mod = await import("@hurdlegroup/robotjs");
const robot = mod.default || mod;
robot.setKeyboardDelay(10);

log(`blind unlock armed | countdown=${countdown}s | pwLen=${pw.length}`);
for (let i = countdown; i > 0; i--) {
  log(`  typing in ${i}s — lock the machine NOW (Win+L)`);
  await new Promise((r) => setTimeout(r, 1000));
}

try {
  // Windows lock screen: password field is auto-focused after boot/reboot/Win+L.
  // Escape first to dismiss any lock-screen wallpaper panel, then type + Enter.
  robot.keyTap("escape");
  await new Promise((r) => setTimeout(r, 300));
  robot.typeString(pw);
  await new Promise((r) => setTimeout(r, 200));
  robot.keyTap("enter");
  log("typed password + Enter — check machine state");
} catch (e) {
  log(`ERROR: ${e.message}`);
}
