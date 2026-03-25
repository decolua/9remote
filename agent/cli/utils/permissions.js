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

    // Accessibility: attempt a real keystroke action — fails without permission
    exec(`osascript -e 'tell application "System Events" to key code 0 using {}'`,
      { timeout: 3000 }, (err) => { ax = !err; finish(); });

    // Screen Recording: capture 1px — fails silently without permission
    exec(`screencapture -x -R 0,0,1,1 /tmp/9remote_perm_check.png && rm -f /tmp/9remote_perm_check.png`,
      { timeout: 5000 }, (err) => { sr = !err; finish(); });
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
