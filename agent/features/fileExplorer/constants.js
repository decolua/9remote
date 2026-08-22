// File Explorer constants

export const MAX_FILE_SIZE = 1024 * 1024; // 1MB text read limit
// ponytail: media preview over base64 socket is slow for very large files;
// upgrade to HTTP range streaming when users routinely open >5MB media.
export const MAX_MEDIA_SIZE = 5 * 1024 * 1024; // 5MB previewable media limit (video/audio/pdf)
// Image path: scale server-side via sharp, so raw input cap is generous but bounded,
// and the final data URL must fit under MAX_IMAGE_SCALED_SIZE to avoid base64 socket bloat.
export const MAX_IMAGE_RAW_SIZE = 20 * 1024 * 1024; // raw image input cap (pre-scale)
export const MAX_IMAGE_SCALED_SIZE = 3 * 1024 * 1024; // output data URL cap (post-scale)
export const IMAGE_SCALE_MAX_DIM = 1600; // max width/height after downscale
export const MAX_SEARCH_RESULTS = 200;
export const MAX_MATCHES_PER_FILE = 10;
export const DEFAULT_TREE_DEPTH = 3;
export const DEFAULT_GIT_LOG_LIMIT = 20;
// spawnSync defaults to a 1MB stdout buffer — a whole-repo `git diff` blows past that and
// comes back truncated (or empty), which reads as "no changes" in the UI.
export const MAX_GIT_OUTPUT_SIZE = 64 * 1024 * 1024;
// What is actually sent to the client: a diff past this is truncated with a marker,
// never silently dropped.
export const MAX_GIT_DIFF_SIZE = 4 * 1024 * 1024;

// Cap entries returned per directory listing to protect against huge dirs
// (e.g. node_modules). Beyond this, results are truncated with a flag.
export const MAX_DIR_ENTRIES = 300;

// Only used to prune search + watch (NOT the browser listing). Keeps slow
// generated/dep dirs out of full-tree scans and event floods.
export const IGNORED_DIRS = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  "__pycache__",
  ".cache",
  ".turbo",
  ".vercel",
  ".output",
  "out",
  ".nuxt",
  ".svelte-kit",
  "target",
  ".parcel-cache",
  ".rollup.cache"
];

export const BINARY_EXTENSIONS = [
  ".zip", ".tar", ".gz", ".tgz", ".rar", ".7z", ".bz2", ".xz",
  ".exe", ".dll", ".so", ".dylib", ".app", ".bin",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".sqlite", ".db", ".mdb",
  ".class", ".jar", ".war", ".pyc", ".o", ".obj"
];

// Extension -> MIME. Covers all previewable (image/video/audio/pdf) types.
export const MIME_BY_EXT = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", ico: "image/x-icon", bmp: "image/bmp",
  avif: "image/avif", apng: "image/apng", tif: "image/tiff", tiff: "image/tiff",
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", ogv: "video/ogg",
  mov: "video/quicktime", mkv: "video/x-matroska", avi: "video/x-msvideo", "3gp": "video/3gpp",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg",
  flac: "audio/flac", m4a: "audio/mp4", aac: "audio/aac", opus: "audio/opus",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  csv: "text/csv", tsv: "text/tab-separated-values"
};

export function getMimeType(filePath) {
  const ext = filePath.toLowerCase().split(".").pop();
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

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

export function hasExt(filePath, exts) {
  if (!filePath) return false;
  const lower = filePath.toLowerCase();
  return exts.some((e) => lower.endsWith(e));
}
export const isImageFile = (p) => hasExt(p, IMAGE_EXTENSIONS);
// Static raster formats the stream path re-encodes server-side (client decodes a
// bounded bitmap instead of a full-res one that can OOM-kill mobile WebKit).
// Animated/vector/ico formats stream raw — small, or lossy to convert.
export const STREAM_SCALE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".avif"];
export const isStreamScalableImage = (p) => hasExt(p, STREAM_SCALE_EXTENSIONS);
export const isVideoFile = (p) => hasExt(p, VIDEO_EXTENSIONS);
export const isAudioFile = (p) => hasExt(p, AUDIO_EXTENSIONS);
export const isPdfFile = (p) => hasExt(p, PDF_EXTENSIONS);
export const isPreviewableFile = (p) =>
  isImageFile(p) || isVideoFile(p) || isAudioFile(p) || isPdfFile(p);

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

// Blacklist sensitive paths (relative to home dir, or absolute system paths)
export const SENSITIVE_HOME_DIRS = [
  ".ssh", ".aws", ".gnupg", ".kube", ".docker", ".cargo",
  ".npmrc", ".netrc", ".pypirc", ".config/gh", ".config/gcloud"
];
export const SENSITIVE_ABS_PATHS = [
  "/etc/shadow", "/etc/sudoers", "/etc/ssh", "/root", "/private/etc/sudoers"
];
