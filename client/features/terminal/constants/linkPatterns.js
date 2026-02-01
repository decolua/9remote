// Supported file extensions for link detection
const FILE_EXTENSIONS = [
  "js", "jsx", "ts", "tsx",
  "css", "json", "md", "txt",
  "html", "xml", "yaml", "yml",
  "sh", "py", "rb", "go",
  "java", "c", "cpp", "h"
];

// Build extensions pattern for regex (js|jsx|ts|...)
const extensionsPattern = FILE_EXTENSIONS.join("|");

// Link type constants
export const LINK_TYPES = {
  WEB: "web",
  FILE_ABSOLUTE: "file_absolute",
  FILE_RELATIVE: "file_relative"
};

// Regex patterns for different link types
export const LINK_PATTERNS = {
  // Matches http:// or https:// URLs
  WEB_HTTP: /https?:\/\/[^\s]+/g,
  
  // Matches localhost with port (e.g., localhost:3000, localhost:8080/path)
  WEB_LOCALHOST: /localhost:\d+[^\s]*/g,
  
  // Matches absolute file paths (e.g., /path/to/file.js)
  FILE_ABSOLUTE: new RegExp(`\\/[^\\s:]+\\.(${extensionsPattern})\\b`, "g"),
  
  // Matches relative file paths (e.g., ./file.js, ../file.js, src/file.js)
  FILE_RELATIVE: new RegExp(`(?:\\.{1,2}\\/)?[^\\s:/]+(?:\\/[^\\s:/]+)*\\.(${extensionsPattern})\\b`, "g"),
  
  // Matches file paths with line numbers (e.g., file.js:123 or file.js:123:45)
  FILE_WITH_LINE: new RegExp(`[^\\s]+\\.(${extensionsPattern}):\\d+(?::\\d+)?`, "g"),
  
  // Matches git status modified pattern (e.g., modified: src/file.js)
  GIT_MODIFIED: /modified:\s+[^\s]+/g
};
