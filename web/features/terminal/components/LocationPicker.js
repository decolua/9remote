"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Folder, FolderOpen, GitBranch, GitFork, ChevronDown, Loader2, Check } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { vibrate } from "@/shared/utils/vibration";
import { shortenHomePath, suggestWorktreePath } from "../lib/workspaceGrouping";

// Where a new terminal starts. Flat list grouped by repo — worktrees of a repo are its
// rows, so picking "the feat/x checkout" is one tap, not a wizard. Repo scan + worktree
// lists are lazy: nothing is fetched until the menu opens.
export default function LocationPicker({ workspacePath, workspaceName, fileBus, homeDir, value, onChange, onBrowse }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState(null); // [{ repoPath, name, isRoot, isRepo, entries: [{path,branch,detached}] }]
  const [loading, setLoading] = useState(false);
  // Inline "new worktree" mini-form state — null wtRepo means "first repo" until picked
  const [creating, setCreating] = useState(false);
  const [wtName, setWtName] = useState("");
  const [wtRepo, setWtRepo] = useState(null);
  const [wtBusy, setWtBusy] = useState(false);
  const [wtError, setWtError] = useState(null);
  const wrapRef = useRef(null);
  const wtInputRef = useRef(null);

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
      return { repoPath: repo.path, name: repo.name, isRoot: !repo.relPath, isRepo: true, entries };
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
      // Escape inside the create form backs out to the list, not the whole menu
      if (creating) { setCreating(false); setWtError(null); } else setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, creating]);

  const pick = (path) => { vibrate(); setCreating(false); onChange?.(path); setOpen(false); };

  // No autofocus on touch — same guard as the modal's name field (keyboard shoves the modal)
  useEffect(() => {
    if (creating && window.matchMedia("(pointer: fine)").matches) {
      requestAnimationFrame(() => wtInputRef.current?.focus());
    }
  }, [creating]);

  const repoGroups = (groups || []).filter((g) => g.isRepo);
  const startCreate = () => {
    setWtRepo((prev) => prev || repoGroups.find((g) => g.isRoot)?.repoPath || repoGroups[0]?.repoPath || null);
    setWtName("");
    setWtError(null);
    setWtBusy(false);
    setCreating(true);
  };
  // Free-form name → git-safe branch; same sanitizing the path suggestion applies.
  // Leading "-" would make git read the branch as an option (--force etc.)
  const branchName = wtName.trim().replace(/[^\w.-]+/g, "-").replace(/^-+/, "");
  const createWorktree = async () => {
    if (!wtRepo || !branchName || wtBusy || !fileBus?.gitWorktreeAdd) return;
    const wtPath = suggestWorktreePath(wtRepo, branchName);
    setWtBusy(true);
    setWtError(null);
    const res = await fileBus.gitWorktreeAdd(wtRepo, wtPath, branchName, true);
    // Stay busy through the list refresh — a live button here double-fires "add"
    if (!res?.success) { setWtBusy(false); return setWtError(res?.error || "Failed to create worktree"); }
    await load();
    pick(res.path || wtPath);
  };

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
        <span className="flex-1 min-w-0 text-xs text-text truncate" title={label}>{label}</span>
        <ChevronDown size={14} className={`text-text-muted shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute z-10 left-0 right-0 top-full mt-1 max-h-72 flex flex-col bg-surface-2 rounded-brand border border-border-subtle shadow-lg"
        >
          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin py-1">
          {!creating && loading && (
            <div className="flex items-center justify-center py-4 text-text-muted">
              <Loader2 size={15} className="animate-spin" />
            </div>
          )}
          {!creating && !loading && groups?.map((g) => (
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
          {creating && (
            <div data-wt-form className="px-2 py-1.5">
              <div className="flex items-center gap-1.5 px-1 pb-1.5 text-[10px] font-medium uppercase tracking-wider text-text-subtle">
                <GitFork size={11} />
                {t("workspaces.newWorktree")}
              </div>
              {repoGroups.length > 1 && (
                <select
                  value={wtRepo || ""}
                  onChange={(e) => setWtRepo(e.target.value)}
                  disabled={wtBusy}
                  className="w-full mb-1 px-2 py-1 rounded-brand bg-surface-3 text-xs text-text focus:outline-none"
                >
                  {repoGroups.map((g) => (
                    <option key={g.repoPath} value={g.repoPath}>{g.name}</option>
                  ))}
                </select>
              )}
              <input
                type="text"
                ref={wtInputRef}
                value={wtName}
                disabled={wtBusy}
                onChange={(e) => setWtName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void createWorktree(); } }}
                placeholder={t("workspaces.worktreeName")}
                className="w-full px-2 py-1.5 rounded-brand bg-surface-3 text-xs text-text placeholder-text-subtle focus:outline-none"
              />
              {/* Path preview — the directory is derived, never typed */}
              <p className="px-1 pt-1 truncate text-[10px] text-text-subtle leading-tight" title={suggestWorktreePath(wtRepo, branchName || "…")}>
                {shortenHomePath(suggestWorktreePath(wtRepo, branchName || "…"), homeDir)}
              </p>
              {wtError && <p className="px-1 pt-1 text-[10px] text-red-500 break-words">{wtError}</p>}
              <div className="flex items-center justify-end gap-1.5 pt-1.5">
                <button
                  type="button"
                  onClick={() => { vibrate(); setCreating(false); setWtError(null); }}
                  className="px-2 py-1 text-xs text-text-muted hover:text-text transition-colors"
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  onClick={() => { vibrate(); void createWorktree(); }}
                  disabled={!branchName || wtBusy || !wtRepo}
                  className="px-2.5 py-1 rounded-brand bg-brand-500 hover:bg-brand-600 text-white text-xs font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none"
                >
                  {wtBusy ? <Loader2 size={12} className="animate-spin" /> : t("common.create")}
                </button>
              </div>
            </div>
          )}
          </div>
          {!creating && (repoGroups.length > 0 || onBrowse) && (
            <div className="shrink-0 border-t border-border-subtle flex items-center gap-1 px-2 py-1.5">
              {repoGroups.length > 0 && fileBus?.gitWorktreeAdd && (
                <button
                  type="button"
                  onClick={() => { vibrate(); startCreate(); }}
                  className="flex-1 min-w-0 flex items-center justify-center gap-1.5 px-2 py-1 rounded-brand text-xs text-brand-500 hover:bg-brand-500/10 transition-colors"
                >
                  <GitFork size={12} className="shrink-0" />
                  <span className="truncate">{t("workspaces.newWorktree")}</span>
                </button>
              )}
              {onBrowse && (
                <button
                  type="button"
                  onClick={() => { vibrate(); setOpen(false); onBrowse(); }}
                  className="flex-1 min-w-0 flex items-center justify-center gap-1.5 px-2 py-1 rounded-brand text-xs text-text-muted hover:bg-surface-3 hover:text-text transition-colors"
                >
                  <FolderOpen size={12} className="shrink-0 opacity-70" />
                  <span className="truncate">{t("terminal.browseFolders")}</span>
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
