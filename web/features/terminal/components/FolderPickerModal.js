"use client";

import { useCallback, useEffect, useState } from "react";
import { Folder, Home, HardDrive, ChevronRight, Loader2, X } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { vibrate } from "@/shared/utils/vibration";
import { toPosixPath } from "@/features/fileExplorer/constants/fileExplorer";
import { getRecentWorkspaces } from "@/features/fileExplorer/components/WorkspaceList";
import { shortenHomePath as shortHome } from "../lib/workspaceGrouping";

// Split a posix path into clickable breadcrumb segments.
function crumbsOf(dirPath) {
  if (!dirPath) return [];
  const parts = dirPath.split("/").filter(Boolean);
  const crumbs = dirPath.startsWith("/") ? [{ name: "/", path: "/" }] : [];
  let acc = dirPath.startsWith("/") ? "" : ".";
  for (const part of parts) {
    acc = `${acc}/${part}`;
    crumbs.push({ name: part, path: acc });
  }
  return crumbs;
}

const parentOf = (dirPath) => {
  const idx = dirPath.lastIndexOf("/");
  if (idx <= 0) return "/";
  return dirPath.slice(0, idx);
};

// Desktop folder picker: browse the host filesystem and pick one directory. Keeps the
// terminal visible behind it — the mobile flow uses the full-screen WorkspaceList instead.
export default function FolderPickerModal({ fileSocket, initialPath, onSelect, onClose }) {
  const { t } = useI18n();
  const [dirPath, setDirPath] = useState(initialPath || null);
  const [entries, setEntries] = useState([]);
  const [picked, setPicked] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [systemInfo, setSystemInfo] = useState(null);
  // localStorage is only readable on the client, so seed lazily rather than in an effect.
  const [recent] = useState(() => (typeof window === "undefined" ? [] : getRecentWorkspaces()));

  useEffect(() => {
    let cancelled = false;
    fileSocket?.getSystemInfo?.().then((res) => {
      if (cancelled || !res?.success) return;
      setSystemInfo(res);
      setDirPath((cur) => cur || res.homedir || "/");
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

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const go = (target) => { vibrate(); setPicked(null); setDirPath(toPosixPath(target)); };

  // Confirm takes the highlighted child, else the directory currently listed.
  const chosen = picked || dirPath;

  return (
    <div className="fixed inset-0 z-[80] flex items-stretch sm:items-center justify-center sm:p-4 bg-black/70 backdrop-blur-[2px]" onClick={onClose}>
      <div
        className="bg-surface w-full sm:w-[560px] sm:max-w-full h-full sm:h-[70vh] sm:max-h-[560px] sm:rounded-[3px] flex flex-col shadow-elev"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 h-11 flex items-center gap-2 border-b border-border-subtle flex-shrink-0">
          <h3 className="text-sm font-semibold text-text flex-1">{t("workspaces.newWorkspace")}</h3>
          <button onClick={onClose} className="p-1 text-text-muted hover:text-text rounded-[3px] hover:bg-surface-2">
            <X size={16} />
          </button>
        </div>

        {/* Breadcrumbs */}
        <div className="px-3 py-2 flex items-center gap-0.5 flex-wrap text-xs border-b border-border-subtle flex-shrink-0">
          {crumbsOf(dirPath).map((c, i) => (
            <span key={c.path} className="flex items-center gap-0.5">
              {i > 0 && <ChevronRight size={11} className="text-text-subtle" />}
              <button
                onClick={() => go(c.path)}
                className="px-1 py-0.5 text-text-muted hover:text-text hover:bg-surface-2 rounded-[2px] transition-colors"
              >
                {c.name}
              </button>
            </span>
          ))}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto modal-scrollable">
          {/* Shortcuts, only at the very start of a browse */}
          {!dirPath && (
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
              {dirPath !== "/" && (
                <button
                  onClick={() => go(parentOf(dirPath))}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-text-muted hover:bg-surface-2 rounded-[3px] transition-colors"
                >
                  <Folder size={15} className="text-orange-500/50" /> ..
                </button>
              )}
              {/* Row selects, chevron descends — clicking a folder must not skip past the
                  one the user actually wanted to pick. */}
              {entries.map((f) => (
                <div
                  key={f.path}
                  onClick={() => { vibrate(); setPicked(f.path); }}
                  onDoubleClick={() => go(f.path)}
                  className={`group w-full flex items-center gap-2 pl-3 pr-1 py-1.5 text-sm rounded-[3px] transition-colors cursor-pointer ${
                    picked === f.path ? "bg-brand-500/15 text-text" : "text-text hover:bg-surface-2"
                  }`}
                >
                  <Folder size={15} className="text-orange-500/70 flex-shrink-0" />
                  <span className="flex-1 min-w-0 truncate">{f.name}</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); go(f.path); }}
                    className="p-1 text-text-subtle hover:text-text rounded-[2px] hover:bg-surface-3 opacity-60 group-hover:opacity-100 transition-opacity flex-shrink-0"
                    tabIndex={-1}
                  >
                    <ChevronRight size={14} />
                  </button>
                </div>
              ))}
              {!entries.length && (
                <p className="px-3 py-4 text-xs text-text-subtle italic">{t("files.emptyFolder")}</p>
              )}
            </div>
          )}

          {/* Recent, shown below so it never pushes the listing off-screen */}
          {!!recent.length && (
            <div className="p-2 border-t border-border-subtle mt-1">
              <p className="px-1 pb-1 text-[10px] uppercase tracking-wider text-text-subtle">{t("workspaces.recentFolders")}</p>
              {recent.slice(0, 5).map((w) => (
                <ShortcutRow
                  key={w.path}
                  icon={<Folder size={14} className="text-orange-500/60" />}
                  label={shortHome(w.path, systemInfo?.homedir)}
                  onClick={() => go(w.path)}
                />
              ))}
            </div>
          )}
        </div>

        <div className="px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pb-3 border-t border-border-subtle flex-shrink-0">
          {/* Name the folder that Confirm will actually take — the highlighted child, or
              the directory being listed. */}
          <p className="pb-2 text-[11px] text-text-subtle truncate" title={chosen || ""}>
            {chosen ? shortHome(chosen, systemInfo?.homedir) : "—"}
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => { vibrate(); onSelect(chosen); }}
              disabled={!chosen}
              className="flex-1 py-2 text-sm font-semibold text-white bg-brand-500 hover:bg-brand-600 rounded-[3px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {t("workspaces.selectFolder")}
            </button>
            <button
              onClick={onClose}
              className="flex-1 py-2 text-sm text-text-muted bg-surface-2 hover:bg-surface-3 rounded-[3px] transition-colors"
            >
              {t("common.cancel")}
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
