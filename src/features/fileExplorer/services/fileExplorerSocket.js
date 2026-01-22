// File Explorer Socket.IO handler
import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { IGNORED_DIRS, BINARY_EXTENSIONS, MAX_FILE_SIZE } from "../constants/fileExplorer.js";

function isIgnoredDir(name) {
  return IGNORED_DIRS.includes(name);
}

function isBinaryFile(filename) {
  const ext = path.extname(filename).toLowerCase();
  return BINARY_EXTENSIONS.includes(ext);
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

export function setupFileExplorerSocket(io) {
  io.on("connection", (socket) => {
    // Get files in directory
    socket.on("getFiles", ({ dirPath }, callback) => {
      try {
        const targetPath = dirPath || os.homedir();
        const resolvedPath = dirPath?.startsWith("~") 
          ? dirPath.replace("~", os.homedir()) 
          : targetPath;

        if (!fs.existsSync(resolvedPath)) {
          callback({ success: false, error: "Directory not found" });
          return;
        }

        const items = fs.readdirSync(resolvedPath);
        const files = [];

        for (const name of items) {
          // Skip hidden files and ignored dirs
          if (name.startsWith(".") && name !== ".env" && name !== ".env.example") continue;
          if (isIgnoredDir(name)) continue;

          try {
            const fullPath = path.join(resolvedPath, name);
            const stat = fs.statSync(fullPath);

            files.push({
              name,
              path: fullPath,
              type: getFileType(stat, name),
              size: stat.isFile() ? stat.size : null,
              sizeFormatted: stat.isFile() ? formatSize(stat.size) : null,
              modified: stat.mtime.getTime()
            });
          } catch {
            // Skip files we can't stat
          }
        }

        // Sort: folders first, then by name
        files.sort((a, b) => {
          if (a.type === "folder" && b.type !== "folder") return -1;
          if (a.type !== "folder" && b.type === "folder") return 1;
          return a.name.localeCompare(b.name);
        });

        callback({ 
          success: true, 
          files, 
          currentPath: resolvedPath,
          parentPath: path.dirname(resolvedPath)
        });
      } catch (error) {
        callback({ success: false, error: error.message });
      }
    });

    // Read file content
    socket.on("readFile", ({ filePath }, callback) => {
      try {
        if (!fs.existsSync(filePath)) {
          callback({ success: false, error: "File not found" });
          return;
        }

        const stat = fs.statSync(filePath);

        if (stat.size > MAX_FILE_SIZE) {
          callback({ 
            success: false, 
            error: `File too large (${formatSize(stat.size)}). Max ${formatSize(MAX_FILE_SIZE)}` 
          });
          return;
        }

        if (isBinaryFile(filePath)) {
          callback({ success: false, error: "Cannot open binary file" });
          return;
        }

        const content = fs.readFileSync(filePath, "utf-8");
        callback({ success: true, content });
      } catch (error) {
        callback({ success: false, error: error.message });
      }
    });

    // Write file content
    socket.on("writeFile", ({ filePath, content }, callback) => {
      try {
        fs.writeFileSync(filePath, content, "utf-8");
        callback({ success: true });
      } catch (error) {
        callback({ success: false, error: error.message });
      }
    });

    // Create file or folder
    socket.on("createItem", ({ itemPath, type }, callback) => {
      try {
        if (fs.existsSync(itemPath)) {
          callback({ success: false, error: "Item already exists" });
          return;
        }

        if (type === "folder") {
          fs.mkdirSync(itemPath, { recursive: true });
        } else {
          fs.writeFileSync(itemPath, "", "utf-8");
        }

        callback({ success: true });
      } catch (error) {
        callback({ success: false, error: error.message });
      }
    });

    // Delete file or folder
    socket.on("deleteItem", ({ itemPath }, callback) => {
      try {
        if (!fs.existsSync(itemPath)) {
          callback({ success: false, error: "Item not found" });
          return;
        }

        const stat = fs.statSync(itemPath);
        if (stat.isDirectory()) {
          fs.rmSync(itemPath, { recursive: true });
        } else {
          fs.unlinkSync(itemPath);
        }

        callback({ success: true });
      } catch (error) {
        callback({ success: false, error: error.message });
      }
    });

    // Rename file or folder
    socket.on("renameItem", ({ oldPath, newPath }, callback) => {
      try {
        if (!fs.existsSync(oldPath)) {
          callback({ success: false, error: "Item not found" });
          return;
        }

        if (fs.existsSync(newPath)) {
          callback({ success: false, error: "Target already exists" });
          return;
        }

        fs.renameSync(oldPath, newPath);
        callback({ success: true });
      } catch (error) {
        callback({ success: false, error: error.message });
      }
    });

    // Git status
    socket.on("gitStatus", ({ repoPath }, callback) => {
      try {
        const result = execSync("git status --porcelain", {
          cwd: repoPath,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"] // Suppress stderr
        });

        // git status --porcelain format can vary:
        // "XY filename" where XY is 2 chars (index + worktree status)
        // But sometimes only shows "X filename" with 1 char
        // Use regex to parse: match status chars at start, then space, then filename
        const lines = result.trim().split("\n").filter(Boolean);
        const files = [];
        
        for (const line of lines) {
          // Match: 1-2 status chars, space(s), then filename
          const match = line.match(/^([MADRCU?! ]{1,2})\s+(.+)$/);
          
          if (!match) continue;
          
          const statusCode = match[1];
          const filePath = match[2];
          
          if (!filePath) continue;
          
          // Determine primary status to show
          let status;
          if (statusCode.includes("?")) {
            status = "?";
          } else if (statusCode.includes("A")) {
            status = "A";
          } else if (statusCode.includes("D")) {
            status = "D";
          } else if (statusCode.includes("M")) {
            status = "M";
          } else if (statusCode.includes("R")) {
            status = "R";
          } else {
            status = statusCode.trim()[0] || "?";
          }
          
          files.push({ status, path: filePath });
        }

        callback({ success: true, files });
      } catch (error) {
        callback({ success: false, error: "Not a git repository or git not available" });
      }
    });

    // Git diff - includes staged, unstaged, and untracked files
    socket.on("gitDiff", ({ repoPath, file, status }, callback) => {
      try {
        let diff = "";

        if (file && status === "?") {
          // Untracked file - show as new file diff
          const filePath = path.join(repoPath, file);
          if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, "utf-8");
            const lines = content.split("\n");
            diff = `diff --git a/${file} b/${file}
new file mode 100644
--- /dev/null
+++ b/${file}
@@ -0,0 +1,${lines.length} @@
${lines.map(line => `+${line}`).join("\n")}`;
          }
        } else if (file) {
          // Specific file - try both staged and unstaged
          const cmd = `git diff HEAD -- "${file}"`;
          diff = execSync(cmd, { cwd: repoPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
        } else {
          // All changes - staged + unstaged
          diff = execSync("git diff HEAD", { cwd: repoPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
          
          // Also get untracked files
          const statusResult = execSync("git status --porcelain", { cwd: repoPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
          const untrackedFiles = statusResult.trim().split("\n")
            .filter(line => line.startsWith("??"))
            .map(line => line.substring(3));

          for (const untrackedFile of untrackedFiles) {
            const filePath = path.join(repoPath, untrackedFile);
            if (fs.existsSync(filePath) && !isBinaryFile(untrackedFile)) {
              try {
                const stat = fs.statSync(filePath);
                if (stat.size <= MAX_FILE_SIZE) {
                  const content = fs.readFileSync(filePath, "utf-8");
                  const lines = content.split("\n");
                  diff += `\ndiff --git a/${untrackedFile} b/${untrackedFile}
new file mode 100644
--- /dev/null
+++ b/${untrackedFile}
@@ -0,0 +1,${lines.length} @@
${lines.map(line => `+${line}`).join("\n")}`;
                }
              } catch {
                // Skip files that can't be read
              }
            }
          }
        }

        callback({ success: true, diff });
      } catch (error) {
        callback({ success: false, error: error.message });
      }
    });
  });
}
