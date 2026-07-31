// Shared config for the Electron shell. Keep in sync with src-tauri/src/lib.rs
// while both shells exist.

export const SERVER_PORT = 2208;
export const VITE_PORT = 5173;
export const NPM_PREFIX_DIR = ".9remote/npm";
export const NPM_PACKAGE = "9remote";
export const CLI_REL_PATH = "node_modules/9remote/dist/cli.cjs";
export const HEALTH_TIMEOUT_MS = 60_000;
export const HEALTH_POLL_MS = 200;
export const ALMOST_READY_MS = 15_000;
export const NPM_INSTALL_TIMEOUT_MS = 300_000;
export const TRAY_ICON_SIZE = 16;

export const WINDOW = {
  width: 960,
  height: 720,
  minWidth: 820,
  minHeight: 600,
};

// Global `npm i -g 9remote` roots, checked in order after the version-manager prefix
export const GLOBAL_NODE_MODULES = [
  "/usr/local/lib/node_modules",
  "/opt/homebrew/lib/node_modules",
];
