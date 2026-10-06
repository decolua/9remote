import path from "node:path";
import os from "node:os";

export const DEFAULT_VIEWPORT = { width: 1120, height: 780 };
export const CDP_CALL_TIMEOUT_MS = 30000;
export const LAUNCH_TIMEOUT_MS = 15000;

export const STREAM_QUALITY = 60;
export const STREAM_EVERY_NTH = 2;
export const STREAM_MIN_INTERVAL_MS = 120;
export const STREAM_ACK_TIMEOUT_MS = 4000;
export const STREAM_MAX_EDGE = 1280;
export const STREAM_INPUT_BATCH_MAX = 50;

export const TABS_POLL_MS = 2000;

export const CHROME_CANDIDATES = process.platform === "darwin"
  ? [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
    ]
  : process.platform === "win32"
  ? [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
    ]
  : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"];

export function getProfilesDir() {
  return path.join(os.homedir(), ".9remote", "browser-profiles");
}

export const KEY_CODES = {
  enter: 13, tab: 9, escape: 27, backspace: 8, delete: 46,
  arrowup: 38, arrowdown: 40, arrowleft: 37, arrowright: 39,
  home: 36, end: 35, pageup: 33, pagedown: 34
};
