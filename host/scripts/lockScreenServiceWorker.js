// Tier 3: Worker that runs as Windows Service (LocalSystem).
// Switches to Winlogon desktop via koffi when machine is locked, captures
// the secure desktop and writes PNGs to PROGRAMDATA folder for inspection.
//
// Spawned by lockScreenServiceInstall.js — DO NOT run directly as a user.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const OUT_DIR = path.join(process.env.PROGRAMDATA || "C:\\ProgramData", "9remote-locktest");
fs.mkdirSync(OUT_DIR, { recursive: true });

const LOG_FILE = path.join(OUT_DIR, "service.log");
function flog(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(" ")}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch { /* ignore */ }
}

flog("─── Service worker started ───", `pid=${process.pid}`, `user=${process.env.USERNAME || "?"}`);

let koffi, user32;
let openInputDesktop, setThreadDesktop, closeDesktop, getThreadDesktop, switchDesktop;

async function initFfi() {
  koffi = (await import("koffi")).default;
  user32 = koffi.load("user32.dll");

  // OpenInputDesktop: returns HDESK to currently focused desktop (Default or Winlogon)
  openInputDesktop = user32.func("__stdcall", "OpenInputDesktop", "void *", ["uint", "bool", "uint"]);
  setThreadDesktop = user32.func("__stdcall", "SetThreadDesktop", "bool", ["void *"]);
  closeDesktop     = user32.func("__stdcall", "CloseDesktop", "bool", ["void *"]);
  getThreadDesktop = user32.func("__stdcall", "GetThreadDesktop", "void *", ["uint32"]);
  switchDesktop    = user32.func("__stdcall", "SwitchDesktop", "bool", ["void *"]);

  flog("FFI ready");
}

function isLocked() {
  try {
    execFileSync("powershell.exe",
      ["-NonInteractive", "-NoProfile", "-Command", "if(Get-Process LogonUI -EA SilentlyContinue){exit 0}else{exit 1}"],
      { windowsHide: true, timeout: 3000 });
    return true;
  } catch { return false; }
}

async function captureViaPsGdiOnInputDesktop(frameIdx) {
  // Switch this thread to the input desktop (Winlogon when locked).
  // DESKTOP_READOBJECTS=0x0001, DESKTOP_WRITEOBJECTS=0x0080
  const ACCESS = 0x0001 | 0x0080 | 0x0100 /* CREATEWINDOW */;
  const hdesk = openInputDesktop(0, false, ACCESS);
  if (!hdesk) {
    flog(`OpenInputDesktop failed (frame ${frameIdx})`);
    return { ok: false, error: "OpenInputDesktop failed" };
  }
  const ok = setThreadDesktop(hdesk);
  flog(`SetThreadDesktop=${ok} (frame ${frameIdx})`);

  // We can only capture from a process running on that desktop. Spawning
  // PowerShell from a service inheriting current desktop is what we want.
  const file = path.join(OUT_DIR, `frame-${String(frameIdx).padStart(3, "0")}.png`).replace(/\\/g, "\\\\");
  const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; ` +
    `$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; ` +
    `$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; ` +
    `$g=[System.Drawing.Graphics]::FromImage($bmp); ` +
    `$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$bmp.Size); ` +
    `$bmp.Save('${file}'); $g.Dispose(); $bmp.Dispose()`;
  try {
    execFileSync("powershell.exe", ["-NonInteractive", "-NoProfile", "-WindowStyle", "Hidden", "-Command", ps], { windowsHide: true, timeout: 10000 });
    closeDesktop(hdesk);
    return { ok: true, file };
  } catch (err) {
    closeDesktop(hdesk);
    return { ok: false, error: err.message };
  }
}

async function main() {
  await initFfi();
  let frameIdx = 0;
  // Run for 20 minutes max — service can be uninstalled to stop earlier
  const stopAt = Date.now() + 20 * 60 * 1000;
  while (Date.now() < stopAt) {
    frameIdx++;
    const locked = isLocked();
    flog(`frame=${frameIdx} locked=${locked}`);
    const r = await captureViaPsGdiOnInputDesktop(frameIdx);
    flog(`  ${r.ok ? "✅" : "❌"} ${r.file || r.error}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  flog("─── Worker time limit reached, exiting ───");
}

main().catch((err) => {
  flog("FATAL:", err.stack || err.message);
  process.exit(1);
});
