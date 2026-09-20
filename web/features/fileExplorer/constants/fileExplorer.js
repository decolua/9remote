// Normalize OS-native separators to POSIX.
export const toPosixPath = (p) => (typeof p === "string" ? p.replace(/\\/g, "/") : p);

// Path fields in bus responses to normalize.
const PATH_FIELDS = new Set([
  "path", "currentPath", "parentPath", "dirPath", "filePath",
  "repoPath", "oldPath", "newPath", "fullPath", "relativePath",
]);

// Recursively normalize path fields in a bus response (no clone unless needed).
export function normalizePathsResponse(res) {
  if (!res || typeof res !== "object") return res;
  if (Array.isArray(res)) {
    let changed = false;
    const next = res.map((v) => {
      const n = normalizePathsResponse(v);
      if (n !== v) changed = true;
      return n;
    });
    return changed ? next : res;
  }
  let next;
  for (const k of Object.keys(res)) {
    const v = res[k];
    if (PATH_FIELDS.has(k) && typeof v === "string" && v.includes("\\")) {
      next ||= { ...res };
      next[k] = toPosixPath(v);
    } else if (v && typeof v === "object") {
      const n = normalizePathsResponse(v);
      if (n !== v) {
        next ||= { ...res };
        next[k] = n;
      }
    }
  }
  return next || res;
}

export const MAX_FILE_SIZE = 1024 * 1024;
// ponytail: media preview over base64 bus is slow for very large files;
// upgrade to HTTP range streaming when users routinely open >5MB media.
export const MAX_MEDIA_SIZE = 5 * 1024 * 1024;

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
  ".zip", ".tar", ".gz", ".tgz", ".rar", ".7z", ".bz2", ".xz",
  ".exe", ".dll", ".so", ".dylib", ".app", ".bin",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".sqlite", ".db", ".mdb",
  ".class", ".jar", ".war", ".pyc", ".o", ".obj"
];

export const IMAGE_EXTENSIONS = [
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp",
  ".svg", ".avif", ".apng", ".tif", ".tiff", ".heic", ".heif"
];

export const VIDEO_EXTENSIONS = [
  ".mp4", ".m4v", ".webm", ".ogv", ".mov", ".mkv", ".avi", ".3gp"
];

export const AUDIO_EXTENSIONS = [
  ".mp3", ".wav", ".ogg", ".oga", ".flac", ".m4a", ".aac", ".opus"
];

export const PDF_EXTENSIONS = [".pdf"];

export const DOCX_EXTENSIONS = [".docx"];

export const SHEET_EXTENSIONS = [".xlsx", ".xls", ".csv", ".tsv"];

export const HTML_EXTENSIONS = [".html", ".htm", ".xhtml"];

export const MERMAID_EXTENSIONS = [".mmd", ".mermaid"];

export const MARKDOWN_EXTENSIONS = [".md", ".markdown", ".mdx"];

export function hasExt(filePath, exts) {
  if (!filePath) return false;
  const lower = filePath.toLowerCase();
  return exts.some((e) => lower.endsWith(e));
}
export const isImageFile = (p) => hasExt(p, IMAGE_EXTENSIONS);
export const isVideoFile = (p) => hasExt(p, VIDEO_EXTENSIONS);
export const isAudioFile = (p) => hasExt(p, AUDIO_EXTENSIONS);
export const isPdfFile = (p) => hasExt(p, PDF_EXTENSIONS);
export const isDocxFile = (p) => hasExt(p, DOCX_EXTENSIONS);
export const isSheetFile = (p) => hasExt(p, SHEET_EXTENSIONS);
export const isHtmlFile = (p) => hasExt(p, HTML_EXTENSIONS);
export const isMermaidFile = (p) => hasExt(p, MERMAID_EXTENSIONS);
export const isMarkdownFile = (p) => hasExt(p, MARKDOWN_EXTENSIONS);

export function getTextPreviewKind(filePath) {
  if (!filePath) return null;
  if (isHtmlFile(filePath)) return "html";
  if (isMarkdownFile(filePath)) return "markdown";
  if (isMermaidFile(filePath)) return "mermaid";
  return null;
}

// Tag for sandboxed preview iframe postMessage navigation.
export const PREVIEW_NAV_SOURCE = "9remote-preview";
export const isPreviewableFile = (p) =>
  isImageFile(p) || isVideoFile(p) || isAudioFile(p) || isPdfFile(p)
  || isDocxFile(p) || isSheetFile(p);

export const LANGUAGE_MAP = {
  ".js": "javascript", ".jsx": "javascript", ".ts": "javascript",
  ".tsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".html": "html", ".htm": "html", ".xhtml": "html",
  ".css": "css", ".scss": "css", ".sass": "css", ".less": "css", ".styl": "css",
  ".json": "json", ".json5": "json", ".jsonc": "json",
  ".md": "markdown", ".markdown": "markdown", ".mdx": "markdown",
  ".py": "python", ".pyw": "python",
  ".rb": "ruby", ".php": "php", ".go": "go", ".rs": "rust",
  ".java": "java", ".kt": "kotlin", ".kts": "kotlin", ".swift": "swift",
  ".scala": "scala", ".clj": "clojure", ".cljs": "clojure",
  ".ex": "elixir", ".exs": "elixir", ".erl": "erlang", ".hs": "haskell",
  ".ml": "ocaml", ".mli": "ocaml", ".jl": "julia",
  ".pl": "perl", ".pm": "perl", ".tcl": "tcl", ".lua": "lua",
  ".r": "r", ".dart": "dart", ".groovy": "groovy", ".gradle": "groovy",
  ".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp",
  ".hpp": "cpp", ".hh": "cpp", ".cs": "csharp", ".m": "objectivec",
  ".sh": "shell", ".bash": "shell", ".zsh": "shell", ".fish": "shell",
  ".ps1": "powershell", ".bat": "batch", ".cmd": "batch",
  ".yml": "yaml", ".yaml": "yaml", ".toml": "toml",
  ".ini": "ini", ".cfg": "ini", ".conf": "ini", ".properties": "ini",
  ".xml": "xml", ".sql": "sql", ".graphql": "graphql", ".gql": "graphql",
  ".proto": "protobuf", ".vue": "vue", ".svelte": "svelte",
  ".csv": "csv", ".tsv": "csv", ".log": "log",
  ".diff": "diff", ".patch": "diff",
  ".dockerfile": "dockerfile", ".makefile": "makefile", ".mk": "makefile",
  ".env": "env", ".gitignore": "gitignore"
};

export const FILE_ICON_NAMES = {
  folder: "Folder",
  file: "File",
  javascript: "FileCode",
  html: "FileCode",
  css: "FileCode",
  json: "FileJson",
  markdown: "FileText",
  image: "Image",
  video: "FileText",
  audio: "FileText",
  pdf: "FileText",
  binary: "Package"
};

export const GIT_STATUS = {
  modified: "M",
  added: "A",
  deleted: "D",
  untracked: "?"
};

export const GIT_STATUS_COLORS = {
  M: "text-git-modified",
  A: "text-git-added",
  D: "text-git-deleted",
  "?": "text-git-untracked",
  U: "text-git-modified"
};

export const EXPLORER_ROW = {
  normal:  { indentBase: 12, indentStep: 12, icon: 16, chevron: 14, text: "text-[15px] sm:text-sm",     padY: "py-1 sm:py-0.5" },
  compact: { indentBase: 8,  indentStep: 8,  icon: 14, chevron: 12, text: "text-[13px] sm:text-[12px]", padY: "py-0.5 sm:py-[1px]" }
};

export const EXPLORER_ACTION_RIGHT = { none: 4, dot: 22, status: 32 };
export const actionRightFor = (status) =>
  !status ? EXPLORER_ACTION_RIGHT.none
  : status === "folder-changed" ? EXPLORER_ACTION_RIGHT.dot
  : EXPLORER_ACTION_RIGHT.status;

export const DIFF_SIDE_BY_SIDE_BREAKPOINT = 768;

export const DIFF_TAB_PREFIX = "git-diff:";
export const makeDiffPath = (status, absPath) => `${DIFF_TAB_PREFIX}${status}:${absPath}`;
export const isDiffPath = (p) => typeof p === "string" && p.startsWith(DIFF_TAB_PREFIX);
export const parseDiffPath = (p) => {
  const rest = p.slice(DIFF_TAB_PREFIX.length);
  const i = rest.indexOf(":");
  return { status: rest.slice(0, i), absPath: rest.slice(i + 1) };
};

const REPO_SEP = "\u0000";
export const makeRepoDiffPath = (status, repoPath, filePath) =>
  `${DIFF_TAB_PREFIX}${status}:${repoPath}${REPO_SEP}${filePath}`;
export const parseRepoDiffPath = (p) => {
  const { status, absPath } = parseDiffPath(p);
  const i = absPath.indexOf(REPO_SEP);
  if (i === -1) return { status, repoPath: null, filePath: absPath };
  return { status, repoPath: absPath.slice(0, i), filePath: absPath.slice(i + 1) };
};

export const SIDEBAR_DEFAULT_WIDTH = 18;
export const SIDEBAR_MIN_WIDTH = 12;
export const SIDEBAR_MAX_WIDTH = 40;
export const ACTIVITY_BAR_WIDTH = 48;
export const BOTTOM_PANEL_DEFAULT_HEIGHT = 30;
export const BOTTOM_PANEL_MIN_HEIGHT = 10;
export const BOTTOM_PANEL_MAX_HEIGHT = 70;
export const MAX_RECENT_WORKSPACES = 20;
export const MAX_RECENT_FILES = 20;

export const FILE_WATCH = {
  MAX_DIRS: 40,
  DEBOUNCE_MS: 300,
  PREVIEW_DEBOUNCE_MS: 1000,
  IDLE_UNWATCH_MS: 60000
};

export const GIT_REFRESH_EVENT = "fileExplorer:gitRefresh";

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
  expandedFolders: "fileExplorer.expandedFolders",
  showHidden: "fileExplorer.showHidden"
};

export const ACTIVITY_PANELS = {
  explorer: "explorer",
  search: "search",
  scm: "scm",
  settings: "settings"
};

export const EDITOR_FONT_DEFAULT = 14;
export const EDITOR_FONT_COMPACT_DELTA = 4;
export const EDITOR_FONT_COMPACT_MIN = 9;
export const EDITOR_FONT_MIN = 10;
export const EDITOR_FONT_MAX = 28;

export const MAX_OPEN_TABS = 5;

// Mobile WebKit crash prevention: limit max image size before explicit opt-in.
export const IMAGE_RENDER_MAX_BYTES = 4 * 1024 * 1024;
