import path from "node:path";
import os from "node:os";

export const DEFAULT_VIEWPORT = { width: 1120, height: 780 };
export const CDP_CALL_TIMEOUT_MS = 30000;
export const LAUNCH_TIMEOUT_MS = 15000;

export const STREAM_QUALITY = 85;
export const STREAM_EVERY_NTH = 1;
export const STREAM_MIN_INTERVAL_MS = 33;
export const STREAM_ACK_TIMEOUT_MS = 4000;
export const STREAM_MAX_EDGE = 1920;
export const STREAM_INPUT_BATCH_MAX = 50;
// Binary-lane flow control (remote-desktop style): frames in flight awaiting a
// client paint-ack, and how long silence releases the window (lost/old client).
export const STREAM_ACK_WINDOW = 2;
export const STREAM_ACK_DEAD_MS = 2000;
// Frame chunk cap for the ordered file lane — must fit the DC message size.
export const STREAM_FRAME_CHUNK_BYTES = 48 * 1024;
// Tile grid for frame diffing — matches the remote desktop pipeline (128px on
// darwin). Tiles ride the wire in remote's encodeTilesBatch format verbatim.
export const BROWSER_TILE_SIZE = 128;
// Hybrid: when this share of the grid changed, re-encoding every tile costs
// more than it saves — forward Chrome's own jpeg instead (zero re-encode).
export const STREAM_TILE_FULL_RATIO = 0.7;
// Tiles are a SECOND lossy generation (Chrome jpeg → tile webp): encode them
// sharper than the source so re-compression stays visually transparent.
export const STREAM_TILE_QUALITY_BOOST = 10;
export const STREAM_TILE_QUALITY_MAX = 95;
export const STREAM_TILE_SHARP_OPTS = { chromaSubsampling: "4:4:4" };

export const TABS_POLL_MS = 2000;

// Headless RAM reclaim: an idle headless Chrome (no stream, no invoke, no tab
// events) closes after this long; the next invoke relaunches and restores the
// session. Env override: NREMOTE_BROWSER_IDLE_MS.
export const HEADLESS_IDLE_CLOSE_MS = Number(process.env.NREMOTE_BROWSER_IDLE_MS) || 10 * 60_000;
export const HEADLESS_IDLE_SWEEP_MS = 30_000;

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
  return process.env.NREMOTE_BROWSER_PROFILES_DIR || path.join(os.homedir(), ".9remote", "browser-profiles");
}

export const KEY_DEFINITIONS = {
  enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, text: "\t" },
  escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  end: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
  space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " }
};
