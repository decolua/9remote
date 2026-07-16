// Probe whether keyboard/mouse SendInput reaches the lock screen.
// Strategy: type into the system (open Notepad via Win+R-style sequence is flaky,
// so we just measure if SendInput is accepted at all by the OS — no exception thrown
// and the OS reports the event queue).
//
// Better strategy used here: write a marker by moving the mouse to a known position
// (mouseMove + a getMousePos roundtrip). robotjs getMousePos works on the interactive
// desktop; if the lock screen ignores mouseMove, the position won't actually move the
// lock UI but the call still succeeds — so the probe's real value is testing typeString
// into the lock password field (pair with blindUnlock.mjs).
//
// This script: every 2s, report robot.getMousePos() and whether keyTap("scrolllock")
// toggles Scroll Lock LED — the LED change is a hardware-level confirmation SendInput
// is being delivered, EVEN on the lock screen. Compare LED before/after.
//
// Run: node agent/tester/lockscreen/sendInputProbe.mjs
import { writeFileSync, appendFileSync } from "fs";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG = join(__dirname, "sendInputProbe.log");
try { writeFileSync(LOG, ""); } catch {}
function log(line) {
  const ts = new Date().toISOString();
  const out = `[${ts}] ${line}`;
  console.log(out);
  appendFileSync(LOG, out + "\n");
}

// Read Scroll Lock LED state on Windows via PowerShell + GetKeyboardState API.
function scrollLockOn() {
  try {
    const ps = `
$code='using System;using System.Runtime.InteropServices;public class KB{[DllImport("user32.dll")]public static extern short GetKeyState(int n);}';
Add-Type -TypeDefinition $code;
$vk=0x91; $s=[KB]::GetKeyState($vk); [bool]($s -band 1)`;
    const out = execFileSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" }).trim();
    return out === "True";
  } catch {
    return null;
  }
}

const mod = await import("@hurdlegroup/robotjs");
const robot = mod.default || mod;
robot.setKeyboardDelay(0);

log("SendInput probe: toggling Scroll Lock every 4s. Watch the keyboard LED + this log.");
log("Lock the machine (Win+L). If the LED keeps toggling while locked, SendInput reaches Winlogon.");
for (let i = 0; i < 30; i++) {
  const before = scrollLockOn();
  try { robot.keyTap("scrolllock"); } catch (e) { log(`keyTap error: ${e.message}`); }
  await new Promise((r) => setTimeout(r, 200));
  const after = scrollLockOn();
  log(`iter ${i + 1}/30  mouse=(${robot.getMousePos().x},${robot.getMousePos().y})  scrollLock ${before ?? "?"}→${after ?? "?"}`);
  await new Promise((r) => setTimeout(r, 3800));
}
log("done");
