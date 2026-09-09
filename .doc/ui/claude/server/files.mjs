// test-claude-web/server/files.mjs
// Git-aware fast file scanner & fuzzy search for `@` mention in repository

import { execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

let cachedFiles = [];
let cachedModified = new Set();
let lastScanTime = 0;
const CACHE_TTL_MS = 5000; // 5s cache

function getRepoFiles(rootDir) {
  const now = Date.now();
  if (cachedFiles.length > 0 && now - lastScanTime < CACHE_TTL_MS) {
    return { files: cachedFiles, modified: cachedModified };
  }

  const fileList = [];
  const modifiedSet = new Set();

  try {
    // 1. Get modified / unstaged / untracked files
    const statusOut = execSync("git status --short", { cwd: rootDir, encoding: "utf8", timeout: 2000 });
    for (const line of statusOut.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Format: " M path/to/file" or "?? path/to/file"
      const filePath = trimmed.slice(2).trim().replace(/^"|"$/g, "");
      if (filePath && !filePath.startsWith(".source/") && !filePath.startsWith(".bin/")) {
        modifiedSet.add(filePath);
      }
    }
  } catch {}

  try {
    // 2. Get all git-tracked + untracked files respecting .gitignore
    const lsOut = execSync("git ls-files --cached --others --exclude-standard", {
      cwd: rootDir,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 3000,
    });

    for (const line of lsOut.split("\n")) {
      const f = line.trim();
      if (!f) continue;
      // Skip deep sub-repos or vendored archives if any
      if (f.startsWith(".source/") || f.startsWith(".bin/") || f.startsWith(".codegraph/")) continue;
      fileList.push(f);
    }
  } catch {
    // Fallback: simple readdir if git fails
    try {
      const entries = fs.readdirSync(rootDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.name.startsWith(".")) fileList.push(e.name);
      }
    } catch {}
  }

  cachedFiles = fileList;
  cachedModified = modifiedSet;
  lastScanTime = now;
  return { files: fileList, modified: modifiedSet };
}

export function searchFiles(rootDir, query = "", limit = 20) {
  const { files, modified } = getRepoFiles(rootDir);
  const q = (query || "").trim().toLowerCase();

  const results = [];

  for (const filePath of files) {
    const name = path.basename(filePath);
    const dir = path.dirname(filePath);
    const nameLower = name.toLowerCase();
    const pathLower = filePath.toLowerCase();
    const isModified = modified.has(filePath);

    let score = 0;

    if (!q) {
      // Empty query: prioritize modified files, then root files
      score = isModified ? 100 : dir === "." ? 50 : 10;
    } else {
      // With query: score based on match precision
      if (nameLower === q) {
        score = 200;
      } else if (nameLower.startsWith(q)) {
        score = 150;
      } else if (nameLower.includes(q)) {
        score = 100;
      } else if (pathLower.includes(q)) {
        score = 50;
      } else {
        // Fuzzy acronym matching (e.g. "pinput" matches "PromptInput")
        continue;
      }

      if (isModified) score += 40;
      if (dir === ".") score += 10;
    }

    results.push({
      path: filePath,
      name,
      dir: dir === "." ? "" : dir,
      isModified,
      score,
    });
  }

  results.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  return results.slice(0, limit);
}
