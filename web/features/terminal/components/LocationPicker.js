"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Folder, FolderOpen, GitBranch, GitFork, ChevronDown, Loader2, Check } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { vibrate } from "@/shared/utils/vibration";
import { shortenHomePath } from "../lib/workspaceGrouping";

// Where a new terminal starts. Flat list grouped by repo — worktrees of a repo are its
// rows, so picking "the feat/x checkout" is one tap, not a wizard. Repo scan + worktree
// lists are lazy: nothing is fetched until the menu opens. A worktree the modal is about
// to create arrives as `staged` ({branch, path}) and takes over the trigger display.
export default function LocationPicker({ workspacePath, workspaceName, fileBus, homeDir, value, onChange, onBrowse, staged = null }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState(null); // [{ repoPath, name, isRoot, isRepo, entries: [{path,branch,detached}] }]
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef(null);

  const load = useCallback(async () => {
    if (!workspacePath || !fileBus?.gitScanRepos) return setGroups([]);
    setLoading(true);
    const res = await fileBus.gitScanRepos(workspacePath);
    const repos = res?.success ? res.repos || [] : [];
    // One worktree list per repo, in parallel — a workspace holds a handful, not hundreds.
    const built = await Promise.all(repos.map(async (repo) => {
      const wt = await fileBus.gitWorktreeList?.(repo.path);
      const trees = wt?.success ? wt.worktrees || [] : [];
      const entries = trees.length
        ? trees.map((w) => ({ path: w.path, branch: w.branch, detached: w.detached }))
        : [{ path: repo.path, branch: repo.branch, detached: false }];
      return { repoPath: repo.path, name: repo.name, branch: repo.branch, isRoot: !repo.relPath, isRepo: true, entries };
    }));
    // A plain folder holding repos is still a valid cwd, so keep it selectable.
    if (!built.some((g) => g.isRoot)) {
      built.unshift({ repoPath: workspacePath, name: workspaceName || t("terminal.workspaceRoot"), isRoot: true, isRepo: false, entries: [{ path: workspacePath, branch: null, detached: false }] });
    }
    setGroups(built);
    setLoading(false);
  }, [workspacePath, workspaceName, fileBus, t]);

  // Close on outside click / Escape — the menu floats over the modal body
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const pick = (path) => { vibrate(); onChange?.(path); setOpen(false); };

  const multiRepo = (groups?.length || 0) > 1;

  // Two lines: the selection on top, what the field does below — a bare value
  // next to the title reads as mystery text. The path rides along as the tooltip.
  const picked = value ? (groups || []).flatMap((g) => g.entries).find((e) => e.path === value) : null;
  const primary = staged?.branch || picked?.branch || (value || workspacePath || "").split("/").filter(Boolean).pop() || workspaceName || t("terminal.workspaceRoot");
  const secondary = staged
    ? `${t("workspaces.newWorktree")} · ${shortenHomePath(staged.path, homeDir)}`
    : "Pick a branch or worktree";

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => { vibrate(); if (groups === null) void load(); setOpen((v) => !v); }}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={staged?.path || value || workspacePath || undefined}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-brand text-left bg-surface-2 hover:bg-surface-3 transition-colors"
      >
        {staged
          ? <GitFork size={14} className="text-brand-500 shrink-0" />
          : <GitBranch size={14} className="text-text-muted shrink-0" />}
        <span className="flex-1 min-w-0 flex flex-col">
          <span className="text-xs text-text truncate leading-tight">{primary}</span>
          <span className="text-[10px] text-text-subtle truncate leading-tight" title={staged?.path}>{secondary}</span>
        </span>
        <ChevronDown size={14} className={`text-text-muted shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute z-10 left-0 right-0 top-full mt-1 max-h-72 flex flex-col bg-surface-3 rounded-brand border border-border shadow-xl"
        >
          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin py-1">
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
                      selected ? "bg-brand-500/15" : "hover:bg-text/[0.06]"
                    }`}
                  >
                    {e.branch || e.detached
                      ? <GitBranch size={12} className="mt-[3px] shrink-0 text-text-subtle" />
                      : <Folder size={12} className="mt-[3px] shrink-0 text-text-subtle" />}
                    <span className="flex-1 min-w-0 flex flex-col">
                      <span className="flex items-center gap-1 min-w-0">
                        <span className={`truncate text-xs ${selected ? "text-text font-medium" : "text-text"}`} title={e.branch || g.name}>
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
          </div>
          {onBrowse && (
            <div className="shrink-0 border-t border-border-subtle flex items-center gap-1 px-2 py-1.5">
              <button
                type="button"
                onClick={() => { vibrate(); setOpen(false); onBrowse(); }}
                className="flex-1 min-w-0 flex items-center justify-center gap-1.5 px-2 py-1 rounded-brand text-xs text-text-muted hover:bg-text/[0.06] hover:text-text transition-colors"
              >
                <FolderOpen size={12} className="shrink-0 opacity-70" />
                <span className="truncate">{t("terminal.browseFolders")}</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
