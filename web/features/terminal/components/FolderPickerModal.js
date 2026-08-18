"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Folder, FolderOpen, Home, HardDrive, ChevronRight, ChevronLeft, Loader2, X, Search } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { vibrate } from "@/shared/utils/vibration";
import { toPosixPath } from "@/features/fileExplorer/constants/fileExplorer";
import { getRecentWorkspaces } from "@/features/fileExplorer/components/WorkspaceList";
import { shortenHomePath as shortHome } from "../lib/workspaceGrouping";

// Remember the last browsed directory across opens — subsequent opens resume where the
// user left off instead of always starting at home (Windows dialog guideline).
let lastBrowsedDir = null;

const RECENTS_SHOWN = 8;

const parentOf = (dirPath) => {
  if (/^[A-Za-z]:\/?$/.test(dirPath)) return null; // drive root → drives screen (This PC)
  const idx = dirPath.lastIndexOf("/");
  if (idx <= 0) return "/";
  const parent = dirPath.slice(0, idx);
  return /^[A-Za-z]:$/.test(parent) ? `${parent}/` : parent;
};

const baseName = (dirPath) => {
  if (!dirPath || dirPath === "/") return null;
  return dirPath.split("/").filter(Boolean).pop();
};

// Desktop folder picker: browse the host filesystem and pick one directory. Keeps the
// terminal visible behind it — the mobile flow uses the full-screen WorkspaceList instead.
export default function FolderPickerModal({ fileSocket, initialPath, onSelect, onClose }) {
  const { t } = useI18n();
  const [dirPath, setDirPath] = useState(initialPath || lastBrowsedDir || null);
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [systemInfo, setSystemInfo] = useState(null);
  const [filter, setFilter] = useState("");
  const [hiIdx, setHiIdx] = useState(0);          // keyboard highlight within the filtered list
  const [editPath, setEditPath] = useState(null); // breadcrumb replaced by a path input
  // localStorage is only readable on the client, so seed lazily rather than in an effect.
  const [recent] = useState(() => (typeof window === "undefined" ? [] : getRecentWorkspaces()));
  const searchRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    fileSocket?.getSystemInfo?.().then((res) => {
      if (cancelled || !res?.success) return;
      setSystemInfo(res);
      setDirPath((cur) => cur || toPosixPath(res.homedir) || "/");
    });
    return () => { cancelled = true; };
  }, [fileSocket]);

  const load = useCallback(async (target) => {
    if (!target || !fileSocket?.getFiles) return;
    setLoading(true);
    setError(null);
    const res = await fileSocket.getFiles(target, false);
    setLoading(false);
    if (!res?.success) return setError(res?.error || t("workspaces.pathNotFolder"));
    setEntries((res.files || []).filter((f) => f.type === "folder"));
  }, [fileSocket, t]);

  useEffect(() => {
    const id = setTimeout(() => void load(dirPath), 0);
    return () => clearTimeout(id);
  }, [dirPath, load]);

  // Filter-first on desktop (orca picker pattern): type to narrow, arrows + Enter to walk in.
  useEffect(() => {
    if (typeof window !== "undefined" && window.matchMedia("(min-width: 640px)").matches) {
      searchRef.current?.focus();
    }
  }, []);

  // Esc clears the filter first, closes only when already empty.
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && !filter) onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [filter, onClose]);

  const go = (target) => {
    vibrate();
    lastBrowsedDir = target == null ? null : toPosixPath(target);
    setDirPath(lastBrowsedDir);
    setFilter("");
    setHiIdx(0);
  };

  const confirm = () => {
    if (!dirPath) return;
    lastBrowsedDir = dirPath;
    vibrate();
    onSelect(dirPath);
  };

  const visible = filter
    ? entries.filter((f) => f.name.toLowerCase().includes(filter.toLowerCase()))
    : entries;

  const onSearchKey = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHiIdx((i) => Math.min(i + 1, Math.max(visible.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHiIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      const target = visible[hiIdx] ?? (visible.length === 1 ? visible[0] : null);
      if (target) { e.preventDefault(); go(target.path); }
    } else if (e.key === "Escape" && filter) {
      // Keep it inside the input — the document listener would otherwise close the modal.
      e.stopPropagation();
      setFilter("");
      setHiIdx(0);
    }
  };

  const submitEditPath = () => {
    const value = editPath?.trim();
    setEditPath(null);
    if (value && value !== dirPath) go(value);
  };

  const chosenName = baseName(dirPath);
  const posixHome = systemInfo ? toPosixPath(systemInfo.homedir) : null;
  const parent = parentOf(dirPath || "/");
  const upLabel = parent === null
    ? t("workspaces.drives")
    : parent === "/"
      ? "/"
      : parent === posixHome
        ? t("workspaces.homeFolder")
        : baseName(parent);

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-3 sm:p-4 bg-black/70 backdrop-blur-[2px]" onClick={onClose}>
      <div
        className="bg-surface w-full sm:w-[560px] sm:max-w-full h-[85vh] sm:h-[70vh] sm:max-h-[560px] rounded-[3px] flex flex-col shadow-elev overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Inset from the viewport edges, so no notch/home-bar padding is needed. */}
        <div className="px-4 h-11 flex items-center gap-2 border-b border-border-subtle flex-shrink-0">
          <h3 className="text-sm font-semibold text-text flex-1">{t("workspaces.newWorkspace")}</h3>
          <button onClick={onClose} className="p-1 text-text-muted hover:text-text rounded-[3px] hover:bg-surface-2">
            <X size={16} />
          </button>
        </div>

        {/* Filter input — type to narrow the listing, arrows + Enter to walk in */}
        <div className="px-3 py-2 border-b border-border-subtle flex-shrink-0">
          <div className="flex items-center gap-2 bg-surface-2 rounded-[3px] px-2 py-1.5 border border-border-subtle focus-within:border-brand-500 transition-colors">
            <Search size={13} className="text-text-subtle flex-shrink-0" />
            <input
              ref={searchRef}
              value={filter}
              onChange={(e) => { setFilter(e.target.value); setHiIdx(0); }}
              onKeyDown={onSearchKey}
              placeholder={t("workspaces.searchFolders")}
              className="flex-1 min-w-0 bg-transparent text-sm text-text outline-none placeholder:text-text-subtle"
            />
            {!!filter && (
              <span className="text-[10px] text-text-subtle tabular-nums flex-shrink-0">{visible.length}</span>
            )}
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto modal-scrollable">
          {/* Recent first — chips, visually distinct from the folder rows below so a
              saved workspace is never mistaken for a folder of the current listing */}
          {!filter && !!recent.length && (
            <div className="p-2 pb-1">
              <p className="px-1 pb-1.5 text-[10px] uppercase tracking-wider text-text-subtle">{t("workspaces.recentFolders")}</p>
              <div className="grid grid-cols-2 gap-1.5">
                {recent.slice(0, RECENTS_SHOWN).map((w) => {
                  const wp = toPosixPath(w.path);
                  return (
                    <button
                      key={w.path}
                      onClick={() => { vibrate(); lastBrowsedDir = wp; onSelect(wp); }}
                      className="flex items-center gap-1.5 px-2 py-1.5 bg-surface-2 hover:bg-surface-3 rounded-[4px] border border-border-subtle text-left transition-colors min-w-0"
                      title={wp}
                    >
                      <FolderOpen size={13} className="text-brand-500 flex-shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs text-text truncate">{baseName(wp) || wp}</span>
                        <span className="block text-[10px] text-text-subtle truncate">{shortHome(wp, systemInfo?.homedir)}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Shortcuts, only at the very start of a browse */}
          {!filter && !dirPath && (
            <div className="p-2 space-y-1">
              {systemInfo?.isWindows
                ? systemInfo.drives?.map((d) => (
                  <ShortcutRow key={d.letter} icon={<HardDrive size={15} className="text-blue-500/70" />} label={d.path} onClick={() => go(d.path)} />
                ))
                : (
                  <>
                    <ShortcutRow icon={<Home size={15} className="text-blue-500/70" />} label={systemInfo?.homedir || "~"} onClick={() => go(systemInfo?.homedir || "/")} />
                    <ShortcutRow icon={<HardDrive size={15} className="text-text-subtle" />} label="/" onClick={() => go("/")} />
                  </>
                )}
            </div>
          )}

          {loading && (
            <div className="p-6 flex justify-center text-text-muted"><Loader2 size={18} className="animate-spin" /></div>
          )}
          {error && <p className="p-4 text-xs text-red-500">{error}</p>}

          {!loading && !error && dirPath && (
            <div className="p-1">
              {/* One tap enters the folder — that is what a file browser does, and the
                  Confirm button below already takes whatever directory is being listed,
                  so entering never costs the user the ability to pick it. */}
              {visible.map((f, idx) => (
                <button
                  key={f.path}
                  onClick={() => go(f.path)}
                  className={`group w-full flex items-center gap-2 pl-3 pr-2 py-2 text-sm text-text rounded-[3px] hover:bg-surface-2 active:bg-surface-2 transition-colors ${
                    filter && idx === hiIdx ? "bg-surface-2 ring-1 ring-brand-500/40" : ""
                  }`}
                >
                  <Folder size={16} className="text-orange-500/70 flex-shrink-0" />
                  <span className="flex-1 min-w-0 truncate text-left">{f.name}</span>
                  <ChevronRight size={14} className="text-text-subtle flex-shrink-0 opacity-0 group-hover:opacity-100" />
                </button>
              ))}
              {!visible.length && (
                <p className="px-3 py-4 text-xs text-text-subtle italic">
                  {entries.length ? t("common.noResults") : t("files.emptyFolder")}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="px-3 pt-2 pb-3 border-t border-border-subtle flex-shrink-0">
          {/* Where we are: labeled up-pill + the folder being listed (dblclick path to type one) */}
          <div className="pb-2 flex items-center gap-2 min-w-0 text-[11px]">
            <button
              onClick={() => go(parentOf(dirPath || "/"))}
              disabled={!dirPath || dirPath === "/"}
              className="flex items-center gap-1 px-2 py-1 text-brand-500 bg-surface-2 hover:bg-surface-3 hover:text-brand-600 rounded-[3px] disabled:opacity-30 flex-shrink-0 transition-colors"
              title={t("workspaces.parentFolder")}
            >
              <ChevronLeft size={13} />
              {upLabel}
            </button>
            {editPath !== null ? (
              <input
                autoFocus
                value={editPath}
                onChange={(e) => setEditPath(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") submitEditPath();
                  if (e.key === "Escape") setEditPath(null);
                }}
                placeholder={t("workspaces.enterPath")}
                className="flex-1 min-w-0 px-1.5 py-0.5 text-[11px] text-text bg-surface-2 rounded-[2px] border border-border-subtle focus:border-brand-500 outline-none font-mono"
              />
            ) : (
              <span
                className="flex-1 min-w-0 truncate text-text-subtle font-mono"
                title={dirPath || ""}
                onDoubleClick={() => setEditPath(dirPath || "")}
              >
                {dirPath ? shortHome(dirPath, systemInfo?.homedir) : "—"}
              </span>
            )}
          </div>
          {/* Single action — X and Esc already cancel */}
          <button
            onClick={confirm}
            disabled={!dirPath}
            className="w-full py-2 text-sm font-semibold text-white bg-brand-500 hover:bg-brand-600 rounded-[3px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed truncate"
          >
            {chosenName ? t("workspaces.selectNamed", { name: chosenName }) : t("workspaces.selectFolder")}
          </button>
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
