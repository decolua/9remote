/**
 * Shared permission check logic (macOS TCC).
 * Used by both the server (index.js) and TUI (tui.js via API).
 */

import { exec } from "child_process";

export const PERM_URLS = {
  screenRecording: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  accessibility:   "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
};

/**
 * Check macOS permissions. Returns { screenRecording, accessibility }.
 * On non-macOS always returns true for both.
 * @returns {Promise<{screenRecording: boolean, accessibility: boolean}>}
 */
export function checkPermissions() {
  return new Promise((resolve) => {
    if (process.platform !== "darwin") {
      resolve({ screenRecording: true, accessibility: true });
      return;
    }

    let sr = false, ax = false, done = 0;
    const finish = () => { if (++done === 2) resolve({ screenRecording: sr, accessibility: ax }); };

    // Accessibility: reading UI elements truly requires AX permission (reflects revoke instantly)
    exec(`osascript -e 'tell application "System Events" to tell process "Finder" to get name of every window'`,
      { timeout: 3000 }, (err) => { ax = !err; finish(); });

    // Screen Recording: CGPreflightScreenCaptureAccess via CoreGraphics — reflects TCC state in realtime
    exec(`osascript -e 'use framework "CoreGraphics"' -e "return (current application's CGPreflightScreenCaptureAccess()) as boolean"`,
      { timeout: 3000 }, (err, stdout) => { sr = !err && stdout.trim() === "true"; finish(); });
  });
}

/**
 * Open System Preferences pane for a given permission type.
 * @param {"screenRecording"|"accessibility"} type
 */
export function openPermissionPane(type) {
  const url = PERM_URLS[type];
  if (url && process.platform === "darwin") exec(`open "${url}"`, () => {});
}
