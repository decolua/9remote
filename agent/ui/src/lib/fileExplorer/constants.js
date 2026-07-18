// File explorer + git panel tunables (ported from web, subset used by agent UI)

export const LANGUAGE_MAP = {
  ".js": "javascript",
  ".jsx": "javascript",
  ".ts": "javascript",
  ".tsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".scss": "css",
  ".less": "css",
  ".json": "json",
  ".md": "markdown",
  ".markdown": "markdown",
};

// Map language → icon name in local Icon.jsx
export const FILE_ICON_NAMES = {
  folder: "folder",
  file: "file",
  javascript: "fileCode",
  html: "fileCode",
  css: "fileCode",
  json: "fileJson",
  markdown: "fileText",
  image: "image",
  binary: "package",
};

export const GIT_STATUS_COLORS = {
  M: "text-blue-400",
  A: "text-green-400",
  D: "text-red-400",
  "?": "text-green-400",
  U: "text-orange-400",
};

export const STORAGE_KEYS = {
  showHidden: "fileExplorer.showHidden",
  activityPanel: "fileExplorer.activityPanel",
  sidebarWidth: "fileExplorer.sidebarWidth",
  sidebarVisible: "fileExplorer.sidebarVisible",
  bottomPanelVisible: "fileExplorer.bottomPanelVisible",
  bottomPanelHeight: "fileExplorer.bottomPanelHeight",
  editorFontSize: "fileExplorer.editorFontSize",
  wordWrap: "fileExplorer.wordWrap",
  autoSaveMode: "fileExplorer.autoSaveMode",
  expandedFolders: "fileExplorer.expandedFolders",
};

// TerminalPane git badge
export const WATCH_DEBOUNCE_MS = 600;
export const MAX_CHANGED_BADGE = 9;

// VSCode-like layout constants
export const SIDEBAR_DEFAULT_WIDTH = 18;
export const SIDEBAR_MIN_WIDTH = 12;
export const SIDEBAR_MAX_WIDTH = 40;
export const ACTIVITY_BAR_WIDTH = 48;
export const STATUS_BAR_HEIGHT = 24;
export const BOTTOM_PANEL_DEFAULT_HEIGHT = 30;
export const BOTTOM_PANEL_MIN_HEIGHT = 10;
export const BOTTOM_PANEL_MAX_HEIGHT = 70;

// Activity panels
export const ACTIVITY_PANELS = {
  explorer: "explorer",
  search: "search",
  scm: "scm",
  settings: "settings",
};

// Auto-save
export const AUTO_SAVE_DELAY = 3000;
export const AUTO_SAVE_MODES = {
  off: "off",
  afterDelay: "afterDelay",
  onFocusChange: "onFocusChange",
};

// Editor font
export const EDITOR_FONT_DEFAULT = 14;
export const EDITOR_FONT_MIN = 10;
export const EDITOR_FONT_MAX = 28;

// Git diff virtual tab
export const DIFF_TAB_PREFIX = "git-diff:";
export const makeDiffPath = (status, absPath) => `${DIFF_TAB_PREFIX}${status}:${absPath}`;
export const isDiffPath = (p) => typeof p === "string" && p.startsWith(DIFF_TAB_PREFIX);
export const parseDiffPath = (p) => {
  const rest = p.slice(DIFF_TAB_PREFIX.length);
  const i = rest.indexOf(":");
  return { status: rest.slice(0, i), absPath: rest.slice(i + 1) };
};

// Previewable file types (browser can render native). Mirrors agent/feature constants.
export const IMAGE_EXTENSIONS = [
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp",
  ".svg", ".avif", ".apng", ".tif", ".tiff",
];
export const VIDEO_EXTENSIONS = [".mp4", ".m4v", ".webm", ".ogv", ".mov", ".mkv", ".avi", ".3gp"];
export const AUDIO_EXTENSIONS = [".mp3", ".wav", ".ogg", ".oga", ".flac", ".m4a", ".aac", ".opus"];
export const PDF_EXTENSIONS = [".pdf"];

function hasExt(filePath, exts) {
  if (!filePath) return false;
  const lower = filePath.toLowerCase();
  return exts.some((e) => lower.endsWith(e));
}
export const isImageFile = (p) => hasExt(p, IMAGE_EXTENSIONS);
export const isVideoFile = (p) => hasExt(p, VIDEO_EXTENSIONS);
export const isAudioFile = (p) => hasExt(p, AUDIO_EXTENSIONS);
export const isPdfFile = (p) => hasExt(p, PDF_EXTENSIONS);

// Max open editor tabs on desktop; newest at head (LRU), oldest evicted past this
export const MAX_OPEN_TABS = 5;
