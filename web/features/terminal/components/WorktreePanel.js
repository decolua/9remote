"use client";

import { useCallback, useEffect, useState } from "react";
import { GitBranch, GitFork, Plus, Trash2, Terminal, Search, Loader2, X } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { vibrate } from "@/shared/utils/vibration";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";
import { refreshWorkspaceGit } from "../hooks/useWorkspaceGit";
import { shortenHomePath, suggestWorktreePath } from "../lib/workspaceGrouping";

// Worktrees on top, branches below — the two always move together (pick a branch, give it
// a worktree, open a terminal in it), so splitting them across tabs would mean ping-pong.
export default function WorktreePanel({ workspacePath, fileBus, homeDir, onNewTerminal, onChanged }) {
  const { t } = useI18n();
  // Hover-reveal on pointer devices; touch has no hover, so keep them visible there.
  const revealCls = "opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100";
  const [worktrees, setWorktrees] = useState([]);
  const [branches, setBranches] = useState([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [removeTarget, setRemoveTarget] = useState(null); // { path, busy: [] }
  const [addTarget, setAddTarget] = useState(null);       // { branch, path }

  const load = useCallback(async () => {
    if (!workspacePath || !fileBus?.gitBranchList) return;
    setLoading(true);
    setError(null);
    const res = await fileBus.gitBranchList(workspacePath);
    setLoading(false);
    if (!res?.success) return setError(res?.error || null);
    setBranches(res.branches || []);
    setWorktrees(res.worktrees || []);
  }, [workspacePath, fileBus]);

  useEffect(() => {
    const id = setTimeout(() => void load(), 0);
    return () => clearTimeout(id);
  }, [load]);

  const afterChange = () => {
    setError(null);
    load();
    refreshWorkspaceGit(workspacePath);
    onChanged?.();
  };

  const checkout = async (branch) => {
    vibrate();
    const res = await fileBus.gitBranchCheckout(workspacePath, branch);
    if (!res?.success) return setError(res?.error || null);
    afterChange();
  };

  const addWorktree = async ({ branch, path: wtPath }) => {
    const res = await fileBus.gitWorktreeAdd(workspacePath, wtPath, branch, false);
    setAddTarget(null);
    if (!res?.success) return setError(res?.error || null);
    afterChange();
  };

  const removeWorktree = async (wtPath, confirmed) => {
    const res = await fileBus.gitWorktreeRemove(workspacePath, wtPath, { confirmed });
    if (res?.busy) return setRemoveTarget({ path: wtPath, busy: res.busy });
    setRemoveTarget(null);
    if (!res?.success) return setError(res?.error || null);
    afterChange();
  };

  const visible = query
    ? branches.filter((b) => b.name.toLowerCase().includes(query.toLowerCase()))
    : branches;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {error && (
        <div className="px-3 py-2 flex items-start gap-2 border-b border-border-subtle bg-red-500/5">
          <p className="flex-1 text-[11px] text-red-500 break-words whitespace-pre-wrap">{error}</p>
          <button
            onClick={() => setError(null)}
            className="p-0.5 text-red-500/70 hover:text-red-500 flex-shrink-0"
            title={t("common.close")}
          >
            <X size={12} />
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto modal-scrollable">
        {/* Worktrees */}
        <div className="sticky top-0 z-10 px-2 py-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-text-muted bg-surface-3 border-b border-border-subtle">
          <GitFork size={11} />
          <span className="flex-1">{t("workspaces.worktrees")}</span>
          {loading ? <Loader2 size={11} className="animate-spin" /> : <span className="normal-case tracking-normal">{worktrees.length}</span>}
        </div>
        {worktrees.map((wt) => (
          <div
            key={wt.path}
            className={`group flex items-center gap-1.5 px-3 py-1 text-[12px] transition-colors border-l-2 ${
              wt.path === workspacePath
                ? "border-brand-500 bg-text/[0.04]"
                : "border-transparent hover:bg-surface-2"
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${wt.isMain ? "bg-brand-500" : "bg-text-muted/50"}`} />
            <span className="flex-1 min-w-0 flex flex-col">
              <span className="truncate text-text">{wt.branch || wt.head?.slice(0, 7) || "\u2014"}</span>
              <span className="truncate text-[10px] text-text-subtle leading-tight" title={wt.path}>
                {shortenHomePath(wt.path, homeDir)}
              </span>
            </span>
            {onNewTerminal && (
              <button
                onClick={() => { vibrate(); onNewTerminal(wt.path); }}
                className={`p-0.5 text-text-subtle hover:text-brand-500 transition-colors ${revealCls}`}
                title={t("workspaces.openHere")}
              >
                <Terminal size={12} />
              </button>
            )}
            {!wt.isMain && (
              <button
                onClick={() => { vibrate(); removeWorktree(wt.path, false); }}
                className={`p-0.5 text-text-subtle hover:text-red-500 transition-colors ${revealCls}`}
                title={t("workspaces.removeWorktree")}
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        ))}

        {/* Branches */}
        <div className="sticky top-0 z-10 mt-3 px-2 py-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-text-muted bg-surface-3 border-y border-border-subtle">
          <GitBranch size={11} />
          <span className="flex-1">{t("workspaces.branches")}</span>
          <span className="normal-case tracking-normal">{visible.length}</span>
        </div>
        <div className="px-2 py-1">
          <div className="flex items-center gap-1 px-2 py-1 bg-surface-2 rounded-[3px]">
            <Search size={11} className="text-text-subtle flex-shrink-0" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("workspaces.searchBranch")}
              className="flex-1 min-w-0 bg-transparent text-[12px] text-text outline-none placeholder:text-text-subtle"
            />
          </div>
        </div>
        {visible.map((b) => (
          <div key={b.name} className="group flex items-center gap-1.5 px-3 py-1 text-[12px] hover:bg-surface-2 transition-colors">
            <button
              onClick={() => !b.isCurrent && checkout(b.name)}
              disabled={b.isCurrent}
              className={`flex-1 min-w-0 truncate text-left ${b.isCurrent ? "text-text font-medium" : "text-text-muted hover:text-text"}`}
              title={b.name}
            >
              {b.name}
            </button>
            {b.checkedOut ? (
              <span className="text-[10px] text-text-subtle flex-shrink-0">{t("workspaces.checkedOut")}</span>
            ) : (
              <button
                onClick={() => { vibrate(); setAddTarget({ branch: b.name, path: suggestWorktreePath(workspacePath, b.name) }); }}
                className={`p-0.5 text-text-subtle hover:text-brand-500 transition-colors flex-shrink-0 ${revealCls}`}
                title={t("workspaces.addWorktree")}
              >
                <Plus size={12} />
              </button>
            )}
          </div>
        ))}
        {!visible.length && !loading && (
          <p className="px-3 py-2 text-[11px] text-text-subtle italic">{t("workspaces.emptyWorkspace")}</p>
        )}
      </div>

      {/* Add worktree */}
      {addTarget && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/70" onClick={() => setAddTarget(null)}>
          <div className="bg-surface rounded-[3px] p-5 w-96 shadow-elev" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-text mb-1">{t("workspaces.addWorktree")}</h3>
            <p className="text-[11px] text-text-muted mb-3 truncate" title={addTarget.branch}>{addTarget.branch}</p>
            <label className="block text-[11px] text-text-muted mb-1">{t("workspaces.worktreePath")}</label>
            <input
              autoFocus
              value={addTarget.path}
              onChange={(e) => setAddTarget({ ...addTarget, path: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Enter" && addTarget.path.trim()) addWorktree(addTarget); }}
              className="w-full bg-surface-2 border border-border-subtle rounded-[3px] px-3 py-2 text-sm text-text outline-none focus:border-brand-500"
            />
            <div className="flex gap-2 mt-4">
              <button
                onClick={() => addWorktree(addTarget)}
                disabled={!addTarget.path.trim()}
                className="flex-1 py-2 text-sm font-semibold text-white bg-brand-500 hover:bg-brand-600 rounded-[3px] transition-colors disabled:opacity-40"
              >
                {t("common.confirm")}
              </button>
              <button
                onClick={() => setAddTarget(null)}
                className="flex-1 py-2 text-sm text-text-muted bg-surface-2 hover:bg-surface-3 rounded-[3px] transition-colors"
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Remove worktree — names the terminals that would lose their directory */}
      <ConfirmDialog
        isOpen={!!removeTarget}
        onClose={() => setRemoveTarget(null)}
        onConfirm={() => removeWorktree(removeTarget.path, true)}
        title={t("workspaces.removeWorktree")}
        message={
          removeTarget?.busy?.length
            ? t("workspaces.worktreeBusy", {
                count: removeTarget.busy.length,
                names: removeTarget.busy.map((s) => s.name).join(", ")
              })
            : t("workspaces.removeWorktreeMessage", { path: removeTarget?.path || "" })
        }
      />
    </div>
  );
}
