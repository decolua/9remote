import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { IGNORED_DIRS, BINARY_EXTENSIONS, MAX_FILE_SIZE } from "../constants.js";

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

  socket.on("getFiles", ({ dirPath }, callback) => {
    try {
      const targetPath = dirPath || os.homedir();
      const resolvedPath = targetPath.startsWith("~") ? targetPath.replace("~", os.homedir()) : targetPath;
      if (!fs.existsSync(resolvedPath)) return callback({ success: false, error: "Directory not found" });

      const files = [];
      for (const name of fs.readdirSync(resolvedPath)) {
        if (name.startsWith(".") && name !== ".env" && name !== ".env.example") continue;
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
      if (!fs.existsSync(filePath)) return callback({ success: false, error: "File not found" });
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_FILE_SIZE) return callback({ success: false, error: `File too large (${formatSize(stat.size)}). Max ${formatSize(MAX_FILE_SIZE)}` });
      if (isBinaryFile(filePath)) return callback({ success: false, error: "Cannot open binary file" });
      callback({ success: true, content: fs.readFileSync(filePath, "utf-8") });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  socket.on("writeFile", ({ filePath, content }, callback) => {
    try {
      fs.writeFileSync(filePath, content, "utf-8");
      callback({ success: true });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  socket.on("createItem", ({ itemPath, type }, callback) => {
    try {
      if (fs.existsSync(itemPath)) return callback({ success: false, error: "Item already exists" });
      type === "folder" ? fs.mkdirSync(itemPath, { recursive: true }) : fs.writeFileSync(itemPath, "", "utf-8");
      callback({ success: true });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  socket.on("deleteItem", ({ itemPath }, callback) => {
    try {
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
      if (!fs.existsSync(oldPath)) return callback({ success: false, error: "Item not found" });
      if (fs.existsSync(newPath)) return callback({ success: false, error: "Target already exists" });
      fs.renameSync(oldPath, newPath);
      callback({ success: true });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });
}
