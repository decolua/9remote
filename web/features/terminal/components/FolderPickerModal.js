"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Folder, FolderOpen, Home, HardDrive, ChevronRight, ArrowUp, Loader2, X, Search } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { vibrate } from "@/shared/utils/vibration";
import { toPosixPath } from "@/features/fileExplorer/constants/fileExplorer";
import { getRecentWorkspaces } from "@/features/fileExplorer/components/WorkspaceList";
import { shortenHomePath as shortHome } from "../lib/workspaceGrouping";

// Remember the last browsed directory across opens — subsequent opens resume where the
// user left off instead of always starting at home (Windows dialog guideline).
// Mutated only through this setter so component code never reassigns a module global.
let lastBrowsedDir = null;
const rememberBrowsedDir = (p) => { lastBrowsedDir = p == null ? null : toPosixPath(p); };
const readBrowsedDir = () => lastBrowsedDir;

const RECENTS_SHOWN = 8;
const PATH_DEBOUNCE_MS = 300;
// Beyond this the input is treated as junk — path resolve is dropped, not attempted.
const PATH_INPUT_MAX_CHARS = 2048;

const DRIVE_ROOT_RE = /^[A-Za-z]:\/?$/;
const DRIVE_ANCHOR_RE = /^[A-Za-z]:\//;

const isDriveRoot = (p) => DRIVE_ROOT_RE.test(p);

const parentOf = (dirPath) => {
  // Root and drive roots top out at the drives/shortcuts screen.
  if (!dirPath || dirPath === "/" || isDriveRoot(dirPath)) return null;
  const idx = dirPath.lastIndexOf("/");
  if (idx <= 0) return "/";
  const parent = dirPath.slice(0, idx);
  return /^[A-Za-z]:$/.test(parent) ? `${parent}/` : parent;
};

const baseName = (dirPath) => {
  if (!dirPath || dirPath === "/") return null;
  return dirPath.split("/").filter(Boolean).pop() ?? null;
};

// Portion before the final separator; distinguishes filter-only edits from committed-path changes.
const committedPrefix = (raw) => {
  const i = Math.max(raw.lastIndexOf("/"), raw.lastIndexOf("\\"));
  return i === -1 ? "" : raw.slice(0, i + 1);
};

// Breadcrumb parts: Windows drive paths carry their root as the first crumb.
function splitBrowsePath(p) {
  if (!p) return { kind: "posix", segments: [] };
  const m = /^([A-Za-z]:)(\/.*)?$/.exec(p);
  if (m) return { kind: "drive", driveRoot: `${m[1]}/`, segments: (m[2] || "").split("/").filter(Boolean) };
  return { kind: "posix", segments: p.split("/").filter(Boolean) };
}

const crumbPath = (parts, i) => parts.kind === "drive"
  ? (i < 0 ? parts.driveRoot : `${parts.driveRoot}${parts.segments.slice(0, i + 1).join("/")}`)
  : `/${parts.segments.slice(0, i + 1).join("/")}`;

function filterEntries(list, filterText) {
  const q = filterText.trim().toLowerCase();
  if (!q) return list;
  return list.filter((e) => e.name.toLowerCase().includes(q));
}

// ---------- Path-aware input parsing ----------

// Slashes (either separator), drive anchors, and standalone base markers enter path mode.
const isPathMode = (raw) =>
  raw.includes("/") || raw.includes("\\") || /^[A-Za-z]:$/.test(raw) || raw === "~" || raw === "." || raw === "..";

function parsePathInput(rawInput) {
  if (!isPathMode(rawInput)) return { mode: "filter", filter: rawInput };
  // Backslashes are accepted (Windows paste habit) and normalized to the POSIX form
  // used everywhere on the web side.
  const raw = rawInput.replace(/\\/g, "/");
  if (raw === "~") return { mode: "path", base: "home", committedSegments: [], trailingFilter: "" };
  if (raw === ".") return { mode: "path", base: "cwd", committedSegments: [], trailingFilter: "" };
  if (raw === "..") return { mode: "path", base: "cwd", committedSegments: [".."], trailingFilter: "" };
  if (/^[A-Za-z]:$/.test(raw)) {
    return { mode: "path", base: "drive", driveRoot: `${raw[0].toUpperCase()}:/`, committedSegments: [], trailingFilter: "" };
  }

  let base, driveRoot, remainder;
  if (DRIVE_ANCHOR_RE.test(raw)) {
    base = "drive";
    driveRoot = `${raw[0].toUpperCase()}:/`;
    remainder = raw.slice(3);
  } else if (raw.startsWith("/")) {
    base = "root";
    remainder = raw.slice(1);
  } else if (raw.startsWith("~/")) {
    base = "home";
    remainder = raw.slice(2);
  } else {
    base = "cwd";
    remainder = raw;
  }

  // Don't collapse `//` or accept control chars — the visible input must agree with the resolved path.
  const invalid = remainder.includes("//") || /[\x00-\x1F]/.test(remainder);
  if (invalid) return { mode: "path", base, driveRoot, committedSegments: [], trailingFilter: "", invalid: true };

  const parts = remainder === "" ? [""] : remainder.split("/");
  return {
    mode: "path",
    base,
    driveRoot,
    committedSegments: parts.slice(0, -1),
    trailingFilter: parts[parts.length - 1],
  };
}

// One committed segment against a listing: exact match wins, then case-insensitive,
// then a unique folder prefix — the two input modes must not disagree.
function resolveSegmentStep(segment, baseEntries) {
  if (segment === "." || segment === "..") return { type: "stay", up: segment === ".." };
  const entry = baseEntries.find((e) => e.name === segment)
    || baseEntries.find((e) => e.name.toLowerCase() === segment.toLowerCase());
  if (entry) return entry.type === "folder" ? { type: "descend", path: entry.path } : { type: "error", multiple: false };
  const lower = segment.toLowerCase();
  const matches = baseEntries.filter((e) => e.type === "folder" && e.name.toLowerCase().startsWith(lower));
  if (matches.length === 1) return { type: "descend", path: matches[0].path };
  return { type: "error", multiple: matches.length > 1 };
}

// Desktop folder picker: browse the host filesystem and pick one directory
// (breadcrumb, dual-mode input, cached listings).
// Keeps the terminal visible behind it — the mobile flow uses the full-screen WorkspaceList instead.
export default function FolderPickerModal({ fileBus, initialPath, onSelect, onClose }) {
  const { t } = useI18n();
  // Frozen at mount: lastBrowsedDir mutates on every navigate, so recomputing this
  // per render would re-fire the boot effects and yank the user back to the start dir.
  const [startPath] = useState(() => initialPath || readBrowsedDir() || null);
  const [dirPath, setDirPath] = useState(startPath);
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(!!startPath);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState("");
  const [hiIdx, setHiIdx] = useState(0); // keyboard highlight within the visible list
  // Path-mode preview drives the list while typing; committed state only moves on Enter/navigation.
  const [preview, setPreview] = useState(null);
  const [systemInfo, setSystemInfo] = useState(null);
  // localStorage is only readable on the client, so seed lazily rather than in an effect.
  const [recent] = useState(() => (typeof window === "undefined" ? [] : getRecentWorkspaces()));
  const searchRef = useRef(null);
  const isDesktopRef = useRef(false);
  const genRef = useRef(0);
  const previewGenRef = useRef(0);
  const debounceTimerRef = useRef(null);
  const pasteResolveTimerRef = useRef(null);
  const clickTimerRef = useRef(null);
  const crumbsRef = useRef(null);
  const dialogRef = useRef(null);
  // Per-open listing cache keyed by path — stepping back up costs nothing.
  const listingCacheRef = useRef(new Map());
  const homePathRef = useRef(null);
  const lastCommittedPrefixRef = useRef("");
  const homeBootRef = useRef(false);

  const fetchListing = useCallback(async (target) => {
    const cached = listingCacheRef.current.get(target);
    if (cached) return cached;
    const res = await fileBus.getFiles(target, false);
    if (!res?.success) throw new Error(res?.error || t("workspaces.pathNotFolder"));
    const result = {
      resolvedPath: toPosixPath(res.currentPath) || target,
      entries: (res.files || []).filter((f) => f.type === "folder"),
    };
    listingCacheRef.current.set(result.resolvedPath, result);
    if (target !== result.resolvedPath) listingCacheRef.current.set(target, result);
    return result;
  }, [fileBus, t]);

  const loadDir = useCallback(async (target) => {
    if (target == null) {
      genRef.current++;
      setDirPath(null);
      setEntries([]);
      setLoading(false);
      setError(null);
      return;
    }
    const gen = ++genRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await fetchListing(target);
      if (gen !== genRef.current) return;
      setDirPath(result.resolvedPath);
      setEntries(result.entries);
      if (target === "~") homePathRef.current = result.resolvedPath;
    } catch (err) {
      if (gen !== genRef.current) return;
      setError(err.message || String(err));
      setEntries([]);
    } finally {
      if (gen === genRef.current) setLoading(false);
    }
  }, [fetchListing]);

  useEffect(() => {
    if (!startPath) return;
    const id = setTimeout(() => void loadDir(startPath), 0);
    return () => clearTimeout(id);
  }, [startPath, loadDir]);

  // Home anchor + first directory when nothing was remembered (once — later runs
  // only refresh systemInfo, never reset the browse position).
  useEffect(() => {
    let cancelled = false;
    fileBus?.getSystemInfo?.().then((res) => {
      if (cancelled || !res?.success) return;
      setSystemInfo(res);
      const home = toPosixPath(res.homedir);
      if (!home) return;
      homePathRef.current = home;
      if (!startPath && !homeBootRef.current) {
        homeBootRef.current = true;
        void loadDir(home);
      }
    });
    return () => { cancelled = true; };
  }, [fileBus, startPath, loadDir]);

  // Central navigation: drops filter/preview and bumps the preview gen so a stale resolve can't clobber.
  const navigate = useCallback((target) => {
    vibrate();
    rememberBrowsedDir(target);
    setFilter("");
    setPreview(null);
    setHiIdx(0);
    previewGenRef.current++;
    lastCommittedPrefixRef.current = "";
    if (debounceTimerRef.current) { clearTimeout(debounceTimerRef.current); debounceTimerRef.current = null; }
    void loadDir(target);
  }, [loadDir]);

  const navigateUp = useCallback(() => {
    if (!dirPath) return;
    navigate(parentOf(dirPath));
  }, [dirPath, navigate]);

  // Resolve a path-mode input into preview state; paste and the debounce tick share this.
  const resolvePathInput = useCallback(async (raw) => {
    const parsed = parsePathInput(raw);
    if (parsed.mode !== "path") return;
    const gen = ++previewGenRef.current;

    if (parsed.invalid) {
      setPreview({ resolvedPath: dirPath ?? "/", entries: [], filter: "", error: t("workspaces.invalidPath"), loading: false });
      return;
    }

    let basePath;
    if (parsed.base === "root") basePath = "/";
    else if (parsed.base === "drive") basePath = parsed.driveRoot;
    else if (parsed.base === "home") {
      if (!homePathRef.current) {
        setPreview({ resolvedPath: dirPath ?? "/", entries: [], filter: "", error: null, loading: true });
        try {
          const home = await fetchListing("~");
          if (gen !== previewGenRef.current) return;
          homePathRef.current = home.resolvedPath;
        } catch (err) {
          if (gen !== previewGenRef.current) return;
          setPreview({ resolvedPath: dirPath ?? "/", entries: [], filter: "", error: err.message, loading: false });
          return;
        }
      }
      basePath = homePathRef.current;
    } else basePath = dirPath || "/";

    setPreview((prev) => (prev && prev.loading ? prev : { resolvedPath: basePath, entries: [], filter: "", error: null, loading: true }));

    let currentPath = basePath;
    try {
      for (const segment of parsed.committedSegments) {
        const listing = await fetchListing(currentPath);
        if (gen !== previewGenRef.current) return;
        const outcome = resolveSegmentStep(segment, listing.entries);
        if (outcome.type === "error") {
          const dir = shortHome(currentPath, systemInfo?.homedir);
          setPreview({
            resolvedPath: currentPath,
            entries: listing.entries,
            filter: "",
            error: outcome.multiple
              ? t("workspaces.multipleDirMatches", { name: segment, dir })
              : t("workspaces.notADirectory", { name: segment, dir }),
            loading: false,
          });
          return;
        }
        if (outcome.type === "stay") {
          if (outcome.up) currentPath = parentOf(currentPath) || "/";
          continue;
        }
        currentPath = outcome.path;
      }

      const finalListing = await fetchListing(currentPath);
      if (gen !== previewGenRef.current) return;
      lastCommittedPrefixRef.current = committedPrefix(raw);
      setPreview({ resolvedPath: finalListing.resolvedPath, entries: finalListing.entries, filter: parsed.trailingFilter, error: null, loading: false });
    } catch (err) {
      if (gen !== previewGenRef.current) return;
      setPreview({ resolvedPath: currentPath, entries: [], filter: "", error: err.message, loading: false });
    }
  }, [dirPath, fetchListing, systemInfo, t]);

  // Filter-mode edits stay local; path-mode edits get a debounced resolve — but an
  // unchanged committed prefix only moves the trailing filter, no re-resolve.
  const handleInputChange = useCallback((raw) => {
    setFilter(raw);
    setHiIdx(0);

    if (raw.length > PATH_INPUT_MAX_CHARS || !isPathMode(raw)) {
      if (preview) { setPreview(null); previewGenRef.current++; }
      if (debounceTimerRef.current) { clearTimeout(debounceTimerRef.current); debounceTimerRef.current = null; }
      return;
    }

    const parsed = parsePathInput(raw);
    if (parsed.mode === "path" && preview && !preview.error && !parsed.invalid
      && committedPrefix(raw) === lastCommittedPrefixRef.current) {
      setPreview({ ...preview, filter: parsed.trailingFilter });
      return;
    }

    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      resolvePathInput(raw);
    }, PATH_DEBOUNCE_MS);
  }, [preview, resolvePathInput]);

  // Paste resolves immediately — deferred a tick so onChange applies the value first.
  const handleInputPaste = (e) => {
    if (e.defaultPrevented) return;
    if (e.clipboardData.getData("text/plain").length > PATH_INPUT_MAX_CHARS) return;
    if (pasteResolveTimerRef.current) clearTimeout(pasteResolveTimerRef.current);
    pasteResolveTimerRef.current = setTimeout(() => {
      pasteResolveTimerRef.current = null;
      if (debounceTimerRef.current) { clearTimeout(debounceTimerRef.current); debounceTimerRef.current = null; }
      const value = searchRef.current?.value ?? "";
      if (value.length <= PATH_INPUT_MAX_CHARS && isPathMode(value)) resolvePathInput(value);
    }, 0);
  };

  // Cancel any in-flight work when the modal unmounts.
  useEffect(() => () => {
    genRef.current++;
    previewGenRef.current++;
    for (const ref of [debounceTimerRef, pasteResolveTimerRef, clickTimerRef]) {
      if (ref.current) clearTimeout(ref.current);
      ref.current = null;
    }
  }, []);

  const visible = useMemo(() => filterEntries(entries, filter), [entries, filter]);
  const previewFiltered = useMemo(
    () => (preview ? filterEntries(preview.entries, preview.filter) : []),
    [preview]
  );
  const displayEntries = preview ? previewFiltered : visible;

  const onSearchKey = (e) => {
    if (e.key === "Enter") {
      if (preview) {
        if (preview.error || preview.loading) { e.preventDefault(); return; }
        const parsed = parsePathInput(filter);
        // Fully-resolved directory (trailing `/` or bare base marker): navigate to it.
        if (parsed.mode === "path" && parsed.trailingFilter === "") {
          e.preventDefault();
          navigate(preview.resolvedPath);
          return;
        }
        // Trailing filter: walk into the single folder it narrows to.
        if (previewFiltered.length === 1) {
          e.preventDefault();
          navigate(previewFiltered[0].path);
        } else e.preventDefault();
        return;
      }
      const target = visible.length === 1 ? visible[0] : visible[hiIdx];
      if (target) { e.preventDefault(); navigate(target.path); }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHiIdx((i) => Math.min(i + 1, Math.max(displayEntries.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHiIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Escape" && filter) {
      // Keep it inside the input — the document listener would otherwise close the modal.
      e.stopPropagation();
      setFilter("");
      setPreview(null);
      previewGenRef.current++;
      if (debounceTimerRef.current) { clearTimeout(debounceTimerRef.current); debounceTimerRef.current = null; }
    } else if (e.key === "Backspace" && filter === "" && !preview) {
      // Empty input + Backspace climbs to the parent.
      e.preventDefault();
      navigateUp();
    }
  };

  // Filter-first on desktop: type to narrow, arrows + Enter to walk in.
  useEffect(() => {
    if (typeof window === "undefined") return;
    isDesktopRef.current = window.matchMedia("(min-width: 640px)").matches;
    if (isDesktopRef.current) searchRef.current?.focus();
  }, []);

  // Esc closes only when the filter is already empty (input-level Esc handles the clear).
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && !filter) onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [filter, onClose]);

  const confirm = () => {
    if (!dirPath) return;
    rememberBrowsedDir(dirPath);
    vibrate();
    onSelect(dirPath);
  };

  // Single vs double click: a delayed navigate lets dblclick pick the folder itself
  // — navigating immediately would unmount the row before dblclick lands.
  const rowGo = (entry) => {
    // Stale rows from a prior listing may show while a preview resolves.
    if (preview?.loading) return;
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null;
      navigate(entry.path);
    }, 220);
  };
  const rowPick = (entry) => {
    if (preview?.loading) return;
    if (clickTimerRef.current) { clearTimeout(clickTimerRef.current); clickTimerRef.current = null; }
    rememberBrowsedDir(entry.path);
    onSelect(entry.path);
  };

  const browseParts = useMemo(() => splitBrowsePath(dirPath), [dirPath]);

  // Keep the deepest crumb in view — the bar anchors left by default, hiding the current dir.
  useEffect(() => {
    if (crumbsRef.current) crumbsRef.current.scrollLeft = crumbsRef.current.scrollWidth;
  }, [dirPath]);

  // Minimal focus trap: Tab wraps inside the dialog instead of reaching the page behind it.
  const onDialogKeyDown = (e) => {
    if (e.key !== "Tab") return;
    const focusables = dialogRef.current?.querySelectorAll('button:not([disabled]), input');
    if (!focusables?.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  const chosenName = baseName(dirPath);
  const posixHome = systemInfo ? toPosixPath(systemInfo.homedir) : null;
  const isWindows = !!systemInfo?.isWindows;
  // Select always returns the committed directory; disabled under a path preview so the
  // committed dir isn't silently picked under a different-looking list.
  const selectDisabled = loading || (!!preview && filter !== "");

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-3 sm:p-4 bg-black/70 backdrop-blur-[2px]" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("workspaces.newWorkspace")}
        onKeyDown={onDialogKeyDown}
        className="bg-surface w-full sm:w-[560px] sm:max-w-full h-[min(85%,calc(var(--app-height,85vh)-2rem))] sm:h-[70vh] sm:max-h-[560px] mt-4 mb-auto sm:my-auto rounded-[3px] flex flex-col shadow-elev overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Inset from the viewport edges, so no notch/home-bar padding is needed. */}
        <div className="px-4 h-11 flex items-center gap-2 border-b border-border-subtle flex-shrink-0">
          <h3 className="text-sm font-semibold text-text flex-1">{t("workspaces.newWorkspace")}</h3>
          <button onClick={onClose} className="p-1 text-text-muted hover:text-text rounded-[3px] hover:bg-surface-2">
            <X size={16} />
          </button>
        </div>

        {/* Breadcrumb bar — every segment is a jump target */}
        <div ref={crumbsRef} className="px-3 pt-2 flex items-center gap-0.5 min-h-[28px] overflow-x-auto flex-shrink-0">
          <button
            onClick={navigateUp}
            disabled={loading || !dirPath || dirPath === "/"}
            className="shrink-0 p-1.5 text-text-muted hover:text-text hover:bg-surface-2 rounded-[3px] disabled:opacity-30 transition-colors"
            title={t("workspaces.parentFolder")}
          >
            <ArrowUp size={14} />
          </button>
          <button
            onClick={() => navigate(posixHome || "/")}
            disabled={loading}
            className="shrink-0 p-1.5 text-text-muted hover:text-text hover:bg-surface-2 rounded-[3px] transition-colors"
            title={t("workspaces.homeFolder")}
          >
            <Home size={14} />
          </button>
          <div className="flex items-center gap-0 text-[11px] text-text-muted ml-1 min-w-0">
            {isWindows ? (
              <button
                type="button"
                onClick={() => navigate(null)}
                className="shrink-0 px-0.5 hover:text-text transition-colors"
                title={t("workspaces.drives")}
              >
                <HardDrive size={12} />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => navigate("/")}
                className="shrink-0 px-0.5 hover:text-text transition-colors"
              >
                /
              </button>
            )}
            {browseParts.kind === "drive" && (
              <>
                <ChevronRight size={11} className="shrink-0 text-text-subtle" />
                <button
                  type="button"
                  onClick={() => navigate(browseParts.driveRoot)}
                  className={`truncate max-w-[120px] px-0.5 hover:text-text transition-colors ${browseParts.segments.length === 0 ? "text-text font-medium" : ""}`}
                >
                  {browseParts.driveRoot.replace(/\/$/, "")}
                </button>
              </>
            )}
            {browseParts.segments.map((segment, i) => (
              <div key={crumbPath(browseParts, i)} className="flex items-center gap-0 min-w-0">
                <ChevronRight size={11} className="shrink-0 text-text-subtle" />
                <button
                  type="button"
                  onClick={() => navigate(crumbPath(browseParts, i))}
                  className={`truncate max-w-[120px] px-0.5 hover:text-text transition-colors ${i === browseParts.segments.length - 1 ? "text-text font-medium" : ""}`}
                >
                  {segment}
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Dual-mode input — type to filter, or type/paste a path to preview it */}
        <div className="px-3 py-2 flex-shrink-0">
          <div className="flex items-center gap-2 bg-surface-2 rounded-[3px] px-2 py-1.5 border border-border-subtle focus-within:border-brand-500 transition-colors">
            <Search size={13} className="text-text-subtle flex-shrink-0" />
            <input
              ref={searchRef}
              value={filter}
              onChange={(e) => handleInputChange(e.target.value)}
              onPaste={handleInputPaste}
              onKeyDown={onSearchKey}
              placeholder={t("workspaces.filterOrPath")}
              aria-invalid={!!preview?.error}
              className="flex-1 min-w-0 bg-transparent text-sm text-text outline-none placeholder:text-text-subtle"
            />
            {preview?.loading && <Loader2 size={13} className="animate-spin text-text-subtle flex-shrink-0" />}
            {!!filter && !preview?.loading && (
              <span className="text-[10px] text-text-subtle tabular-nums flex-shrink-0">{displayEntries.length}</span>
            )}
          </div>
          {preview?.error && <p className="pt-1 px-0.5 text-[11px] text-red-500">{preview.error}</p>}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto modal-scrollable">
          {/* Recent first — one compact scrollable row, visually distinct from the folder
              rows below so a saved workspace is never mistaken for a folder of the listing */}
          {!filter && !preview && !!recent.length && (
            <div className="p-2 pb-1">
              <p className="px-1 pb-1.5 text-[10px] uppercase tracking-wider text-text-subtle">{t("workspaces.recentFolders")}</p>
              <div className="flex gap-1.5 overflow-x-auto pb-0.5">
                {recent.slice(0, RECENTS_SHOWN).map((w) => {
                  const wp = toPosixPath(w.path);
                  return (
                    <button
                      key={w.path}
                      onClick={() => { vibrate(); rememberBrowsedDir(wp); onSelect(wp); }}
                      className="flex items-center gap-1.5 px-2 py-1.5 bg-surface-2 hover:bg-surface-3 rounded-[4px] border border-border-subtle text-left transition-colors w-[150px] shrink-0"
                      title={wp}
                    >
                      <FolderOpen size={13} className="text-brand-500 flex-shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs text-text truncate">{baseName(wp) || wp}</span>
                        <span className="block text-[10px] text-text-subtle truncate">{shortHome(wp, posixHome)}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Shortcuts, only at the very start of a browse */}
          {!filter && !preview && !dirPath && (
            <div className="p-2 space-y-1">
              {isWindows
                ? systemInfo?.drives?.map((d) => (
                  <ShortcutRow key={d.letter} icon={<HardDrive size={15} className="text-blue-500/70" />} label={toPosixPath(d.path)} onClick={() => navigate(toPosixPath(d.path))} />
                ))
                : (
                  <>
                    <ShortcutRow icon={<Home size={15} className="text-blue-500/70" />} label={posixHome || "/"} onClick={() => navigate(posixHome || "/")} />
                    <ShortcutRow icon={<HardDrive size={15} className="text-text-subtle" />} label="/" onClick={() => navigate("/")} />
                  </>
                )}
            </div>
          )}

          {loading && (
            <div className="p-6 flex justify-center text-text-muted"><Loader2 size={18} className="animate-spin" /></div>
          )}
          {!loading && error && <p className="p-4 text-xs text-red-500">{error}</p>}

          {!loading && !error && (dirPath || preview) && (
            <div className="p-1">
              {/* One tap enters the folder; double-click picks it straight away. The
                  Confirm button below takes whatever directory is being listed, so
                  entering never costs the ability to pick it. */}
              {displayEntries.map((f, idx) => (
                <button
                  key={f.path}
                  onClick={() => rowGo(f)}
                  onDoubleClick={() => rowPick(f)}
                  onMouseDown={(e) => {
                    if (!isDesktopRef.current) return;
                    e.preventDefault();
                    searchRef.current?.focus();
                  }}
                  className={`group w-full flex items-center gap-2 pl-3 pr-2 py-2 text-sm text-text rounded-[3px] hover:bg-surface-2 active:bg-surface-2 transition-colors ${
                    (filter || preview) && idx === hiIdx ? "bg-surface-2 ring-1 ring-brand-500/40" : ""
                  }`}
                >
                  <Folder size={16} className="text-orange-500/70 flex-shrink-0" />
                  <span className="flex-1 min-w-0 truncate text-left" title={f.name}>{f.name}</span>
                  <ChevronRight size={14} className="text-text-subtle flex-shrink-0 opacity-0 group-hover:opacity-100" />
                </button>
              ))}
              {!displayEntries.length && (
                <p className="px-3 py-4 text-xs text-text-subtle italic">
                  {(preview ? preview.entries.length : entries.length) ? t("common.noResults") : t("files.emptyFolder")}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="px-3 pt-2 pb-3 border-t border-border-subtle flex-shrink-0">
          {/* Where a selection would land */}
          <p className="pb-2 text-[10px] text-text-subtle truncate" title={preview ? preview.resolvedPath : dirPath || ""}>
            {preview ? shortHome(preview.resolvedPath, posixHome) : dirPath ? shortHome(dirPath, posixHome) : t("workspaces.drives")}
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-text-muted hover:text-text bg-surface-2 hover:bg-surface-3 rounded-[3px] transition-colors"
            >
              {t("common.cancel")}
            </button>
            <button
              onClick={confirm}
              disabled={!dirPath || selectDisabled}
              className="flex-1 py-2 text-sm font-semibold text-white bg-brand-500 hover:bg-brand-600 rounded-[3px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed truncate"
              title={dirPath || ""}
            >
              {chosenName ? t("workspaces.selectNamed", { name: chosenName }) : t("workspaces.selectFolder")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ShortcutRow({ icon, label, onClick }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2 px-2 py-1.5 text-xs text-text-muted hover:text-text hover:bg-surface-2 rounded-[3px] transition-colors text-left"
    >
      <span className="flex-shrink-0">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}
