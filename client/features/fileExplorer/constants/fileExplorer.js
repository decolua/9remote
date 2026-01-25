// File Explorer constants

export const MAX_FILE_SIZE = 200 * 1024; // 200KB

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
