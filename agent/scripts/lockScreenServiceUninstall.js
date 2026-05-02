// Tier 3: Uninstall the lock-screen test Windows Service.
//
// Run from an Administrator command prompt:
//   node agent/scripts/lockScreenServiceUninstall.js

import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  console.error("❌ This uninstaller only runs on Windows.");
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.join(__dirname, "lockScreenServiceWorker.js");

const { Service } = await import("node-windows");

const svc = new Service({
  name: "9remoteLockTest",
  script: workerPath
});

svc.on("uninstall", () => {
  console.log("✅ Service uninstalled.");
  console.log("Output left at: C:\\ProgramData\\9remote-locktest\\");
});
svc.on("error", (err) => console.error("❌ Service error:", err));

svc.uninstall();
