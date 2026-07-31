// macOS TCC checks — same Swift probes the Tauri shell used.

import { spawn, execFile } from "child_process";

const PANE_URLS = {
  screenRecording: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
};

function runSwift(script) {
  return new Promise((resolve) => {
    const child = spawn("swift", ["-"], { stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (b) => { out += b; });
    child.on("close", () => resolve(out.trim()));
    child.on("error", () => resolve(""));
    child.stdin.end(script);
  });
}

export async function checkPermissions() {
  if (process.platform !== "darwin") return { screenRecording: true, accessibility: true };
  const [sr, ax] = await Promise.all([
    runSwift('import CoreGraphics\nprint(CGPreflightScreenCaptureAccess() ? "1" : "0")'),
    runSwift('import ApplicationServices\nprint(AXIsProcessTrusted() ? "1" : "0")'),
  ]);
  return { screenRecording: sr === "1", accessibility: ax === "1" };
}

// Trigger the system prompt, then open the pane so the user can flip the switch.
export async function requestPermission(type) {
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "ms-settings:privacy-screencapture"]);
    return;
  }
  if (process.platform !== "darwin") return;

  if (type === "screenRecording") {
    await runSwift("import CoreGraphics\nCGRequestScreenCaptureAccess()");
  } else if (type === "accessibility") {
    await runSwift(
      "import ApplicationServices\n" +
      "let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary\n" +
      "AXIsProcessTrustedWithOptions(opts)"
    );
  } else {
    return;
  }
  execFile("open", [PANE_URLS[type]]);
}
