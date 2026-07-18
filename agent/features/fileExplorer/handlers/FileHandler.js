import fs from "fs";
import path from "path";
import os from "os";
import { execSync, spawn } from "child_process";
import chokidar from "chokidar";
import { IGNORED_DIRS, BINARY_EXTENSIONS, MAX_FILE_SIZE, MAX_MEDIA_SIZE, MAX_SEARCH_RESULTS, MAX_MATCHES_PER_FILE, DEFAULT_TREE_DEPTH } from "../constants.js";
import { isSensitivePath } from "../pathGuard.js";

// Extension -> MIME. Covers all previewable (image/video/audio/pdf) types.
const MIME_BY_EXT = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", ico: "image/x-icon", bmp: "image/bmp",
  avif: "image/avif", apng: "image/apng", tif: "image/tiff", tiff: "image/tiff",
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", ogv: "video/ogg",
  mov: "video/quicktime", mkv: "video/x-matroska", avi: "video/x-msvideo", "3gp": "video/3gpp",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg",
  flac: "audio/flac", m4a: "audio/mp4", aac: "audio/aac", opus: "audio/opus",
  pdf: "application/pdf"
};

function isIgnoredDir(name) { return IGNORED_DIRS.includes(name); }
function isBinaryFile(filename) {
  return BINARY_EXTENSIONS.includes(path.extname(filename).toLowerCase());
}
function getFileType(stat, filename) {
  if (stat.isDirectory()) return "folder";
  if (isBinaryFile(filename)) return "binary";
  return "file";
}
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function searchFilesRecursive(dir, query, results, maxResults = 50) {
  if (results.length >= maxResults) return;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (results.length >= maxResults) return;
      if (name.startsWith(".") || isIgnoredDir(name)) continue;
      const fullPath = path.join(dir, name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          searchFilesRecursive(fullPath, query, results, maxResults);
        } else if (name.toLowerCase().includes(query.toLowerCase())) {
          results.push({ name, path: fullPath, type: isBinaryFile(name) ? "binary" : "file", size: stat.size, sizeFormatted: formatSize(stat.size) });
        }
      } catch {}
    }
  } catch {}
}

function globToRegex(glob) {
  if (!glob) return null;
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "::ANY::").replace(/\*/g, "[^/]*").replace(/::ANY::/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

function searchInFilesRecursive(dir, baseDir, matcher, includeRe, excludeRe, results) {
  if (results.length >= MAX_SEARCH_RESULTS) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (results.length >= MAX_SEARCH_RESULTS) return;
    if (isIgnoredDir(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    const rel = path.relative(baseDir, fullPath);
    if (entry.isDirectory()) {
      searchInFilesRecursive(fullPath, baseDir, matcher, includeRe, excludeRe, results);
      continue;
    }
    if (!entry.isFile()) continue;
    if (isBinaryFile(entry.name)) continue;
    if (isSensitivePath(fullPath)) continue;
    if (excludeRe && excludeRe.test(rel)) continue;
    if (includeRe && !includeRe.test(rel)) continue;
    try {
      const stat = fs.statSync(fullPath);
      if (stat.size > MAX_FILE_SIZE) continue;
      const content = fs.readFileSync(fullPath, "utf-8");
      const lines = content.split("\n");
      const matches = [];
      for (let i = 0; i < lines.length && matches.length < MAX_MATCHES_PER_FILE; i++) {
        const line = lines[i];
        const found = matcher(line);
        for (const m of found) {
          if (matches.length >= MAX_MATCHES_PER_FILE) break;
          matches.push({ line: i + 1, column: m.column + 1, lineText: line, matchLength: m.length });
        }
      }
      if (matches.length) results.push({ path: fullPath, matches });
    } catch {}
  }
}

function buildFileTree(dir, depth, showHidden) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const children = [];
  for (const entry of entries) {
    if (!showHidden && entry.name.startsWith(".") && entry.name !== ".env" && entry.name !== ".env.example") continue;
    if (isIgnoredDir(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const node = { name: entry.name, path: fullPath, type: "folder" };
      if (depth > 0) node.children = buildFileTree(fullPath, depth - 1, showHidden);
      children.push(node);
    } else if (entry.isFile()) {
      children.push({ name: entry.name, path: fullPath, type: isBinaryFile(entry.name) ? "binary" : "file" });
    }
  }
  children.sort((a, b) => {
    if (a.type === "folder" && b.type !== "folder") return -1;
    if (a.type !== "folder" && b.type === "folder") return 1;
    return a.name.localeCompare(b.name);
  });
  return children;
}

function getWindowsDrives() {
  if (process.platform !== "win32") return [];
  try {
    const result = execSync("wmic logicaldisk get name", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    return result.split(/\r?\n/).map(l => l.trim()).filter(l => /^[A-Z]:$/.test(l)).map(d => ({ letter: d[0], path: d + "\\" }));
  } catch {
    return "CDEFGHIJ".split("").map(l => `${l}:\\`).filter(p => fs.existsSync(p)).map(p => ({ letter: p[0], path: p }));
  }
}

export function setupFileHandlers(socket) {
  socket.on("getSystemInfo", (callback) => {
    const platform = process.platform;
    callback({ success: true, platform, isWindows: platform === "win32", drives: platform === "win32" ? getWindowsDrives() : [], homedir: os.homedir() });
  });

  socket.on("getFiles", ({ dirPath, showHidden }, callback) => {
    try {
      const targetPath = dirPath || os.homedir();
      const resolvedPath = targetPath.startsWith("~") ? targetPath.replace("~", os.homedir()) : targetPath;
      if (isSensitivePath(resolvedPath)) return callback({ success: false, error: "Access denied" });
      if (!fs.existsSync(resolvedPath)) return callback({ success: false, error: "Directory not found" });

      const files = [];
      for (const name of fs.readdirSync(resolvedPath)) {
        if (!showHidden && name.startsWith(".") && name !== ".env" && name !== ".env.example") continue;
        if (isIgnoredDir(name)) continue;
        try {
          const fullPath = path.join(resolvedPath, name);
          const stat = fs.statSync(fullPath);
          files.push({ name, path: fullPath, type: getFileType(stat, name), size: stat.isFile() ? stat.size : null, sizeFormatted: stat.isFile() ? formatSize(stat.size) : null, modified: stat.mtime.getTime() });
        } catch {}
      }

      files.sort((a, b) => {
        if (a.type === "folder" && b.type !== "folder") return -1;
        if (a.type !== "folder" && b.type === "folder") return 1;
        return a.name.localeCompare(b.name);
      });

      callback({ success: true, files, currentPath: resolvedPath, parentPath: path.dirname(resolvedPath) });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  socket.on("searchFiles", ({ workspace, query }, callback) => {
    try {
      if (!query || query.length < 2) return callback({ success: true, files: [] });
      const resolvedPath = (workspace || os.homedir()).replace(/^~/, os.homedir());
      if (!fs.existsSync(resolvedPath)) return callback({ success: false, error: "Workspace not found" });

      const results = [];
      searchFilesRecursive(resolvedPath, query, results, 50);
      results.sort((a, b) => {
        const aExact = a.name.toLowerCase() === query.toLowerCase();
        const bExact = b.name.toLowerCase() === query.toLowerCase();
        if (aExact && !bExact) return -1;
        if (!aExact && bExact) return 1;
        return a.path.length - b.path.length;
      });
      callback({ success: true, files: results });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  socket.on("readFile", ({ filePath }, callback) => {
    try {
      if (isSensitivePath(filePath)) return callback({ success: false, error: "Access denied" });
      if (!fs.existsSync(filePath)) return callback({ success: false, error: "File not found" });
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_FILE_SIZE) return callback({ success: false, error: `File too large (${formatSize(stat.size)}). Max ${formatSize(MAX_FILE_SIZE)}` });
      if (isBinaryFile(filePath)) return callback({ success: false, error: "Cannot open binary file" });
      callback({ success: true, content: fs.readFileSync(filePath, "utf-8") });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  // Previewable media (image/video/audio/pdf) as a data URL. Used by every viewer
  // so they share one size cap and MIME table. readImage kept as a back-compat alias.
  socket.on("readMedia", ({ filePath }, callback) => {
    try {
      if (isSensitivePath(filePath)) return callback({ success: false, error: "Access denied" });
      if (!fs.existsSync(filePath)) return callback({ success: false, error: "File not found" });
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_MEDIA_SIZE) return callback({ success: false, error: `File too large (${formatSize(stat.size)}). Max ${formatSize(MAX_MEDIA_SIZE)}` });
      const ext = path.extname(filePath).toLowerCase().slice(1);
      const mime = MIME_BY_EXT[ext] || "application/octet-stream";
      const buffer = fs.readFileSync(filePath);
      const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;
      callback({ success: true, dataUrl, size: stat.size, mime });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  // readImage: back-compat alias for callers still on the old event name.
  socket.on("readImage", ({ filePath }, callback) => {
    try {
      if (isSensitivePath(filePath)) return callback({ success: false, error: "Access denied" });
      if (!fs.existsSync(filePath)) return callback({ success: false, error: "File not found" });
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_MEDIA_SIZE) return callback({ success: false, error: `Image too large (${formatSize(stat.size)})` });
      const ext = path.extname(filePath).toLowerCase().slice(1);
      const mime = MIME_BY_EXT[ext] || "application/octet-stream";
      const buffer = fs.readFileSync(filePath);
      const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;
      callback({ success: true, dataUrl, size: stat.size, mime });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  socket.on("writeFile", ({ filePath, content }, callback) => {
    try {
      if (isSensitivePath(filePath)) return callback({ success: false, error: "Access denied" });
      fs.writeFileSync(filePath, content, "utf-8");
      callback({ success: true });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  socket.on("createItem", ({ itemPath, type }, callback) => {
    try {
      if (isSensitivePath(itemPath)) return callback({ success: false, error: "Access denied" });
      if (fs.existsSync(itemPath)) return callback({ success: false, error: "Item already exists" });
      type === "folder" ? fs.mkdirSync(itemPath, { recursive: true }) : fs.writeFileSync(itemPath, "", "utf-8");
      callback({ success: true });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  socket.on("deleteItem", ({ itemPath }, callback) => {
    try {
      if (isSensitivePath(itemPath)) return callback({ success: false, error: "Access denied" });
      if (!fs.existsSync(itemPath)) return callback({ success: false, error: "Item not found" });
      const stat = fs.statSync(itemPath);
      stat.isDirectory() ? fs.rmSync(itemPath, { recursive: true }) : fs.unlinkSync(itemPath);
      callback({ success: true });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  socket.on("renameItem", ({ oldPath, newPath }, callback) => {
    try {
      if (isSensitivePath(oldPath) || isSensitivePath(newPath)) return callback({ success: false, error: "Access denied" });
      if (!fs.existsSync(oldPath)) return callback({ success: false, error: "Item not found" });
      if (fs.existsSync(newPath)) return callback({ success: false, error: "Target already exists" });
      fs.renameSync(oldPath, newPath);
      callback({ success: true });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  socket.on("searchInFiles", ({ workspace, query, caseSensitive, regex, includeGlob, excludeGlob }, callback) => {
    try {
      if (!query) return callback({ success: true, results: [] });
      const resolvedPath = (workspace || os.homedir()).replace(/^~/, os.homedir());
      if (!fs.existsSync(resolvedPath)) return callback({ success: false, error: "Workspace not found" });

      let matcher;
      if (regex) {
        let re;
        try { re = new RegExp(query, caseSensitive ? "g" : "gi"); } catch (e) { return callback({ success: false, error: `Invalid regex: ${e.message}` }); }
        matcher = (line) => {
          const out = []; let m;
          re.lastIndex = 0;
          while ((m = re.exec(line)) !== null) {
            out.push({ column: m.index, length: m[0].length });
            if (m.index === re.lastIndex) re.lastIndex++;
          }
          return out;
        };
      } else {
        const needle = caseSensitive ? query : query.toLowerCase();
        matcher = (line) => {
          const hay = caseSensitive ? line : line.toLowerCase();
          const out = []; let idx = 0;
          while ((idx = hay.indexOf(needle, idx)) !== -1) {
            out.push({ column: idx, length: needle.length });
            idx += needle.length || 1;
          }
          return out;
        };
      }

      const includeRe = globToRegex(includeGlob);
      const excludeRe = globToRegex(excludeGlob);
      const results = [];
      searchInFilesRecursive(resolvedPath, resolvedPath, matcher, includeRe, excludeRe, results);
      callback({ success: true, results });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  socket.on("replaceInFiles", ({ workspace, query, replacement, caseSensitive, regex, files }, callback) => {
    try {
      if (!query || !Array.isArray(files) || !files.length) return callback({ success: true, replacedCount: 0, fileCount: 0 });

      let replaceFn;
      if (regex) {
        let re;
        try { re = new RegExp(query, caseSensitive ? "g" : "gi"); } catch (e) { return callback({ success: false, error: `Invalid regex: ${e.message}` }); }
        replaceFn = (content) => {
          let count = 0;
          const next = content.replace(re, (m) => { count++; return replacement; });
          return { next, count };
        };
      } else {
        replaceFn = (content) => {
          let count = 0;
          const flags = caseSensitive ? "g" : "gi";
          const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const re = new RegExp(escaped, flags);
          const next = content.replace(re, () => { count++; return replacement; });
          return { next, count };
        };
      }

      let replacedCount = 0, fileCount = 0;
      for (const filePath of files) {
        try {
          if (!fs.existsSync(filePath)) continue;
          if (isBinaryFile(filePath)) continue;
          if (isSensitivePath(filePath)) continue;
          const stat = fs.statSync(filePath);
          if (!stat.isFile() || stat.size > MAX_FILE_SIZE) continue;
          const content = fs.readFileSync(filePath, "utf-8");
          const { next, count } = replaceFn(content);
          if (count > 0) {
            fs.writeFileSync(filePath, next, "utf-8");
            replacedCount += count;
            fileCount++;
          }
        } catch {}
      }
      callback({ success: true, replacedCount, fileCount });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  // Ref-counted per path: multiple panes share one chokidar watcher; closed only when last unwatches
  const watchers = new Map();

  socket.on("watchDir", ({ dirPath }, callback) => {
    try {
      if (!dirPath || !fs.existsSync(dirPath)) return callback({ success: false, error: "Directory not found" });
      const existing = watchers.get(dirPath);
      if (existing) { existing.count++; return callback({ success: true }); }
      const w = chokidar.watch(dirPath, { depth: 0, ignoreInitial: true, persistent: true, ignored: (p) => IGNORED_DIRS.includes(path.basename(p)) });
      const emit = (type) => (p) => socket.emit("fileChange", { type, path: p });
      w.on("add", emit("add")).on("change", emit("change")).on("unlink", emit("unlink")).on("addDir", emit("addDir")).on("unlinkDir", emit("unlinkDir"));
      watchers.set(dirPath, { w, count: 1 });
      callback({ success: true });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  socket.on("unwatchDir", ({ dirPath }, callback) => {
    try {
      const entry = watchers.get(dirPath);
      if (entry && --entry.count <= 0) { entry.w.close(); watchers.delete(dirPath); }
      callback({ success: true });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  socket.once("disconnect", () => {
    for (const { w } of watchers.values()) { try { w.close(); } catch {} }
    watchers.clear();
  });

  socket.on("revealInOS", ({ filePath }, callback) => {
    try {
      if (!filePath) return callback({ success: false, error: "No path" });
      const platform = process.platform;
      let cmd, args;
      if (platform === "darwin") { cmd = "open"; args = ["-R", filePath]; }
      else if (platform === "win32") { cmd = "explorer"; args = [`/select,${filePath}`]; }
      else { cmd = "xdg-open"; args = [path.dirname(filePath)]; }
      const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
      child.on("error", (e) => callback({ success: false, error: e.message }));
      child.unref();
      callback({ success: true });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  socket.on("openInTerminal", ({ dirPath }, callback) => {
    try {
      if (!dirPath || !fs.existsSync(dirPath)) return callback({ success: false, error: "Directory not found" });
      const platform = process.platform;
      let cmd, args, opts = { detached: true, stdio: "ignore", windowsHide: true };
      if (platform === "darwin") { cmd = "open"; args = ["-a", "Terminal", dirPath]; }
      else if (platform === "win32") { cmd = "cmd"; args = ["/C", "start", "\"9Remote\"", "cmd", "/K"]; opts.shell = false; opts.cwd = dirPath; }
      else { cmd = "gnome-terminal"; args = ["--working-directory", dirPath]; }
      const child = spawn(cmd, args, opts);
      child.on("error", () => {
        if (platform === "linux") {
          const fb = spawn("xterm", ["-e", "bash"], { ...opts, cwd: dirPath });
          fb.on("error", (e) => callback({ success: false, error: e.message }));
          fb.unref();
        } else {
          callback({ success: false, error: "Failed to open terminal" });
        }
      });
      child.unref();
      callback({ success: true });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  socket.on("getFileTree", ({ dirPath, depth, showHidden }, callback) => {
    try {
      const resolvedPath = (dirPath || os.homedir()).replace(/^~/, os.homedir());
      if (!fs.existsSync(resolvedPath)) return callback({ success: false, error: "Directory not found" });
      const d = typeof depth === "number" ? depth : DEFAULT_TREE_DEPTH;
      const children = buildFileTree(resolvedPath, d, !!showHidden);
      callback({ success: true, tree: { name: path.basename(resolvedPath) || resolvedPath, path: resolvedPath, type: "folder", children } });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });
}
