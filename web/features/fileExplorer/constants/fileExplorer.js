// File Explorer constants

// Agent returns OS-native separators (\\ on Windows). Web helpers assume POSIX (/),
// so normalize at every boundary where a path enters web state.
export const toPosixPath = (p) => (typeof p === "string" ? p.replace(/\\/g, "/") : p);

// Field names that carry a filesystem path in socket responses — only these get
// normalized, so file *content* (readFile/gitDiff) is never touched.
const PATH_FIELDS = new Set([
  "path", "currentPath", "parentPath", "dirPath", "filePath",
  "repoPath", "oldPath", "newPath", "fullPath", "relativePath",
]);

// Recursively normalize path fields in a socket response (no clone unless needed).
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

export const MAX_FILE_SIZE = 1024 * 1024; // 1MB text read limit
// ponytail: media preview over base64 socket is slow for very large files;
// upgrade to HTTP range streaming when users routinely open >5MB media.
export const MAX_MEDIA_SIZE = 5 * 1024 * 1024; // 5MB previewable media limit

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
  ".svg", ".avif", ".apng", ".tif", ".tiff"
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
// Previewable = browser/lib can render without the text editor. Used to route
// away from the text editor and the binary rejection in readFile.
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

// VS Code's muted git decoration palette (tokens in globals.css), not bright tailwind hues.
export const GIT_STATUS_COLORS = {
  M: "text-git-modified",
  A: "text-git-added",
  D: "text-git-deleted",
  "?": "text-git-untracked",
  U: "text-git-modified"
};

// Explorer row metrics. "compact" is the narrow tree docked beside a terminal, where
// horizontal space is scarce; "normal" is the standalone file explorer. Rows read a step
// larger on phones — a 12px row is fine next to a mouse, not under a thumb.
export const EXPLORER_ROW = {
  normal:  { indentBase: 12, indentStep: 12, icon: 16, chevron: 14, text: "text-[15px] sm:text-sm",     padY: "py-1 sm:py-0.5" },
  compact: { indentBase: 8,  indentStep: 8,  icon: 14, chevron: 12, text: "text-[13px] sm:text-[12px]", padY: "py-0.5 sm:py-[1px]" }
};

// Auto-save is gone: an editor that writes behind the user's back cannot be trusted
// with a file they are halfway through changing, and it hides write failures.

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

// Same tab id, plus the repo the path is relative to. Needed where one view lists several
// repos (a workspace holding nested repos or worktrees): the file path alone is relative
// to its own repo, so without this the diff would be read from the wrong one.
// The two are joined by a NUL byte — the one character a filesystem path can never
// contain, so a name with spaces in it cannot split the id in the wrong place.
const REPO_SEP = "\u0000";
export const makeRepoDiffPath = (status, repoPath, filePath) =>
  `${DIFF_TAB_PREFIX}${status}:${repoPath}${REPO_SEP}${filePath}`;
export const parseRepoDiffPath = (p) => {
  const { status, absPath } = parseDiffPath(p);
  const i = absPath.indexOf(REPO_SEP);
  if (i === -1) return { status, repoPath: null, filePath: absPath };
  return { status, repoPath: absPath.slice(0, i), filePath: absPath.slice(i + 1) };
};

// VSCode-like layout constants
export const SIDEBAR_DEFAULT_WIDTH = 18; // percent
export const SIDEBAR_MIN_WIDTH = 12;
export const SIDEBAR_MAX_WIDTH = 40;
export const ACTIVITY_BAR_WIDTH = 48; // px
// Status bar height now lives in shared/constants/layout.js — one bar, one number.
export const BOTTOM_PANEL_DEFAULT_HEIGHT = 30; // percent
export const BOTTOM_PANEL_MIN_HEIGHT = 10;
export const BOTTOM_PANEL_MAX_HEIGHT = 70;
export const MAX_RECENT_WORKSPACES = 20;
export const MAX_RECENT_FILES = 20;

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

// Editor font size
export const EDITOR_FONT_DEFAULT = 14;
// The editor docked beside a terminal is ~420px wide, so it runs well below the
// full-screen editor. Subtracted from the user's own size, never replacing it.
export const EDITOR_FONT_COMPACT_DELTA = 4;
// Floor for the docked editor only — below the standalone minimum, because at this width
// fitting the line matters more than comfortable reading.
export const EDITOR_FONT_COMPACT_MIN = 9;
export const EDITOR_FONT_MIN = 10;
export const EDITOR_FONT_MAX = 28;

// Max open editor tabs on desktop; newest at head (LRU), oldest evicted past this
export const MAX_OPEN_TABS = 5;
