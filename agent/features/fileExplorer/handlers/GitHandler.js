import fs from "fs";
import path from "path";
import { spawn, spawnSync, execSync } from "child_process";
import { BINARY_EXTENSIONS, MAX_FILE_SIZE, DEFAULT_GIT_LOG_LIMIT } from "../constants.js";
import { isSensitivePath } from "../pathGuard.js";

// Per-cwd TTL cache for gitChangedCount badge — prevents repeated git spawns on
// rapid requests (e.g. terminal typing re-rendering the file watcher effect).
const GIT_COUNT_TTL_MS = 5000;
const _countCache = new Map(); // repoPath → { ts, value, pending }

export function runGit(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (e) => resolve({ code: -1, stdout, stderr: e.message }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// Sync no-shell git for legacy sync handlers. args is an argv array (never a template
// string) so socket-controlled paths cannot inject shell metacharacters.
export function runGitSync(args, cwd) {
  try {
    const r = spawnSync("git", args, { cwd, encoding: "utf-8", windowsHide: true });
    return r.stdout ?? "";
  } catch { return ""; }
}

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
            if (fs.existsSync(fullPath) && !isBinaryFile(filePath) && !isSensitivePath(fullPath)) {
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

  // Lightweight: only the count of changed files (badge), avoids sending the full list.
  // Async (runGit = spawn) + per-cwd TTL cache so rapid requests (e.g. typing) don't
  // spawn git repeatedly or block the event loop.
  socket.on("gitChangedCount", async ({ repoPath }, callback) => {
    const cached = _countCache.get(repoPath);
    const now = Date.now();
    if (cached && now - cached.ts < GIT_COUNT_TTL_MS) {
      callback(cached.value);
      return;
    }
    // A spawn is already in-flight for this cwd → await it instead of spawning again
    if (cached?.pending) {
      try { callback(await cached.pending); } catch { callback({ success: false }); }
      return;
    }
    const pending = runGit(["status", "--porcelain"], repoPath).then((r) => {
      const value = r.code === 0
        ? { success: true, count: r.stdout.trim() ? r.stdout.trim().split("\n").length : 0 }
        : { success: false, error: "Not a git repository or git not available" };
      _countCache.set(repoPath, { ts: Date.now(), value, pending: null });
      return value;
    }).catch(() => ({ success: false }));
    _countCache.set(repoPath, { ts: now, value: { success: false }, pending });
    try { callback(await pending); } catch { callback({ success: false }); }
  });

  socket.on("gitFileStatus", ({ repoPath, filePath }, callback) => {
    try {
      const relativePath = path.relative(repoPath, filePath);
      const result = runGitSync(["status", "--porcelain", "--", relativePath], repoPath);

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
        if (fs.existsSync(filePath) && !isSensitivePath(filePath)) {
          const content = fs.readFileSync(filePath, "utf-8");
          const lines = content.split("\n");
          diff = `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(l => `+${l}`).join("\n")}`;
        }
      } else if (file) {
        diff = runGitSync(["diff", "HEAD", "--", file], repoPath);
      } else {
        diff = runGitSync(["diff", "HEAD"], repoPath);

        const statusResult = runGitSync(["status", "--porcelain"], repoPath);
        const untrackedFiles = statusResult.trim().split("\n")
          .filter(line => line.startsWith("??"))
          .map(line => line.substring(3));

        for (const untrackedFile of untrackedFiles) {
          const filePath = path.join(repoPath, untrackedFile);
          if (fs.existsSync(filePath) && !isBinaryFile(untrackedFile) && !isSensitivePath(filePath)) {
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

  socket.on("gitBranch", async ({ repoPath }, callback) => {
    const r = await runGit(["branch", "--show-current"], repoPath);
    if (r.code !== 0) return callback({ success: false });
    const result = { success: true, branch: r.stdout.trim() };
    // ahead/behind upstream @{u}; absent upstream → null (still success).
    const ab = await runGit(["rev-list", "--left-right", "--count", "@{u}...HEAD"], repoPath);
    if (ab.code === 0) {
      const [behind, ahead] = ab.stdout.trim().split(/\s+/).map((n) => parseInt(n, 10));
      result.ahead = Number.isFinite(ahead) ? ahead : null;
      result.behind = Number.isFinite(behind) ? behind : null;
    } else {
      result.ahead = null;
      result.behind = null;
    }
    callback(result);
  });

  socket.on("gitAdd", async ({ repoPath, files }, callback) => {
    try {
      const list = Array.isArray(files) && files.length ? files : ["."];
      const r = await runGit(["add", "--", ...list], repoPath);
      if (r.code !== 0) return callback({ success: false, error: r.stderr.trim() });
      callback({ success: true });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  socket.on("gitReset", async ({ repoPath, files }, callback) => {
    try {
      const list = Array.isArray(files) && files.length ? files : ["."];
      const r = await runGit(["reset", "HEAD", "--", ...list], repoPath);
      callback({ success: r.code === 0, error: r.code === 0 ? undefined : r.stderr.trim() });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  socket.on("gitCommit", async ({ repoPath, message }, callback) => {
    try {
      if (!message) return callback({ success: false, error: "Empty message" });
      const r = await runGit(["commit", "-m", message], repoPath);
      const output = (r.stdout + r.stderr).trim();
      if (r.code !== 0) return callback({ success: false, output, error: r.stderr.trim() });
      callback({ success: true, output });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  socket.on("gitPush", async ({ repoPath }, callback) => {
    try {
      const r = await runGit(["push"], repoPath);
      const output = (r.stdout + r.stderr).trim();
      if (r.code !== 0) return callback({ success: false, output, error: r.stderr.trim() });
      callback({ success: true, output });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  socket.on("gitPull", async ({ repoPath }, callback) => {
    try {
      const r = await runGit(["pull"], repoPath);
      const output = (r.stdout + r.stderr).trim();
      if (r.code !== 0) return callback({ success: false, output, error: r.stderr.trim() });
      callback({ success: true, output });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  socket.on("gitLog", async ({ repoPath, limit }, callback) => {
    try {
      const n = typeof limit === "number" && limit > 0 ? limit : DEFAULT_GIT_LOG_LIMIT;
      const r = await runGit(["log", `-n`, String(n), "--pretty=format:%h%x09%s"], repoPath);
      if (r.code !== 0) return callback({ success: false, error: r.stderr.trim() });
      const commits = r.stdout.split("\n").filter(Boolean).map((line) => {
        const [hash, ...rest] = line.split("\t");
        return { hash, message: rest.join("\t") };
      });
      callback({ success: true, commits });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  socket.on("gitDiscard", ({ repoPath, file, status }, callback) => {
    try {
      if (!file) return callback({ success: false, error: "No file specified" });
      const filePath = path.join(repoPath, file);

      if (isSensitivePath(filePath)) return callback({ success: false, error: "Access denied" });

      if (status === "?") {
        if (fs.existsSync(filePath)) {
          const stat = fs.statSync(filePath);
          stat.isDirectory() ? fs.rmSync(filePath, { recursive: true }) : fs.unlinkSync(filePath);
        }
      } else if (status === "A") {
        runGitSync(["reset", "HEAD", "--", file], repoPath);
        if (fs.existsSync(filePath) && !isSensitivePath(filePath)) fs.unlinkSync(filePath);
      } else {
        runGitSync(["checkout", "HEAD", "--", file], repoPath);
      }

      callback({ success: true });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });
}
