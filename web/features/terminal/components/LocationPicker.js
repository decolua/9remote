"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Folder, FolderOpen, GitBranch, ChevronDown, Loader2, Check } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { vibrate } from "@/shared/utils/vibration";
import { shortenHomePath } from "../lib/workspaceGrouping";

// Where a new terminal starts. Flat list grouped by repo — worktrees of a repo are its
// rows, so picking "the feat/x checkout" is one tap, not a wizard. Repo scan + worktree
// lists are lazy: nothing is fetched until the menu opens.
export default function LocationPicker({ workspacePath, workspaceName, fileSocket, homeDir, value, onChange, onBrowse }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState(null); // [{ repoPath, name, isRoot, entries: [{path,branch,detached}] }]
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef(null);

  const load = useCallback(async () => {
    if (!workspacePath || !fileSocket?.gitScanRepos) return setGroups([]);
    setLoading(true);
    const res = await fileSocket.gitScanRepos(workspacePath);
    const repos = res?.success ? res.repos || [] : [];
    // One worktree list per repo, in parallel — a workspace holds a handful, not hundreds.
    const built = await Promise.all(repos.map(async (repo) => {
      const wt = await fileSocket.gitWorktreeList?.(repo.path);
      const trees = wt?.success ? wt.worktrees || [] : [];
      const entries = trees.length
        ? trees.map((w) => ({ path: w.path, branch: w.branch, detached: w.detached }))
        : [{ path: repo.path, branch: repo.branch, detached: false }];
      return { repoPath: repo.path, name: repo.name, isRoot: !repo.relPath, entries };
    }));
    // A plain folder holding repos is still a valid cwd, so keep it selectable.
    if (!built.some((g) => g.isRoot)) {
      built.unshift({ repoPath: workspacePath, name: workspaceName || t("terminal.workspaceRoot"), isRoot: true, entries: [{ path: workspacePath, branch: null, detached: false }] });
    }
    setGroups(built);
    setLoading(false);
  }, [workspacePath, workspaceName, fileSocket, t]);

  // Close on outside click / Escape — the menu floats over the modal body
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const pick = (path) => { vibrate(); onChange?.(path); setOpen(false); };

  // No pick yet means "inherit whatever the workspace last used" — name the workspace,
  // not a path, so the default never looks like an explicit choice.
  const label = value ? shortenHomePath(value, homeDir) : (workspaceName || shortenHomePath(workspacePath, homeDir) || t("terminal.workspaceRoot"));
  const multiRepo = (groups?.length || 0) > 1;

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => { vibrate(); if (groups === null) void load(); setOpen((v) => !v); }}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-brand text-left bg-surface-2 hover:bg-surface-3 transition-colors"
      >
        <Folder size={14} className="text-text-muted shrink-0" />
        <span className="flex-1 min-w-0 text-xs text-text truncate">{label}</span>
        <ChevronDown size={14} className={`text-text-muted shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute z-10 left-0 right-0 top-full mt-1 max-h-72 overflow-y-auto scrollbar-thin bg-surface-2 rounded-brand border border-border-subtle shadow-lg py-1"
        >
          {loading && (
            <div className="flex items-center justify-center py-4 text-text-muted">
              <Loader2 size={15} className="animate-spin" />
            </div>
          )}
          {!loading && groups?.map((g) => (
            <div key={g.repoPath}>
              {multiRepo && (
                <p className="px-3 pt-1.5 pb-0.5 text-[10px] font-medium uppercase tracking-wider text-text-subtle truncate">{g.name}</p>
              )}
              {g.entries.map((e) => {
                const selected = value === e.path;
                return (
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    key={e.path}
                    onClick={() => pick(e.path)}
                    className={`w-full flex items-start gap-2 px-3 py-1.5 text-left transition-colors ${
                      selected ? "bg-brand-500/15" : "hover:bg-surface-3"
                    }`}
                  >
                    {e.branch || e.detached
                      ? <GitBranch size={12} className="mt-[3px] shrink-0 text-text-subtle" />
                      : <Folder size={12} className="mt-[3px] shrink-0 text-text-subtle" />}
                    <span className="flex-1 min-w-0 flex flex-col">
                      <span className="flex items-center gap-1 min-w-0">
                        <span className={`truncate text-xs ${selected ? "text-text font-medium" : "text-text"}`}>
                          {e.branch || (e.detached ? t("terminal.detachedHead") : g.name)}
                        </span>
                        {selected && <Check size={12} className="text-brand-400 shrink-0" />}
                      </span>
                      <span className="truncate text-[10px] text-text-subtle leading-tight" title={e.path}>
                        {e.path.split("/").filter(Boolean).pop() || e.path}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
          {onBrowse && (
            <>
              <div className="my-1 h-px bg-border-subtle" />
              <button
                type="button"
                onClick={() => { vibrate(); setOpen(false); onBrowse(); }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs text-text-muted hover:bg-surface-3 hover:text-text transition-colors"
              >
                <FolderOpen size={12} className="shrink-0 opacity-70" />
                {t("terminal.browseFolders")}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
