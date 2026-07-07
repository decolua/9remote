// File Explorer constants

export const MAX_FILE_SIZE = 500 * 1024; // 500KB

export const IGNORED_DIRS = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  "__pycache__",
  ".cache",
  ".vscode",
  ".idea",
  ".turbo",
  ".vercel",
  ".output"
];

export const BINARY_EXTENSIONS = [
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg", ".bmp",
  ".pdf", ".zip", ".tar", ".gz", ".rar", ".7z",
  ".exe", ".dll", ".so", ".dylib",
  ".mp3", ".mp4", ".wav", ".avi", ".mov", ".webm",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".sqlite", ".db"
];

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
  ".markdown": "markdown"
};

// Icon names for Lucide icons (rendered in components)
export const FILE_ICON_NAMES = {
  folder: "Folder",
  file: "File",
  javascript: "FileCode",
  html: "FileCode",
  css: "FileCode",
  json: "FileJson",
  markdown: "FileText",
  image: "Image",
  binary: "Package"
};

export const GIT_STATUS = {
  modified: "M",
  added: "A",
  deleted: "D",
  untracked: "?"
};

export const GIT_STATUS_COLORS = {
  M: "text-blue-400",
  A: "text-green-400",
  D: "text-red-400",
  "?": "text-green-400",
  U: "text-orange-400"
};

export const AUTO_SAVE_DELAY = 3000; // 3 seconds

// Git diff: side-by-side (VSCode-like) at/above this width, unified below
export const DIFF_SIDE_BY_SIDE_BREAKPOINT = 768;

// Virtual tab for git diff view: `git-diff:<status>:<absPath>`
export const DIFF_TAB_PREFIX = "git-diff:";
export const makeDiffPath = (status, absPath) => `${DIFF_TAB_PREFIX}${status}:${absPath}`;
export const isDiffPath = (p) => typeof p === "string" && p.startsWith(DIFF_TAB_PREFIX);
export const parseDiffPath = (p) => {
  const rest = p.slice(DIFF_TAB_PREFIX.length);
  const i = rest.indexOf(":");
  return { status: rest.slice(0, i), absPath: rest.slice(i + 1) };
};

// VSCode-like layout constants
export const SIDEBAR_DEFAULT_WIDTH = 18; // percent
export const SIDEBAR_MIN_WIDTH = 12;
export const SIDEBAR_MAX_WIDTH = 40;
export const ACTIVITY_BAR_WIDTH = 48; // px
export const STATUS_BAR_HEIGHT = 24; // px
export const BOTTOM_PANEL_DEFAULT_HEIGHT = 30; // percent
export const BOTTOM_PANEL_MIN_HEIGHT = 10;
export const BOTTOM_PANEL_MAX_HEIGHT = 70;
export const MAX_RECENT_WORKSPACES = 20;
export const MAX_RECENT_FILES = 20;
export const MAX_OPEN_TABS = 30;

// LocalStorage keys
export const STORAGE_KEYS = {
  sidebarWidth: "fileExplorer.sidebarWidth",
  sidebarVisible: "fileExplorer.sidebarVisible",
  bottomPanelVisible: "fileExplorer.bottomPanelVisible",
  bottomPanelHeight: "fileExplorer.bottomPanelHeight",
  activityPanel: "fileExplorer.activityPanel",
  recentFiles: "fileExplorer.recentFiles",
  openTabs: "fileExplorer.openTabs",
  editorFontSize: "fileExplorer.editorFontSize",
  wordWrap: "fileExplorer.wordWrap",
  autoSaveMode: "fileExplorer.autoSaveMode",
  expandedFolders: "fileExplorer.expandedFolders",
  showHidden: "fileExplorer.showHidden"
};

// Activity panels
export const ACTIVITY_PANELS = {
  explorer: "explorer",
  search: "search",
  scm: "scm",
  settings: "settings"
};

// Auto-save modes
export const AUTO_SAVE_MODES = {
  off: "off",
  afterDelay: "afterDelay",
  onFocusChange: "onFocusChange"
};

// Editor font size
export const EDITOR_FONT_DEFAULT = 14;
export const EDITOR_FONT_MIN = 10;
export const EDITOR_FONT_MAX = 28;
