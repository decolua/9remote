import fs from "fs";
import path from "path";
import { spawn, spawnSync, execSync } from "child_process";
import { BINARY_EXTENSIONS, MAX_FILE_SIZE, DEFAULT_GIT_LOG_LIMIT, MAX_GIT_OUTPUT_SIZE, MAX_GIT_DIFF_SIZE } from "../constants.js";
import { isSensitivePath } from "../pathGuard.js";
import {
  scanReposCached, invalidateRepoScan, parseWorktreeList, parseBranchList, terminalsInWorktree
} from "../gitRepoScan.js";
import { listSessionRoots } from "../../terminal/terminalSocket.js";

// Per-cwd TTL cache for gitChangedCount badge — prevents repeated git spawns on
// rapid requests (e.g. terminal typing re-rendering the file watcher effect).
const GIT_COUNT_TTL_MS = 5000;
const _countCache = new Map(); // repoPath → { ts, value, pending }

// Changed-file count for one repo, TTL-cached and de-duplicated: a spawn already in
// flight is awaited rather than repeated.
async function changedCountCached(repoPath) {
  const cached = _countCache.get(repoPath);
  const now = Date.now();
  if (cached && now - cached.ts < GIT_COUNT_TTL_MS) return cached.value;
  if (cached?.pending) {
    try { return await cached.pending; } catch { return { success: false }; }
  }
  const pending = runGit(["status", "--porcelain", "--no-renames", "-uall"], repoPath).then((r) => {
    const value = r.code === 0
      ? { success: true, count: r.stdout.trim() ? r.stdout.trim().split("\n").length : 0 }
      : { success: false, error: "Not a git repository or git not available" };
    _countCache.set(repoPath, { ts: Date.now(), value, pending: null });
    return value;
  }).catch(() => ({ success: false }));
  _countCache.set(repoPath, { ts: now, value: { success: false }, pending });
  try { return await pending; } catch { return { success: false }; }
}

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
  const r = spawnSync("git", args, {
    cwd, encoding: "utf-8", windowsHide: true, maxBuffer: MAX_GIT_OUTPUT_SIZE
  });
  // ENOBUFS means the output was cut mid-diff — returning it would look like a smaller
  // change set rather than a failure, so it has to surface.
  if (r.error) throw r.error;
  return r.stdout ?? "";
}

function isBinaryFile(filename) {
  return BINARY_EXTENSIONS.includes(path.extname(filename).toLowerCase());
}

// Accepts a path either relative to the repo or absolute inside it, and always yields the
// repo-relative form git expects. A path outside the repo is left alone so git rejects it
// rather than this silently rewriting it.
function toRepoRelative(repoPath, file) {
  if (!file || !repoPath || !path.isAbsolute(file)) return file;
  const rel = path.relative(repoPath, file);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return file;
  return rel.split(path.sep).join("/");
}

// A diff too large to render is truncated with a visible marker — never dropped, which
// the UI would show as "no changes".
function capDiff(diff) {
  if (diff.length <= MAX_GIT_DIFF_SIZE) return diff;
  return `${diff.slice(0, MAX_GIT_DIFF_SIZE)}\n\n... diff truncated (over ${Math.round(MAX_GIT_DIFF_SIZE / 1024 / 1024)}MB)`;
}

export function setupGitHandlers(socket) {
  socket.on("gitStatus", ({ repoPath }, callback) => {
    try {
      // -uall: without it git collapses an untracked directory into one entry, which the
      // UI then opens as a file (EISDIR) and counts as zero added lines.
      const result = execSync("git status --porcelain --no-renames -uall", {
        cwd: repoPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], windowsHide: true
      });

      // Get diff stats for tracked files
      let diffStats = {};
      try {
        const statResult = execSync("git diff HEAD --numstat --no-renames", {
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
        // git wraps paths with special chars in double quotes; strip them.
        // Trim trailing CR (CRLF output) / whitespace that breaks path joins.
        let filePath = match[2].replace(/\r+$/, "").trim();
        if (filePath.startsWith('"') && filePath.endsWith('"')) filePath = filePath.slice(1, -1);
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
    callback(await changedCountCached(repoPath));
  });

  // One number for the whole workspace: the root repo plus every repo under it, so the
  // terminal badge and the git panel can never disagree. Shares the per-repo TTL cache
  // with gitChangedCount/gitScanRepos, so polling this costs nothing extra.
  socket.on("gitWorkspaceChangedCount", async ({ rootPath, maxDepth }, callback) => {
    if (!rootPath) return callback({ success: false, error: "rootPath required" });
    if (isSensitivePath(rootPath)) return callback({ success: false, error: "Access denied" });
    try {
      const found = scanReposCached(rootPath, maxDepth ? { maxDepth } : {});
      const results = await Promise.all(found.map(async (repo) => [repo.path, await changedCountCached(repo.path)]));
      const perRepo = {};
      let count = 0;
      for (const [repoPath, res] of results) {
        if (!res.success) continue;
        perRepo[repoPath] = res.count;
        count += res.count;
      }
      callback({ success: true, count, perRepo });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
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

  socket.on("gitDiff", ({ repoPath, file: rawFile, status }, callback) => {
    try {
      let diff = "";
      // Callers hand this over either way: the git panel sends a repo-relative path, the
      // mobile editor an absolute one. Joining an absolute path onto the repo would point
      // at /repo/repo/file and read as an empty diff.
      const file = toRepoRelative(repoPath, rawFile);

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

        const statusResult = runGitSync(["status", "--porcelain", "--no-renames", "-uall"], repoPath);
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

      callback({ success: true, diff: capDiff(diff) });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  socket.on("gitBranch", async ({ repoPath }, callback) => {
    try {
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
    } catch (error) {
      callback({ success: false, error: error.message });
    }
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

  // ---- Nested repos ----

  // Repos at or under a workspace root. Bounded by depth + wall clock and memoized per
  // root inside gitRepoScan, so expanding the tree never re-walks the disk.
  socket.on("gitScanRepos", async ({ rootPath, maxDepth }, callback) => {
    if (!rootPath) return callback({ success: false, error: "rootPath required" });
    if (isSensitivePath(rootPath)) return callback({ success: false, error: "Access denied" });
    try {
      const found = scanReposCached(rootPath, maxDepth ? { maxDepth } : {});
      // Branch + change count per repo, in parallel — a monorepo can hold a dozen.
      const repos = await Promise.all(found.map(async (repo) => {
        const [branchRes, countRes] = await Promise.all([
          runGit(["branch", "--show-current"], repo.path),
          changedCountCached(repo.path)
        ]);
        return {
          ...repo,
          name: path.basename(repo.path),
          branch: branchRes.code === 0 ? branchRes.stdout.trim() || null : null,
          changedCount: countRes.success ? countRes.count : 0
        };
      }));
      callback({ success: true, repos });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  socket.on("gitRefreshRepos", ({ rootPath }, callback) => {
    invalidateRepoScan(rootPath);
    callback?.({ success: true });
  });

  // ---- Worktrees ----

  socket.on("gitWorktreeList", async ({ repoPath }, callback) => {
    try {
      const r = await runGit(["worktree", "list", "--porcelain"], repoPath);
      if (r.code !== 0) return callback({ success: false, error: r.stderr.trim() });
      callback({ success: true, worktrees: parseWorktreeList(r.stdout) });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  socket.on("gitWorktreeAdd", async ({ repoPath, worktreePath, branch, newBranch }, callback) => {
    if (!worktreePath || !branch) return callback({ success: false, error: "worktreePath and branch required" });
    if (isSensitivePath(worktreePath)) return callback({ success: false, error: "Access denied" });
    try {
      const args = newBranch
        ? ["worktree", "add", "-b", branch, worktreePath]
        : ["worktree", "add", worktreePath, branch];
      const r = await runGit(args, repoPath);
      if (r.code !== 0) return callback({ success: false, error: r.stderr.trim() });
      invalidateRepoScan(repoPath);
      callback({ success: true, path: path.resolve(worktreePath) });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  // Refuses while terminals are still rooted inside, unless the client confirms — pulling
  // the directory out from under a running shell is not something to do silently.
  socket.on("gitWorktreeRemove", async ({ repoPath, worktreePath, force, confirmed }, callback) => {
    if (!worktreePath) return callback({ success: false, error: "worktreePath required" });
    if (isSensitivePath(worktreePath)) return callback({ success: false, error: "Access denied" });
    try {
      const busy = terminalsInWorktree(worktreePath, listSessionRoots());
      if (busy.length && !confirmed) {
        return callback({ success: false, busy: busy.map((s) => ({ id: s.id, name: s.name })) });
      }
      const args = ["worktree", "remove", worktreePath];
      if (force) args.splice(2, 0, "--force");
      const r = await runGit(args, repoPath);
      if (r.code !== 0) return callback({ success: false, error: r.stderr.trim() });
      invalidateRepoScan(repoPath);
      callback({ success: true });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  // ---- Branches ----

  socket.on("gitBranchList", async ({ repoPath }, callback) => {
    try {
      const [branchRes, wtRes] = await Promise.all([
        runGit(["branch", "-a", "--format=%(refname)%09%(refname:short)%09%(upstream:short)%09%(HEAD)"], repoPath),
        runGit(["worktree", "list", "--porcelain"], repoPath)
      ]);
      if (branchRes.code !== 0) return callback({ success: false, error: branchRes.stderr.trim() });
      const worktrees = wtRes.code === 0 ? parseWorktreeList(wtRes.stdout) : [];
      callback({ success: true, branches: parseBranchList(branchRes.stdout, worktrees), worktrees });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  // A dirty tree makes git refuse the switch; surface its message verbatim rather than
  // reporting a generic failure the user cannot act on.
  socket.on("gitBranchCheckout", async ({ repoPath, branch, create }, callback) => {
    if (!branch) return callback({ success: false, error: "branch required" });
    try {
      const r = await runGit(create ? ["checkout", "-b", branch] : ["checkout", branch], repoPath);
      if (r.code !== 0) return callback({ success: false, error: r.stderr.trim() || r.stdout.trim() });
      callback({ success: true, branch });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });
}
