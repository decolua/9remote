// Git-aware path index for `@` mentions. The host gathers candidates (files tracked
// or untracked-but-not-ignored, plus their parent folders) and ships the list once;
// ranking happens on the client so a keystroke never waits on a round-trip.
import { execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const CACHE_TTL_MS = 5000;
const MAX_INDEX_FILES = 5000;
const MAX_INDEX_DIRS = 1500;
const MAX_FALLBACK_ENTRIES = 500;
// One `ai:files` reply has to fit the control channel, chunking happens above this
// layer and a 1500-file monorepo would blow well past SCTP's 64KB.
const MAX_INDEX_PAYLOAD_BYTES = 48 * 1024;

const caches = new Map();

function collectParents(fileList) {
  const dirs = new Set();
  for (const file of fileList) {
    const segments = file.split("/");
    // Drop the basename: only folders above it are index entries.
    for (let i = 1; i < segments.length; i++) dirs.add(segments.slice(0, i).join("/"));
  }
  return [...dirs].sort();
}

function scanRepo(rootDir) {
  const fileList = [];

  try {
    const lsOut = execSync("git ls-files --cached --others --exclude-standard", {
      cwd: rootDir,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 3000,
      stdio: ["ignore", "pipe", "pipe"]
    });

    for (const line of lsOut.split("\n")) {
      const f = line.trim();
      if (!f) continue;
      if (f.startsWith(".source/") || f.startsWith(".bin/") || f.startsWith(".codegraph/") || f.startsWith(".git/")) continue;
      fileList.push(f);
      if (fileList.length >= MAX_INDEX_FILES) break;
    }
  } catch {
    walkShallow(rootDir, "", fileList);
  }

  return fileList;
}

function walkShallow(dir, prefix, out) {
  if (out.length >= MAX_FALLBACK_ENTRIES) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (out.length >= MAX_FALLBACK_ENTRIES) return;
    if (entry.name.startsWith(".")) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walkShallow(path.join(dir, entry.name), rel, out);
    else out.push(rel);
  }
}

function modifiedSet(rootDir) {
  const modified = new Set();
  try {
    const statusOut = execSync("git status --short", {
      cwd: rootDir, encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "pipe"]
    });
    for (const line of statusOut.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let filePath = trimmed.slice(2).trim();
      // `R  old -> new` names the destination last.
      const arrow = filePath.indexOf(" -> ");
      if (arrow !== -1) filePath = filePath.slice(arrow + 4);
      filePath = filePath.replace(/^"|"$/g, "");
      if (!filePath) continue;
      if (filePath.startsWith(".source/") || filePath.startsWith(".bin/")) continue;
      modified.add(filePath);
    }
  } catch {}
  return modified;
}

// Relative file paths + parent folders + the git-changed subset, cached per workspace.
function getPathIndex(rootDir) {
  const root = rootDir || process.cwd();
  let cache = caches.get(root);
  if (!cache) {
    cache = { indexPath: null, scannedAt: 0 };
    caches.set(root, cache);
  }

  const now = Date.now();
  if (cache.indexPath && now - cache.scannedAt < CACHE_TTL_MS) return cache.indexPath;

  const modified = modifiedSet(root);
  const fileList = scanRepo(root);
  const indexPath = {
    root,
    files: fileList.map((filePath) => ({ path: filePath, isModified: modified.has(filePath) })),
    dirs: collectParents(fileList).slice(0, MAX_INDEX_DIRS),
    truncated: fileList.length >= MAX_INDEX_FILES
  };

  cache.indexPath = indexPath;
  cache.scannedAt = now;
  return indexPath;
}

// Wire shape: `paths` plus `modified` as indices into it. Repeating
// `{path, isModified}` per file nearly doubles the reply, and this reply has to fit
// one control message.
export function listPathIndex(rootDir) {
  const { root, files, dirs, truncated } = getPathIndex(rootDir);

  // A repo past the budget keeps its changed files and its shallowest paths — the
  // ones a mention is likely to want — and the caller searches on the host for the rest.
  let kept = files;
  let keptDirs = dirs;
  let trimmed = truncated;
  const build = () => ({ root, ...toWireShape(kept, keptDirs, trimmed) });

  let payload = build();
  if (JSON.stringify(payload).length > MAX_INDEX_PAYLOAD_BYTES) {
    const ordered = [...files].sort((a, b) => {
      if (a.isModified !== b.isModified) return a.isModified ? -1 : 1;
      return a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path);
    });
    const keptPaths = new Set();
    // Folders are shipped whole, so the file budget is what is left after them.
    let budget = MAX_INDEX_PAYLOAD_BYTES - JSON.stringify({ root, paths: [], modified: [], dirs, truncated: true }).length - 512;
    for (const file of ordered) {
      const cost = file.path.length + 3;
      if (budget - cost < 0) break;
      budget -= cost;
      keptPaths.add(file.path);
    }
    kept = files.filter((f) => keptPaths.has(f.path));
    keptDirs = dirs.filter((dir) => kept.some((f) => f.path.startsWith(`${dir}/`)));
    trimmed = true;
    payload = build();
  }

  return payload;
}

// Client could not see the whole repo in its trimmed index: answer one query here.
export function searchPathCandidates(rootDir, query = "", limit = 200) {
  const { files, dirs } = getPathIndex(rootDir);
  const q = (query || "").trim();
  if (!q) return { paths: [], modified: [], dirs: [] };

  const sensitive = /[A-Z]/.test(q);
  const needle = sensitive ? q : q.toLowerCase();
  const matches = (hay) => {
    const text = sensitive ? hay : hay.toLowerCase();
    let i = 0;
    for (let j = 0; j < text.length && i < needle.length; j++) if (text[j] === needle[i]) i++;
    return i === needle.length;
  };

  return toWireShape(
    files.filter((f) => matches(f.path)).slice(0, limit),
    dirs.filter((dir) => matches(`${dir}/`)).slice(0, limit),
    true
  );
}

// Same compact shape as the index reply, so the client parses both with one function.
function toWireShape(files, dirs, truncated) {
  return {
    paths: files.map((f) => f.path),
    modified: files.reduce((acc, f, i) => (f.isModified ? (acc.push(i), acc) : acc), []),
    dirs,
    truncated
  };
}
