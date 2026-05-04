// File Explorer constants

export const MAX_FILE_SIZE = 500 * 1024; // 500KB
export const MAX_SEARCH_RESULTS = 200;
export const MAX_MATCHES_PER_FILE = 10;
export const DEFAULT_TREE_DEPTH = 3;
export const DEFAULT_GIT_LOG_LIMIT = 20;

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
  ".output",
  "out",
  ".nuxt",
  ".svelte-kit",
  "target",
  "vendor",
  ".gradle",
  ".pytest_cache",
  ".mypy_cache",
  ".tox",
  ".venv",
  "venv",
  "env",
  ".DS_Store",
  ".parcel-cache",
  ".rollup.cache"
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

export const FILE_ICONS = {
  folder: "📁",
  file: "📄",
  javascript: "🟨",
  html: "🟧",
  css: "🟦",
  json: "📋",
  markdown: "📝",
  image: "🖼️",
  binary: "📦"
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
