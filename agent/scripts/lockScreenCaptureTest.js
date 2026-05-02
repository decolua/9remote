// Windows lock-screen capture diagnostic — Tier 1 (user session) + Tier 4 (FFI / PrintWindow).
//
// Usage:
//   node agent/scripts/lockScreenCaptureTest.js
//
// Within `startDelayMs` → manually lock the machine (Win+L). Script captures every
// `captureIntervalMs` for `totalDurationMs` and saves PNGs per method.
// Lock state is detected each frame via PowerShell (Get-Process LogonUI).
//
// Output: .docs/benchmark/lockTest/<timestamp>/<method>/<frame>.png + summary.json

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === "win32";

const CONFIG = {
  startDelayMs: 5000,
  captureIntervalMs: 4000,
  totalDurationMs: 60000,
  clickBeforeCapture: true,
  outputRoot: path.resolve(__dirname, "../../.docs/benchmark/lockTest")
};

const runStamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const runDir = path.join(CONFIG.outputRoot, runStamp);
fs.mkdirSync(runDir, { recursive: true });

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

function saveBuffer(method, frameIdx, ext, buf) {
  const dir = path.join(runDir, method);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${String(frameIdx).padStart(3, "0")}.${ext}`);
  fs.writeFileSync(file, buf);
  return file;
}

// ── Lock state detection (Windows) ───────────────────────────────────────

function isLocked() {
  if (!IS_WIN) return false;
  try {
    // LogonUI process exists ⇒ secure desktop active (lock / UAC / login)
    execFileSync("powershell.exe",
      ["-NonInteractive", "-NoProfile", "-Command", "if(Get-Process LogonUI -EA SilentlyContinue){exit 0}else{exit 1}"],
      { windowsHide: true, timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

// ── koffi FFI helpers (Win32 user32/gdi32) ───────────────────────────────

let koffi = null;
let user32 = null;
let gdi32 = null;
let printWindowFn = null;
let getDesktopWindowFn = null;
let findWindowFn = null;
let getWindowRectFn = null;
let getWindowTextFn = null;
let enumWindowsFn = null;
let getClassNameFn = null;
let isWindowVisibleFn = null;
let getDcFn = null;
let releaseDcFn = null;

async function initKoffi() {
  if (!IS_WIN) return false;
  try {
    koffi = (await import("koffi")).default;
    user32 = koffi.load("user32.dll");
    gdi32 = koffi.load("gdi32.dll");

    const RECT = koffi.struct("RECT", { left: "long", top: "long", right: "long", bottom: "long" });

    printWindowFn = user32.func("__stdcall", "PrintWindow", "bool", ["void *", "void *", "uint"]);
    getDesktopWindowFn = user32.func("__stdcall", "GetDesktopWindow", "void *", []);
    findWindowFn = user32.func("__stdcall", "FindWindowW", "void *", ["str16", "str16"]);
    getWindowRectFn = user32.func("__stdcall", "GetWindowRect", "bool", ["void *", koffi.out(koffi.pointer(RECT))]);
    getWindowTextFn = user32.func("__stdcall", "GetWindowTextW", "int", ["void *", koffi.out("char16 *"), "int"]);
    enumWindowsFn = user32.func("__stdcall", "EnumWindows", "bool", [koffi.pointer(koffi.proto("enumProc", "bool", ["void *", "long"])), "long"]);
    getClassNameFn = user32.func("__stdcall", "GetClassNameW", "int", ["void *", koffi.out("char16 *"), "int"]);
    isWindowVisibleFn = user32.func("__stdcall", "IsWindowVisible", "bool", ["void *"]);
    getDcFn = user32.func("__stdcall", "GetDC", "void *", ["void *"]);
    releaseDcFn = user32.func("__stdcall", "ReleaseDC", "int", ["void *", "void *"]);
    return true;
  } catch (err) {
    log("⚠️  koffi init failed:", err.message);
    return false;
  }
}

// ── Capture methods ──────────────────────────────────────────────────────

async function captureNodeScreenshots() {
  const { Monitor } = await import("node-screenshots");
  const m = Monitor.all()[0];
  const img = m.captureImageSync();
  return { buffer: Buffer.from(img.toPngSync()), ext: "png", width: img.width, height: img.height };
}

async function captureRobotjs() {
  const sharp = (await import("sharp")).default;
  const robotMod = await import("@hurdlegroup/robotjs");
  const robot = robotMod.default || robotMod;
  const { width, height } = robot.getScreenSize();
  const bitmap = robot.screen.capture(0, 0, width, height);
  const buf = Buffer.from(bitmap.image);
  const u32 = new Uint32Array(buf.buffer, buf.byteOffset, buf.length >> 2);
  for (let i = 0; i < u32.length; i++) {
    const p = u32[i];
    u32[i] = (p & 0xFF00FF00) | ((p & 0x00FF0000) >> 16) | ((p & 0x000000FF) << 16);
  }
  const w = bitmap.byteWidth / bitmap.bytesPerPixel;
  const png = await sharp(buf, { raw: { width: w, height: bitmap.height, channels: 4 } }).png().toBuffer();
  return { buffer: png, ext: "png", width: w, height: bitmap.height };
}

async function captureScreenshotDesktop() {
  const screenshot = (await import("screenshot-desktop")).default;
  const buf = await screenshot({ format: "png" });
  return { buffer: buf, ext: "png", width: 0, height: 0 };
}

// PowerShell GDI CopyFromScreen
function capturePsGdi(frameIdx) {
  if (!IS_WIN) throw new Error("win32 only");
  const dir = path.join(runDir, "psGdi");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${String(frameIdx).padStart(3, "0")}.png`).replace(/\\/g, "\\\\");
  const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; ` +
    `$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; ` +
    `$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; ` +
    `$g=[System.Drawing.Graphics]::FromImage($bmp); ` +
    `$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$bmp.Size); ` +
    `$bmp.Save('${file}'); $g.Dispose(); $bmp.Dispose()`;
  execFileSync("powershell.exe", ["-NonInteractive", "-NoProfile", "-WindowStyle", "Hidden", "-Command", ps], { windowsHide: true, timeout: 8000 });
  return { skipSave: true, ext: "png" };
}

// PowerShell PrintWindow with PW_RENDERFULLCONTENT (0x2) — try to capture
// protected windows by asking the window to render itself into a DC.
function capturePsPrintWindow(frameIdx) {
  if (!IS_WIN) throw new Error("win32 only");
  const dir = path.join(runDir, "psPrintWindow");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${String(frameIdx).padStart(3, "0")}.png`).replace(/\\/g, "\\\\");
  const ps = [
    "Add-Type @\"",
    "using System;using System.Runtime.InteropServices;using System.Drawing;using System.Drawing.Imaging;",
    "public class PW{",
    "[DllImport(\"user32.dll\")]public static extern IntPtr GetDesktopWindow();",
    "[DllImport(\"user32.dll\")]public static extern bool GetWindowRect(IntPtr h,out RECT r);",
    "[DllImport(\"user32.dll\")]public static extern bool PrintWindow(IntPtr h,IntPtr dc,uint f);",
    "[StructLayout(LayoutKind.Sequential)]public struct RECT{public int L,T,R,B;}",
    "public static void Cap(string p){IntPtr h=GetDesktopWindow();RECT r;GetWindowRect(h,out r);int w=r.R-r.L,he=r.B-r.T;Bitmap b=new Bitmap(w,he,PixelFormat.Format32bppArgb);Graphics g=Graphics.FromImage(b);IntPtr dc=g.GetHdc();PrintWindow(h,dc,2);g.ReleaseHdc(dc);b.Save(p,ImageFormat.Png);b.Dispose();g.Dispose();}}",
    "\"@ -ReferencedAssemblies System.Drawing",
    `[PW]::Cap('${file}')`
  ].join("\n");
  execFileSync("powershell.exe", ["-NonInteractive", "-NoProfile", "-WindowStyle", "Hidden", "-Command", ps], { windowsHide: true, timeout: 10000 });
  return { skipSave: true, ext: "png" };
}

// koffi PrintWindow on the desktop window
async function captureKoffiPrintWindow(frameIdx) {
  if (!IS_WIN || !koffi) throw new Error("koffi not available");
  // Use sharp to wrap raw screen capture into PNG; PrintWindow needs a memory DC
  // so easiest path is to spawn PowerShell which already has GDI — duplicates
  // psPrintWindow. So instead: enumerate top-level windows, find LogonUI / lock
  // related ones, and capture each individually via PrintWindow.
  const sharp = (await import("sharp")).default;

  const targets = [];
  const seen = new Set();
  const wantPatterns = [/lock/i, /logon/i, /credential/i, /CredentialDialog/i];
  const cb = (hwnd, _) => {
    try {
      if (!isWindowVisibleFn(hwnd)) return true;
      const clsBuf = ["a"]; // koffi out string16 → use Buffer? simplest: alloc array
      // Use simple approach: read class name + window text
      const clsArr = new Uint16Array(256);
      const txtArr = new Uint16Array(256);
      const clsLen = getClassNameFn(hwnd, clsArr, 256);
      const txtLen = getWindowTextFn(hwnd, txtArr, 256);
      const cls = clsLen > 0 ? Buffer.from(clsArr.buffer, 0, clsLen * 2).toString("utf16le") : "";
      const txt = txtLen > 0 ? Buffer.from(txtArr.buffer, 0, txtLen * 2).toString("utf16le") : "";
      const key = `${cls}|${txt}`;
      if (seen.has(key)) return true;
      seen.add(key);
      if (wantPatterns.some(p => p.test(cls) || p.test(txt))) {
        targets.push({ hwnd, cls, txt });
      }
    } catch { /* ignore */ }
    return true;
  };

  try {
    enumWindowsFn(koffi.register(cb, koffi.proto("enumProc", "bool", ["void *", "long"])), 0);
  } catch (e) {
    // fallback: just use desktop window
  }
  if (targets.length === 0) {
    targets.push({ hwnd: getDesktopWindowFn(), cls: "Desktop", txt: "(root)" });
  }

  // Save metadata
  const metaDir = path.join(runDir, "koffiPrintWindow");
  fs.mkdirSync(metaDir, { recursive: true });
  fs.writeFileSync(path.join(metaDir, `${String(frameIdx).padStart(3, "0")}.targets.json`),
    JSON.stringify(targets.map(t => ({ cls: t.cls, txt: t.txt })), null, 2));

  // koffi alone can't easily build DIB → use PowerShell PrintWindow per hwnd
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const handleNum = koffi.address(t.hwnd);
    const file = path.join(metaDir, `${String(frameIdx).padStart(3, "0")}-${i}-${(t.cls || "x").replace(/[^\w]/g, "_")}.png`).replace(/\\/g, "\\\\");
    const ps = [
      "Add-Type @\"",
      "using System;using System.Runtime.InteropServices;using System.Drawing;using System.Drawing.Imaging;",
      "public class PWX{",
      "[DllImport(\"user32.dll\")]public static extern bool GetWindowRect(IntPtr h,out RECT r);",
      "[DllImport(\"user32.dll\")]public static extern bool PrintWindow(IntPtr h,IntPtr dc,uint f);",
      "[StructLayout(LayoutKind.Sequential)]public struct RECT{public int L,T,R,B;}",
      "public static void Cap(IntPtr h,string p){RECT r;GetWindowRect(h,out r);int w=r.R-r.L,he=r.B-r.T;if(w<=0||he<=0)return;Bitmap b=new Bitmap(w,he,PixelFormat.Format32bppArgb);Graphics g=Graphics.FromImage(b);IntPtr dc=g.GetHdc();PrintWindow(h,dc,2);g.ReleaseHdc(dc);b.Save(p,ImageFormat.Png);b.Dispose();g.Dispose();}}",
      "\"@ -ReferencedAssemblies System.Drawing",
      `[PWX]::Cap([IntPtr]${handleNum},'${file}')`
    ].join("\n");
    try {
      execFileSync("powershell.exe", ["-NonInteractive", "-NoProfile", "-WindowStyle", "Hidden", "-Command", ps], { windowsHide: true, timeout: 8000 });
    } catch { /* skip this target */ }
  }
  return { skipSave: true, ext: "png", note: `targets=${targets.length}` };
}

// ── Wake helpers ─────────────────────────────────────────────────────────

async function tryRobotClick() {
  if (!CONFIG.clickBeforeCapture) return;
  try {
    const robotMod = await import("@hurdlegroup/robotjs");
    const robot = robotMod.default || robotMod;
    const { width, height } = robot.getScreenSize();
    robot.moveMouse(Math.floor(width / 2), Math.floor(height / 2));
    robot.mouseClick();
  } catch { /* ignore */ }
}

// ── Methods registry ─────────────────────────────────────────────────────

const METHODS = [
  { id: "nodeScreenshots", label: "node-screenshots (DXGI)", fn: captureNodeScreenshots },
  { id: "robotjs",         label: "robotjs (GDI BitBlt)",    fn: captureRobotjs },
  { id: "screenshotDesktop", label: "screenshot-desktop (PS)", fn: captureScreenshotDesktop },
  { id: "psGdi",           label: "PowerShell GDI CopyFromScreen", fn: capturePsGdi, win32Only: true },
  { id: "psPrintWindow",   label: "PowerShell PrintWindow PW_RENDERFULLCONTENT", fn: capturePsPrintWindow, win32Only: true },
  { id: "koffiPrintWindow", label: "koffi enum+PrintWindow per hwnd", fn: captureKoffiPrintWindow, win32Only: true, needsKoffi: true }
];

async function captureOnce(frameIdx, koffiOk) {
  await tryRobotClick();
  await new Promise((r) => setTimeout(r, 400));
  const locked = isLocked();
  const summary = [];

  await Promise.all(METHODS.map(async (m) => {
    if (m.win32Only && !IS_WIN) return;
    if (m.needsKoffi && !koffiOk) return;
    const t0 = performance.now();
    try {
      const r = await m.fn(frameIdx);
      const ms = (performance.now() - t0).toFixed(0);
      let file = "";
      if (!r.skipSave) file = saveBuffer(m.id, frameIdx, r.ext, r.buffer);
      summary.push({ id: m.id, ok: true, ms, size: r.buffer?.length || 0, w: r.width, h: r.height, file, note: r.note });
    } catch (err) {
      summary.push({ id: m.id, ok: false, error: err.message });
    }
  }));

  log(`Frame #${frameIdx} | locked=${locked}`);
  for (const s of summary) {
    if (s.ok) {
      const kb = s.size ? `${(s.size / 1024).toFixed(0)}KB` : (s.note || "ok");
      log(`  ✅ ${s.id.padEnd(20)} ${s.ms}ms  ${kb}  ${s.w || ""}${s.w ? "x" : ""}${s.h || ""}`);
    } else {
      log(`  ❌ ${s.id.padEnd(20)} ${s.error}`);
    }
  }
  return { locked, summary };
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n🔬 Lock Screen Capture Diagnostic — Tier 1 + Tier 4");
  console.log(`📂 Output: ${runDir}`);
  console.log(`🖥️  Platform: ${process.platform} ${process.arch} | Node ${process.version}`);
  console.log(`⏱️  Capture every ${CONFIG.captureIntervalMs}ms for ${CONFIG.totalDurationMs / 1000}s\n`);

  const koffiOk = await initKoffi();
  console.log(`🧩 koffi: ${koffiOk ? "ready" : "unavailable"}`);
  console.log(`👀 Methods: ${METHODS.filter(m => (!m.win32Only || IS_WIN) && (!m.needsKoffi || koffiOk)).map(m => m.label).join(", ")}\n`);

  console.log(`⚠️  LOCK YOUR MACHINE NOW (Win+L). Starting in ${CONFIG.startDelayMs / 1000}s...`);
  for (let s = CONFIG.startDelayMs / 1000; s > 0; s--) {
    process.stdout.write(`\r   ${s}...   `);
    await new Promise((r) => setTimeout(r, 1000));
  }
  process.stdout.write("\n\n");

  const all = [];
  const startedAt = Date.now();
  let frameIdx = 0;

  while (Date.now() - startedAt < CONFIG.totalDurationMs) {
    frameIdx++;
    const r = await captureOnce(frameIdx, koffiOk);
    all.push({ frame: frameIdx, ts: Date.now() - startedAt, locked: r.locked, results: r.summary });
    const remaining = CONFIG.totalDurationMs - (Date.now() - startedAt);
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(CONFIG.captureIntervalMs, remaining)));
  }

  fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify({
    config: CONFIG,
    system: { platform: process.platform, arch: process.arch, node: process.version, os: `${os.type()} ${os.release()}` },
    koffi: koffiOk,
    frames: all
  }, null, 2));

  console.log("\n✅ DONE. Unlock and inspect:");
  console.log(`   ${runDir}\n`);
  console.log("Look in each <method>/ folder. Frames marked locked=true are the ones to check.");
  console.log("If no method captured the password input → run Tier 3 (Service):");
  console.log("   sudo node agent/scripts/lockScreenServiceInstall.js   (Run as Administrator on Windows)\n");
}

main().catch((err) => { console.error("\n❌ FATAL:", err); process.exit(1); });
