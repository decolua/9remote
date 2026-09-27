// Tier 3: Install lockScreenServiceWorker.js as a Windows Service (LocalSystem).
//
// MUST be run from an Administrator command prompt on Windows:
//   node agent/scripts/lockScreenServiceInstall.js
//
// After installation, lock the machine. The service will write PNGs to
//   C:\ProgramData\9remote-locktest\
// Inspect them after unlocking. Use lockScreenServiceUninstall.js to remove.

import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  console.error("❌ This installer only runs on Windows.");
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.join(__dirname, "lockScreenServiceWorker.js");

const { Service } = await import("node-windows");

const svc = new Service({
  name: "9remoteLockTest",
  description: "9remote lock-screen capture diagnostic worker (LocalSystem).",
  script: workerPath,
  nodeOptions: [],
  workingDirectory: __dirname
});

svc.on("install", () => {
  console.log("✅ Service installed: 9remoteLockTest");
  console.log("▶️  Starting service...");
  svc.start();
});
svc.on("start", () => {
  console.log("✅ Service started.");
  console.log("");
  console.log("Now lock your machine (Win+L) and wait ~30s.");
  console.log("Output: C:\\ProgramData\\9remote-locktest\\");
  console.log("Stop:   node agent/scripts/lockScreenServiceUninstall.js");
});
svc.on("error", (err) => console.error("❌ Service error:", err));
svc.on("alreadyinstalled", () => {
  console.log("ℹ️  Already installed. Restarting...");
  svc.restart();
});

svc.install();
