// Shared config for the Electron shell. Keep in sync with src-tauri/src/lib.rs
// while both shells exist.

export const SERVER_PORT = 2208;
export const VITE_PORT = 5173;
export const NPM_PREFIX_DIR = ".9remote/npm";
export const NPM_PACKAGE = "9remote";
// npm --prefix installs into <prefix>/lib/node_modules on POSIX, <prefix>/node_modules on Windows
export const CLI_REL_PATH = process.platform === "win32"
  ? "node_modules/9remote/dist/cli.cjs"
  : "lib/node_modules/9remote/dist/cli.cjs";
// npm 11 blocks install scripts by default; native deps need theirs to place binaries
export const ALLOW_SCRIPTS = [
  "9remote", "@hurdlegroup/robotjs", "bufferutil",
  "koffi", "node-datachannel", "node-pty", "sharp", "utf-8-validate", "fsevents",
  "@julusian/jpeg-turbo",
];

export const HEALTH_TIMEOUT_MS = 60_000;
export const HEALTH_POLL_MS = 200;
export const ALMOST_READY_MS = 15_000;
export const NPM_INSTALL_TIMEOUT_MS = 300_000;
export const TRAY_ICON_SIZE = 16;

export const WINDOW = {
  width: 1100,
  height: 780,
  minWidth: 880,
  minHeight: 620,
};

// Global `npm i -g 9remote` roots, checked in order after the version-manager prefix
export const GLOBAL_NODE_MODULES = [
  "/usr/local/lib/node_modules",
  "/opt/homebrew/lib/node_modules",
];
