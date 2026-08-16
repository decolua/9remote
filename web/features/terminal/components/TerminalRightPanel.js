"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { ChevronRight, EyeOff, Files, Folder, GitBranch, GitFork, RefreshCw, X } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { PANEL_HEADER_HEIGHT } from "@/shared/constants/layout";
import { vibrate } from "@/shared/utils/vibration";
import { RIGHT_PANEL_WIDTH } from "../constants/terminalConfig";
import { useWorkspaceRepos } from "../hooks/useWorkspaceRepos";
import { useWorkspaceRoots } from "../hooks/useWorkspaceRoots";

const ExplorerPanel = dynamic(() => import("@/features/fileExplorer/components/ExplorerPanel"), { ssr: false });
const ScmPanel = dynamic(() => import("@/features/fileExplorer/components/ScmPanel"), { ssr: false });
const WorktreePanel = dynamic(() => import("./WorktreePanel"), { ssr: false });

const TABS = [
  { key: "files", icon: Files, labelKey: "workspaces.tabFiles" },
  { key: "git", icon: GitBranch, labelKey: "workspaces.tabGit" },
  { key: "trees", icon: GitFork, labelKey: "workspaces.tabTrees" }
];

// Secondary sidebar docked right of the terminal panes: file tree, git, worktrees.
// Roots are the workspace itself plus each of its worktrees — separate directories on
// disk, so they cannot share one tree.
export default function TerminalRightPanel({
  workspacePath, fileSocket, activeFile,
  tab, onTabChange, width, onResize, onClose,
  onOpenFile, onNewTerminal, onAddWorkspace, homeDir,
  hiddenRepos = [], onHiddenReposChange, isDesktop = true
}) {
  const { t } = useI18n();
  const { repos, refresh: refreshRepos, scanning, deep, scanDeeper } = useWorkspaceRepos(workspacePath, fileSocket);
  const { roots, refresh: refreshRoots } = useWorkspaceRoots(workspacePath, fileSocket);
  const refresh = () => { refreshRepos(); refreshRoots(); };

  // Three filters, cheapest first: repos the user marked reference-only never show;
  // unchanged repos hide until asked for; and only the open repo mounts an ScmPanel, so
  // N clones cost one `git status` rather than N. Both choices are per-workspace, hence
  // the forWorkspace stamp — otherwise another workspace's repo stays marked open.
  const [gitView, setGitView] = useState({ forWorkspace: workspacePath, showClean: false, openRepo: null });
  const view = gitView.forWorkspace === workspacePath ? gitView : { showClean: false, openRepo: null };
  const showCleanRepos = view.showClean;
  const openRepo = view.openRepo; // null = auto-open a lone repo, "" = all collapsed
  const setShowCleanRepos = (showClean) => setGitView({ ...view, forWorkspace: workspacePath, showClean });
  const setOpenRepo = (repo) => setGitView({ ...view, forWorkspace: workspacePath, openRepo: repo });

  const hiddenSet = new Set(hiddenRepos);
  const visibleRepos = repos.filter((r) => !hiddenSet.has(r.path));
  const dirtyRepos = visibleRepos.filter((r) => r.changedCount > 0);
  const gitRepos = showCleanRepos ? visibleRepos : dirtyRepos;
  const hiddenCleanCount = showCleanRepos ? 0 : visibleRepos.length - dirtyRepos.length;
  const mutedCount = repos.length - visibleRepos.length;
  // With a single repo in play there is nothing to choose between, so open it outright.
  const activeRepo = openRepo ?? (gitRepos.length === 1 ? gitRepos[0].path : null);

  const hideRepo = (repoPath) => onHiddenReposChange?.([...hiddenRepos, repoPath]);
  // Nested repos only: the workspace root has no relPath, and hiding it would leave this
  // tab permanently empty with no obvious way back.
  const canHideRepo = (repo) => !!onHiddenReposChange && !!repo.relPath;

  // Labels track the PANEL's width, not the window's: a 200px panel on a wide screen
  // still has no room for them.
  const showTabLabels = !isDesktop || width >= RIGHT_PANEL_WIDTH.default;

  // Reset the open root when the workspace changes, without an effect round-trip.
  const [rootState, setRootState] = useState({ forWorkspace: workspacePath, path: workspacePath });
  const activeRoot = rootState.forWorkspace === workspacePath ? rootState.path : workspacePath;
  const setActiveRoot = (path) => setRootState({ forWorkspace: workspacePath, path });

  const startResize = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev) => onResize?.(startW - (ev.clientX - startX));
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  };

  return (
    <div
      className="h-full flex flex-col bg-surface-3 border-l border-border-subtle relative shrink"
      style={isDesktop ? { width, flexBasis: width, minWidth: RIGHT_PANEL_WIDTH.min } : undefined}
    >
      {/* Tabs — underline style, matching the terminal tab bar rather than inventing pills */}
      <div style={{ height: PANEL_HEADER_HEIGHT }}
        className="pl-1 pr-0.5 flex items-stretch gap-0 border-b border-border-subtle flex-shrink-0">
        {TABS.map(({ key, icon: TabIcon, labelKey }) => (
          <button
            key={key}
            onClick={() => { vibrate(); onTabChange(key); }}
            className={`px-2 flex items-center justify-center gap-1 text-[11px] border-b-2 -mb-px transition-colors ${
              tab === key
                ? "text-text border-brand-500"
                : "text-text-muted border-transparent hover:text-text"
            }`}
            title={t(labelKey)}
          >
            <TabIcon size={13} />
            {showTabLabels && <span>{t(labelKey)}</span>}
          </button>
        ))}
        <div className="flex-1" />
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => { vibrate(); refresh(); }}
            disabled={scanning}
            className="p-1 text-text-muted hover:text-text rounded-[3px] hover:bg-surface-2 transition-colors disabled:opacity-40"
            title={t("workspaces.refreshRepos")}
          >
            <RefreshCw size={13} className={scanning ? "animate-spin" : ""} />
          </button>
          {onClose && (
            <button
              onClick={() => { vibrate(); onClose(); }}
              className="p-1 text-text-muted hover:text-text rounded-[3px] hover:bg-surface-2 transition-colors"
              title={t("common.close")}
            >
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {!workspacePath ? (
          <div className="p-4 flex flex-col items-center gap-2 text-center">
            <Folder size={22} className="text-text-subtle" />
            <p className="text-xs text-text-subtle">{t("workspaces.emptyWorkspace")}</p>
            {onAddWorkspace && (
              <button
                onClick={() => { vibrate(); onAddWorkspace(); }}
                className="mt-1 px-2 py-1 text-[11px] text-brand-500 bg-brand-500/10 hover:bg-brand-500/20 rounded-[3px] transition-colors"
              >
                {t("workspaces.selectFolder")}
              </button>
            )}
          </div>
        ) : tab === "files" ? (
          roots.map((root) => (
            <RootSection
              key={root.path}
              root={root}
              multiple={roots.length > 1}
              isOpen={roots.length === 1 || activeRoot === root.path}
              onToggle={() => setActiveRoot(activeRoot === root.path ? null : root.path)}
            >
              <ExplorerPanel
                workspace={root.path}
                fileSocket={fileSocket}
                activeFile={activeFile}
                onOpenFile={onOpenFile}
                onNewTerminal={onNewTerminal}
                compact
              />
            </RootSection>
          ))
        ) : tab === "git" ? (
          <div className="flex-1 min-h-0 overflow-y-auto modal-scrollable">
            {/* A workspace holding many clones would otherwise list every one of them and
                mount a git-status panel each. Only repos with changes show by default. */}
            {gitRepos.map((repo) => (
              <RepoSection
                key={repo.path}
                repo={repo}
                isOpen={activeRepo === repo.path}
                onToggle={() => setOpenRepo(activeRepo === repo.path ? "" : repo.path)}
                onHide={canHideRepo(repo) ? () => hideRepo(repo.path) : null}
              >
                <ScmPanel workspace={repo.path} fileSocket={fileSocket} onOpenFile={onOpenFile} tagDiffWithRepo />
              </RepoSection>
            ))}

            {!gitRepos.length && !scanning && (
              <p className="p-4 text-xs text-text-subtle italic">
                {showCleanRepos ? t("workspaces.emptyWorkspace") : t("git.noChanges")}
              </p>
            )}

            {/* Only drawn when it has something to offer — an empty bordered strip under
                an empty list reads as a broken panel. */}
            {(hiddenCleanCount > 0 || mutedCount > 0 || !deep) && (
            <div className="border-t border-border-subtle mt-1">
              {hiddenCleanCount > 0 && (
                <FooterAction onClick={() => setShowCleanRepos(true)}>
                  {t("workspaces.showCleanRepos", { count: hiddenCleanCount })}
                </FooterAction>
              )}
              {mutedCount > 0 && (
                <FooterAction onClick={() => onHiddenReposChange?.([])}>
                  {t("workspaces.showHiddenRepos", { count: mutedCount })}
                </FooterAction>
              )}
              {!deep && (
                <FooterAction onClick={scanDeeper}>{t("workspaces.scanDeeper")}</FooterAction>
              )}
            </div>
            )}
          </div>
        ) : (
          <WorktreePanel
            workspacePath={workspacePath}
            fileSocket={fileSocket}
            onNewTerminal={onNewTerminal}
            homeDir={homeDir}
            onChanged={refresh}
          />
        )}
      </div>

      {isDesktop && (
        <div
          onPointerDown={startResize}
          className="absolute top-0 left-0 bottom-0 w-1 cursor-col-resize hover:bg-brand-500/40 transition-colors z-20"
        />
      )}
    </div>
  );
}

// A worktree root gets its own collapsible section; a lone root renders bare.
function RootSection({ root, multiple, isOpen, onToggle, children }) {
  if (!multiple) return <div className="flex-1 min-h-0 flex flex-col">{children}</div>;
  return (
    <div className={`flex flex-col min-h-0 ${isOpen ? "flex-1" : "flex-shrink-0"}`}>
      <button
        onClick={() => { vibrate(); onToggle(); }}
        className="px-2 py-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-text-muted hover:text-text bg-surface-2/40 hover:bg-surface-2 border-b border-border-subtle transition-colors"
        title={root.path}
      >
        <ChevronRight size={11} className={`flex-shrink-0 transition-transform duration-150 ${isOpen ? "rotate-90" : ""}`} />
        {/* Worktrees of one repo share a name, so the branch is what tells them apart —
            it leads, and the directory follows in the tooltip. */}
        <span className="truncate flex-1 text-left">
          {root.branch || root.name || root.path.split("/").pop()}
        </span>
        {!root.isMain && (
          <GitFork size={10} className="flex-shrink-0 opacity-60" />
        )}
      </button>
      {isOpen && <div className="flex-1 min-h-0 flex flex-col">{children}</div>}
    </div>
  );
}

function FooterAction({ onClick, children }) {
  return (
    <button
      onClick={() => { vibrate(); onClick(); }}
      className="w-full px-3 py-1.5 text-[11px] text-text-subtle hover:text-text hover:bg-surface-2 transition-colors text-left"
    >
      {children}
    </button>
  );
}

// Collapsed by default: mounting a ScmPanel per repo means one `git status` per repo.
function RepoSection({ repo, isOpen, onToggle, onHide, children }) {
  const { t } = useI18n();
  return (
    <div className="border-b border-border-subtle last:border-0">
      <button
        onClick={() => { vibrate(); onToggle(); }}
        className="group/repo w-full sticky top-0 z-10 px-2 py-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-text-muted hover:text-text bg-surface-3 border-b border-border-subtle transition-colors"
      >
        <ChevronRight size={11} className={`flex-shrink-0 transition-transform duration-150 ${isOpen ? "rotate-90" : ""}`} />
        <span className="truncate flex-1 text-left">{repo.relPath || repo.name}</span>
        {repo.branch && <span className="text-text-subtle normal-case tracking-normal truncate max-w-[45%]">{repo.branch}</span>}
        {repo.changedCount > 0 && (
          <span className="px-1 rounded-[2px] bg-brand-500/15 text-brand-500 normal-case tracking-normal flex-shrink-0">
            {repo.changedCount}
          </span>
        )}
        {onHide && (
          <span
            role="button"
            tabIndex={-1}
            onClick={(e) => { e.stopPropagation(); vibrate(); onHide(); }}
            className="p-0.5 text-text-subtle hover:text-text flex-shrink-0 opacity-100 sm:opacity-0 sm:group-hover/repo:opacity-100 transition-opacity"
            title={t("workspaces.hideRepo")}
          >
            <EyeOff size={11} />
          </span>
        )}
      </button>
      {isOpen && children}
    </div>
  );
}
