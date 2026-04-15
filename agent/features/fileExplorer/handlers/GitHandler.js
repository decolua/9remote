import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { BINARY_EXTENSIONS, MAX_FILE_SIZE } from "../constants.js";

function isBinaryFile(filename) {
  return BINARY_EXTENSIONS.includes(path.extname(filename).toLowerCase());
}

export function setupGitHandlers(socket) {
  socket.on("gitStatus", ({ repoPath }, callback) => {
    try {
      const result = execSync("git status --porcelain", {
        cwd: repoPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], windowsHide: true
      });

      // Get diff stats for tracked files
      let diffStats = {};
      try {
        const statResult = execSync("git diff HEAD --numstat", {
          cwd: repoPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], windowsHide: true
        });
        statResult.trim().split("\n").filter(Boolean).forEach(line => {
          const parts = line.split("\t");
          if (parts.length >= 3) {
            diffStats[parts[2]] = {
              added: parts[0] === "-" ? 0 : parseInt(parts[0], 10) || 0,
              deleted: parts[1] === "-" ? 0 : parseInt(parts[1], 10) || 0
            };
          }
        });
      } catch {}

      const files = [];
      for (const line of result.trim().split("\n").filter(Boolean)) {
        const match = line.match(/^([MADRCU?! ]{1,2})\s+(.+)$/);
        if (!match) continue;
        const statusCode = match[1];
        const filePath = match[2];
        if (!filePath) continue;

        let status;
        if (statusCode.includes("?")) status = "?";
        else if (statusCode.includes("A")) status = "A";
        else if (statusCode.includes("D")) status = "D";
        else if (statusCode.includes("M")) status = "M";
        else if (statusCode.includes("R")) status = "R";
        else status = statusCode.trim()[0] || "?";

        const stats = diffStats[filePath] || { added: 0, deleted: 0 };
        if (status === "?") {
          try {
            const fullPath = path.join(repoPath, filePath);
            if (fs.existsSync(fullPath) && !isBinaryFile(filePath)) {
              const content = fs.readFileSync(fullPath, "utf-8");
              stats.added = content.split("\n").length;
              stats.deleted = 0;
            }
          } catch {}
        }

        files.push({ status, path: filePath, added: stats.added, deleted: stats.deleted });
      }

      callback({ success: true, files });
    } catch {
      callback({ success: false, error: "Not a git repository or git not available" });
    }
  });

  socket.on("gitFileStatus", ({ repoPath, filePath }, callback) => {
    try {
      const relativePath = path.relative(repoPath, filePath);
      const result = execSync(`git status --porcelain -- "${relativePath}"`, {
        cwd: repoPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], windowsHide: true
      });

      const line = result.trim();
      if (!line) return callback({ success: true, status: null });

      const match = line.match(/^([MADRCU?! ]{1,2})\s+(.+)$/);
      if (!match) return callback({ success: true, status: null });

      const statusCode = match[1];
      let status;
      if (statusCode.includes("?")) status = "?";
      else if (statusCode.includes("A")) status = "A";
      else if (statusCode.includes("D")) status = "D";
      else if (statusCode.includes("M")) status = "M";
      else if (statusCode.includes("R")) status = "R";
      else status = statusCode.trim()[0] || "?";

      callback({ success: true, status, file: relativePath });
    } catch {
      callback({ success: true, status: null });
    }
  });

  socket.on("gitDiff", ({ repoPath, file, status }, callback) => {
    try {
      let diff = "";

      if (file && status === "?") {
        const filePath = path.join(repoPath, file);
        if (fs.existsSync(filePath)) {
          const content = fs.readFileSync(filePath, "utf-8");
          const lines = content.split("\n");
          diff = `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(l => `+${l}`).join("\n")}`;
        }
      } else if (file) {
        diff = execSync(`git diff HEAD -- "${file}"`, { cwd: repoPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      } else {
        diff = execSync("git diff HEAD", { cwd: repoPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

        const statusResult = execSync("git status --porcelain", { cwd: repoPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
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
                diff += `\ndiff --git a/${untrackedFile} b/${untrackedFile}\nnew file mode 100644\n--- /dev/null\n+++ b/${untrackedFile}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(l => `+${l}`).join("\n")}`;
              }
            } catch {}
          }
        }
      }

      callback({ success: true, diff });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  socket.on("gitDiscard", ({ repoPath, file, status }, callback) => {
    try {
      if (!file) return callback({ success: false, error: "No file specified" });
      const filePath = path.join(repoPath, file);

      if (status === "?") {
        if (fs.existsSync(filePath)) {
          const stat = fs.statSync(filePath);
          stat.isDirectory() ? fs.rmSync(filePath, { recursive: true }) : fs.unlinkSync(filePath);
        }
      } else if (status === "A") {
        execSync(`git reset HEAD -- "${file}"`, { cwd: repoPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } else {
        execSync(`git checkout HEAD -- "${file}"`, { cwd: repoPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      }

      callback({ success: true });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });
}
