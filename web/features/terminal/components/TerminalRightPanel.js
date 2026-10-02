"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { startWidthDrag } from "@/shared/utils/dragResize";
import { ChevronRight, ChevronsDownUp, Eye, EyeOff, ExternalLink, File, Files, Folder, FolderPlus, GitBranch, GitFork, Loader2, Plus, RefreshCw, Search, Trash2, X } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { PANEL_HEADER_H_CLASS } from "@/shared/constants/layout";
import { vibrate } from "@/shared/utils/vibration";
import { RIGHT_PANEL_WIDTH } from "../constants/terminalConfig";
import { useWorkspaceRepos } from "../hooks/useWorkspaceRepos";
import { useWorkspaceRoots } from "../hooks/useWorkspaceRoots";
import { useWorkspaceGit } from "../hooks/useWorkspaceGit";
import { GIT_REFRESH_EVENT } from "@/features/fileExplorer/constants/fileExplorer.js";
import { useFileBusStore } from "@/shared/stores/fileBusStore";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";
import ExplorerPanel from "@/features/fileExplorer/components/ExplorerPanel";
import ScmPanel from "@/features/fileExplorer/components/ScmPanel";

const TABS = [
  { key: "files", icon: Files, labelKey: "workspaces.tabFiles" },
  { key: "git", icon: GitBranch, labelKey: "workspaces.tabGit" },
  { key: "trees", icon: GitFork, labelKey: "workspaces.tabTrees" }
];
// TEMP: worktrees tab hidden — removing a worktree lives on each root's header in the files tab
const VISIBLE_TABS = TABS.filter((t) => t.key !== "trees");

// Secondary sidebar docked right of the terminal panes: file tree, git, worktrees.
// Roots are the workspace itself plus each of its worktrees — separate directories on
// disk, so they cannot share one tree.
function TerminalRightPanel({
  workspacePath, filesRoot = null, cwdHint = null, fileBus, activeFile,
  tab, onTabChange, width, onResize, onClose,
  onOpenFile, onNewTerminal, onAddWorkspace, onOpenFiles, homeDir,
  changedPerRepo = {}, hiddenRepos = [], onHiddenReposChange, isDesktop = true
}) {
  const { t } = useI18n();
  const activeFileBus = fileBus || useFileBusStore.getState();
  // A persisted "trees" tab must not strand the panel on hidden content
  const activeTab = tab === "trees" ? "git" : tab;
  const { repos, refresh: refreshRepos, scanning, deep, scanDeeper } = useWorkspaceRepos(workspacePath, activeFileBus);
  // The files tab may be revealed at a pane's live cwd; the other tabs stay workspace-rooted
  const effectiveFilesRoot = filesRoot || workspacePath;
  const { roots, refresh: refreshRoots } = useWorkspaceRoots(effectiveFilesRoot, activeFileBus);
  const refresh = () => { refreshRepos(); refreshRoots(); };

  // A checkout in a terminal leaves every panel here showing the old branch. Reuse the
  // shared (ref-counted) branch poll and rescan only when the branch itself changed —
  // keying off the dirty count instead would rescan on every keystroke-driven edit.
  const { branch: liveBranch } = useWorkspaceGit(workspacePath, activeFileBus);
  // Stamped with the path so switching workspace is not read as a checkout, and the
  // first poll result (null → branch) only seeds the baseline the mount already loaded.
  const lastBranchRef = useRef({ path: null, branch: null });
  useEffect(() => {
    const seen = lastBranchRef.current;
    lastBranchRef.current = { path: workspacePath, branch: liveBranch };
    if (seen.path !== workspacePath || seen.branch === null || seen.branch === liveBranch) return;
    refreshRepos();
    refreshRoots();
    window.dispatchEvent(new Event(GIT_REFRESH_EVENT));
    // refreshRepos/refreshRoots are stable per (path, bus) — the branch drives this
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveBranch, workspacePath]);

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
  // The live per-repo counts win over the ones baked into the scan result: the scan is
  // refreshed by hand, the counts are polled, and the pane badge reads the same numbers.
  const countOf = (repo) => changedPerRepo[repo.path] ?? repo.changedCount ?? 0;
  const isMainRepo = (repo) => !repo.relPath || repo.path === workspacePath;
  const visibleRepos = repos.filter((r) => !hiddenSet.has(r.path));
  const dirtyRepos = visibleRepos.filter((r) => countOf(r) > 0);
  // Badge on the Git tab: total changed files across the workspace's repos
  const dirtyCount = dirtyRepos.reduce((n, r) => n + countOf(r), 0);
  // Main repo is kept visible even when unchanged so its branch and push actions stay accessible.
  const gitRepos = showCleanRepos ? visibleRepos : visibleRepos.filter((r) => countOf(r) > 0 || isMainRepo(r));
  const hiddenCleanCount = showCleanRepos ? 0 : visibleRepos.length - gitRepos.length;
  const mutedCount = repos.length - visibleRepos.length;
  // With a single repo in play there is nothing to choose between, so open it outright.
  const activeRepo = openRepo ?? (gitRepos.length === 1 ? gitRepos[0].path : null);

  const hideRepo = (repoPath) => onHiddenReposChange?.([...hiddenRepos, repoPath]);
  // Nested repos only: the workspace root has no relPath, and hiding it would leave this
  // tab permanently empty with no obvious way back.
  const canHideRepo = (repo) => !!onHiddenReposChange && !isMainRepo(repo);

  // Two visible tabs (trees is hidden) leave room for labels even at min width.
  const showTabLabels = !isDesktop || width >= RIGHT_PANEL_WIDTH.min;

  // The tree publishes its own actions so they can live in the tab bar above it.
  const [treeActions, setTreeActions] = useState(null);

  // Worktree removal from a root header: probe lists what removal takes with it,
  // the dialog confirms, then removal closes the rooted sessions server-side.
  const [removeTarget, setRemoveTarget] = useState(null); // { root, sessions, branchMerged, dirty }
  const [rootError, setRootError] = useState(null);
  const [branchKept, setBranchKept] = useState(null);
  const mainRepoPath = roots.find((r) => r.isMain)?.path || workspacePath;

  const askRemove = async (root) => {
    setRootError(null);
    const res = await activeFileBus.gitWorktreeRemove(mainRepoPath, root.path, { probe: true, deleteBranch: root.branch || undefined });
    if (!res?.success) return setRootError(res?.error || "Probe failed");
    setRemoveTarget({ root, sessions: res.sessions || [], branchMerged: res.branchMerged });
  };
  const removeRoot = async (root, force = false) => {
    setRootError(null);
    setBranchKept(null);
    const res = await activeFileBus.gitWorktreeRemove(mainRepoPath, root.path, { confirmed: true, force, deleteBranch: root.branch || undefined });
    if (!res?.success && /use --force/i.test(res?.error || "")) {
      return setRemoveTarget({ root, dirty: true });
    }
    setRemoveTarget(null);
    if (!res?.success) return setRootError(res?.error || "Remove failed");
    if (res.branchKept) setBranchKept(root.branch);
    refresh();
  };

  // Which root opens by default: the worktree the focused terminal stands in (longest
  // matching prefix — a cwd deep inside it still resolves to that worktree), else main.
  const rootProbe = cwdHint || effectiveFilesRoot;
  const defaultRoot = useMemo(() => {
    const inside = roots.filter((r) => rootProbe === r.path || rootProbe?.startsWith(`${r.path}/`));
    if (inside.length) return inside.sort((a, b) => b.path.length - a.path.length)[0].path;
    return (roots.find((r) => r.isMain) || roots[0])?.path || effectiveFilesRoot;
  }, [roots, rootProbe, effectiveFilesRoot]);

  // Reset the open root when the workspace or the focused terminal's cwd changes, without
  // an effect round-trip. Seeded unstamped so the first render falls through to
  // defaultRoot rather than the raw path.
  const [rootState, setRootState] = useState({ forProbe: null, path: null });
  const activeRoot = rootState.forProbe === rootProbe ? rootState.path : defaultRoot;
  const setActiveRoot = (path) => setRootState({ forProbe: rootProbe, path });

  // File search over the effective root or specific folder
  const [searchState, setSearchState] = useState({ forRoot: null, searchDir: null, show: false, query: "", results: [], loading: false });
  // Search options persist across searches (VSCode keeps them for the session).
  const [searchOpts, setSearchOpts] = useState({ caseSensitive: false, wholeWord: false, regex: false });
  // A stale search from another root reads as closed, without an effect round-trip.
  const search = searchState.forRoot === effectiveFilesRoot
    ? searchState
    : { show: false, searchDir: null, query: "", results: [], loading: false };
  const searchTimerRef = useRef(null);

  const closeSearch = useCallback(() => {
    setSearchState({ forRoot: null, searchDir: null, show: false, query: "", results: [], loading: false });
  }, []);

  const toggleSearch = () => {
    if (search.show) return closeSearch();
    setSearchState({ forRoot: effectiveFilesRoot, searchDir: null, show: true, query: "", results: [], loading: false });
  };

  const handleSearchInFolder = useCallback((folderPath) => {
    setSearchState({ forRoot: effectiveFilesRoot, searchDir: folderPath, show: true, query: "", results: [], loading: false });
  }, [effectiveFilesRoot]);

  const clearSearchDir = useCallback(() => {
    setSearchState((prev) => {
      const next = { ...prev, searchDir: null };
      if (prev.query && prev.query.length >= 2) {
        next.loading = true;
        activeFileBus.searchInFiles(effectiveFilesRoot, prev.query, searchOpts).then((result) => {
          setSearchState((s) => (s.loading ? { ...s, results: result.success ? result.results : [], loading: false } : s));
        });
      }
      return next;
    });
  }, [activeFileBus, effectiveFilesRoot, searchOpts]);

  const handleSearch = useCallback((query) => {
    setSearchState((prev) => ({ ...prev, query }));
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (!query || query.length < 2) {
      setSearchState((prev) => ({ ...prev, results: [], loading: false }));
      return;
    }
    setSearchState((prev) => ({ ...prev, loading: true }));
    const targetDir = search.searchDir || effectiveFilesRoot;
    searchTimerRef.current = setTimeout(async () => {
      const result = await activeFileBus.searchInFiles(targetDir, query, searchOpts);
      // Ignore out-of-order replies once the query moved on.
      setSearchState((prev) => (prev.query === query && prev.loading
        ? { ...prev, results: result.success ? result.results : [], loading: false }
        : prev));
    }, 300);
  }, [activeFileBus, effectiveFilesRoot, search.searchDir, searchOpts]);

  // Re-run the current search when an option flips (query unchanged).
  const rerunSearch = useCallback((opts) => {
    setSearchState((prev) => {
      if (!prev.query || prev.query.length < 2) return prev;
      const next = { ...prev, loading: true };
      activeFileBus.searchInFiles(prev.searchDir || effectiveFilesRoot, prev.query, opts).then((result) => {
        setSearchState((s) => (s.loading ? { ...s, results: result.success ? result.results : [], loading: false } : s));
      });
      return next;
    });
  }, [activeFileBus, effectiveFilesRoot]);

  const toggleSearchOpt = (key) => {
    const nextOpts = { ...searchOpts, [key]: !searchOpts[key] };
    setSearchOpts(nextOpts);
    rerunSearch(nextOpts);
  };

  // Clear the debounce timer on unmount.
  useEffect(() => () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); }, []);

  const startResize = (e) =>
    startWidthDrag(e, { startWidth: width, axis: -1, onWidth: (w) => onResize?.(w) });

  return (
    <div
      className={`h-full flex flex-col terminal-sidebar-bg border-l border-border-subtle relative shrink ${isDesktop ? "" : "pb-safe"}`}
      style={isDesktop ? { width, flexBasis: width, minWidth: RIGHT_PANEL_WIDTH.min } : undefined}
    >
      {/* Tabs — underline style, matching the terminal tab bar rather than inventing pills */}
      <div className={`h-11 ${PANEL_HEADER_H_CLASS} pl-1 pr-0.5 flex items-stretch gap-0 border-b border-border-subtle flex-shrink-0`}>
        {VISIBLE_TABS.map(({ key, icon: TabIcon, labelKey }) => (
          <button
            key={key}
            onClick={() => { vibrate(); onTabChange(key); }}
            className={`px-3 sm:px-2 flex items-center justify-center gap-1 text-[11px] border-b-2 -mb-px transition-colors ${
              activeTab === key
                ? "text-text border-brand-500"
                : "text-text-muted border-transparent hover:text-text"
            }`}
            title={t(labelKey)}
          >
            <TabIcon size={18} className="sm:w-[15px] sm:h-[15px]" />
            {showTabLabels && <span>{t(labelKey)}</span>}
            {key === "git" && dirtyCount > 0 && (
              <span className="min-w-[14px] h-[14px] px-[4px] rounded-full bg-brand-500 text-white text-[9px] font-semibold flex items-center justify-center leading-none">
                {dirtyCount > 99 ? "99+" : dirtyCount}
              </span>
            )}
          </button>
        ))}
        <div className="flex-1" />
        <div className="flex items-center gap-1 sm:gap-0.5">
          <PanelButton
            icon={RefreshCw}
            label={t("workspaces.refreshRepos")}
            onClick={() => { refresh(); treeActions?.refresh?.(); }}
            disabled={scanning}
            spinning={scanning}
          />
          {onClose && <PanelButton icon={X} label={t("common.close")} onClick={onClose} />}
        </div>
      </div>

      {/* Files-tab actions get their own row, right-aligned: tabs + six buttons in one
          strip overflowed the panel's narrow width. Rendered whenever the files tab is
          up (not gated on treeActions) so the header height doesn't jump when the tree
          registers. */}
      {activeTab === "files" && workspacePath && (
        <div className={`${search.show ? "py-1" : `h-11 ${PANEL_HEADER_H_CLASS}`} px-2 flex items-center gap-1.5 border-b border-border-subtle flex-shrink-0`}>
          {search.show ? (
            <div className="flex-1 flex flex-col min-w-0 gap-1 py-1">
              <div className="flex items-center gap-1.5 min-w-0">
                <Search size={14} className="text-text-subtle shrink-0" />
                <input
                  type="text"
                  value={search.query}
                  onChange={(e) => handleSearch(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Escape") closeSearch(); }}
                  placeholder={search.searchDir ? `Search in ${search.searchDir.split("/").pop()}…` : t("files.searchPlaceholder")}
                  className="flex-1 min-w-0 w-0 bg-transparent text-xs text-text placeholder-text-subtle focus:outline-none"
                  autoFocus
                />
                {search.loading ? (
                  <Loader2 size={13} className="animate-spin text-brand-500 shrink-0" />
                ) : search.query ? (
                  <button
                    type="button"
                    onClick={() => handleSearch("")}
                    className="p-1 text-text-subtle hover:text-text"
                  >
                    <X size={12} />
                  </button>
                ) : null}
                <PanelButton icon={X} label={t("common.close")} onClick={closeSearch} />
              </div>
              <div className="flex items-center gap-1 pl-0.5">
                <SearchOptBtn active={searchOpts.caseSensitive} onClick={() => toggleSearchOpt("caseSensitive")} title="Match Case">Aa</SearchOptBtn>
                <SearchOptBtn active={searchOpts.wholeWord} onClick={() => toggleSearchOpt("wholeWord")} title="Whole Word">ab</SearchOptBtn>
                <SearchOptBtn active={searchOpts.regex} onClick={() => toggleSearchOpt("regex")} title="Regex">.*</SearchOptBtn>
              </div>
            </div>
          ) : (
            <>
              {treeActions && (
                <>
                  <PanelButton icon={Plus} label={t("files.newFile")} onClick={treeActions.newFile} />
                  <PanelButton icon={FolderPlus} label={t("files.newFolder")} onClick={treeActions.newFolder} />
                </>
              )}
              <PanelButton
                icon={Search}
                label={t("files.searchFiles")}
                onClick={toggleSearch}
                active={search.show}
              />
              <div className="flex-1" />
              {treeActions?.hasExpanded && (
                <PanelButton
                  icon={ChevronsDownUp}
                  label={t("fileExplorer.collapseAll")}
                  onClick={treeActions.collapseAll}
                />
              )}
              {treeActions && (
                <PanelButton
                  icon={treeActions.showHidden ? Eye : EyeOff}
                  label={t("files.toggleHidden")}
                  onClick={treeActions.toggleHidden}
                  active={treeActions.showHidden}
                />
              )}
              {onOpenFiles && (
                <PanelButton icon={ExternalLink} label={t("workspaces.openFullFiles")} onClick={onOpenFiles} />
              )}
            </>
          )}
        </div>
      )}

      {/* Scope banner when searching a specific folder */}
      {activeTab === "files" && workspacePath && search.show && search.searchDir && (
        <div className="px-3 py-1 bg-surface-3/40 border-b border-border-subtle flex items-center justify-between text-[11px] text-text-muted flex-shrink-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <Folder size={12} className="text-yellow-500/80 shrink-0" />
            <span className="text-text-subtle shrink-0">Folder:</span>
            <span className="font-medium text-text truncate max-w-[150px]" title={search.searchDir}>
              {search.searchDir.split("/").pop()}
            </span>
          </div>
          <button
            type="button"
            onClick={clearSearchDir}
            className="text-brand-500 hover:text-brand-400 hover:underline shrink-0 text-[11px] ml-2"
          >
            Search all
          </button>
        </div>
      )}

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
        ) : activeTab === "files" ? (
          search.show ? (
            <SearchResults
              results={search.results}
              loading={search.loading}
              query={search.query}
              searchDir={search.searchDir}
              workspace={effectiveFilesRoot}
              onOpen={(path, m) => onOpenFile?.(path, { line: m?.line, column: m?.column })}
            />
          ) : (
            <div className="flex-1 min-h-0 flex flex-col">
              {(rootError || branchKept) && (
                <div className="px-3 py-1.5 border-b border-border-subtle text-[11px]">
                  {rootError && <p className="text-red-500 break-words whitespace-pre-wrap">{rootError}</p>}
                  {branchKept && (
                    <p className="text-text-muted break-words">
                      {t("workspaces.worktreeBranchKept", { branch: branchKept })}
                    </p>
                  )}
                </div>
              )}
              {roots.map((root) => (
            <RootSection
              key={root.path}
              root={root}
              multiple={roots.length > 1}
              isOpen={roots.length === 1 || activeRoot === root.path}
              onToggle={() => setActiveRoot(activeRoot === root.path ? null : root.path)}
              onRemove={!root.isMain
                ? () => { vibrate(); void askRemove(root); }
                : null}
              removeLabel={t("workspaces.removeWorktree")}
            >
              <ExplorerPanel
                workspace={root.path}
                fileBus={activeFileBus}
                activeFile={activeFile}
                onOpenFile={onOpenFile}
                onNewTerminal={onNewTerminal}
                onSearchFolder={handleSearchInFolder}
                compact
                onActions={root.path === activeRoot || roots.length === 1 ? setTreeActions : undefined}
              />
            </RootSection>
              ))}
            </div>
          )
        ) : activeTab === "git" ? (
          <div className="flex-1 min-h-0 overflow-y-auto modal-scrollable">
            {/* A workspace holding many clones would otherwise list every one of them and
                mount a git-status panel each. Only repos with changes show by default. */}
            {gitRepos.map((repo) => (
              <RepoSection
                key={repo.path}
                repo={repo}
                changedCount={countOf(repo)}
                isOpen={activeRepo === repo.path}
                onToggle={() => setOpenRepo(activeRepo === repo.path ? "" : repo.path)}
                onHide={canHideRepo(repo) ? () => hideRepo(repo.path) : null}
              >
                <ScmPanel workspace={repo.path} fileBus={activeFileBus} onOpenFile={onOpenFile} tagDiffWithRepo />
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
        ) : null}
      </div>

      <ConfirmDialog
        isOpen={!!removeTarget}
        onClose={() => setRemoveTarget(null)}
        onConfirm={() => { vibrate(); void removeRoot(removeTarget.root, !!removeTarget.dirty); }}
        title={t("workspaces.removeWorktree")}
        message={removeTarget ? (
          removeTarget.dirty
            ? t("workspaces.worktreeDirty")
            : [
                t("workspaces.removeWorktreeFolder", { path: removeTarget.root.path }),
                removeTarget.root.branch && t(
                  removeTarget.branchMerged === true ? "workspaces.removeWorktreeBranchDelete"
                    : removeTarget.branchMerged === false ? "workspaces.removeWorktreeBranchKeep"
                    : "workspaces.removeWorktreeBranch",
                  { branch: removeTarget.root.branch }
                ),
                removeTarget.sessions?.length
                  ? t("workspaces.removeWorktreeSessions", {
                      count: removeTarget.sessions.length,
                      names: removeTarget.sessions.map((s) => s.name).join(", ")
                    })
                  : null
              ].filter(Boolean).join("\n")
        ) : ""}
      />

      {isDesktop && (
        <div
          onPointerDown={startResize}
          className="absolute top-0 left-0 bottom-0 w-1 cursor-col-resize hover:bg-brand-500/40 transition-colors z-20"
        />
      )}
    </div>
  );
}

// Content-search results (VSCode-style) replacing the tree while search is active:
// summary line, file groups with per-line matches, highlighted match text.
function SearchResults({ results, loading, query, searchDir, workspace, onOpen }) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(() => new Set());
  const toggle = (p) => setCollapsed((prev) => {
    const next = new Set(prev);
    next.has(p) ? next.delete(p) : next.add(p);
    return next;
  });
  if (!query || query.length < 2) {
    const dirName = searchDir ? searchDir.split("/").pop() : "";
    return (
      <div className="p-6 text-xs text-text-subtle text-center flex flex-col items-center gap-2">
        <Search size={20} className="opacity-40" />
        <span>{dirName ? `Type at least 2 characters to search in ${dirName}` : t("files.searchPlaceholder")}</span>
      </div>
    );
  }
  if (loading) return <p className="p-4 text-xs text-text-subtle text-center">{t("files.searching")}</p>;
  if (!results.length) return <p className="p-4 text-xs text-text-subtle text-center">{t("files.noFilesFound")}</p>;
  const totalMatches = results.reduce((n, f) => n + f.matches.length, 0);
  return (
    <div className="flex-1 min-h-0 overflow-y-auto modal-scrollable">
      <p className="px-2 py-1 text-[10px] text-text-muted border-b border-border-subtle sticky top-0 bg-surface z-[1]">
        {totalMatches} results in {results.length} files
      </p>
      {results.map((file) => {
        const base = file.path.split("/").pop();
        const dir = file.path.slice(0, file.path.length - base.length).replace(workspace, "").replace(/^\//, "");
        const isOpen = !collapsed.has(file.path);
        return (
          <div key={file.path} className="border-b border-border-subtle">
            <button
              onClick={() => { vibrate(); toggle(file.path); }}
              className="w-full px-2 py-1 flex items-center gap-1.5 hover:bg-surface-2 transition-colors text-left"
              title={file.path}
            >
              <ChevronRight size={11} className={`flex-shrink-0 text-text-subtle transition-transform duration-150 ${isOpen ? "rotate-90" : ""}`} />
              <File size={12} className="text-text-subtle flex-shrink-0" />
              <span className="truncate text-xs text-text">{base}</span>
              <span className="truncate text-[10px] text-text-subtle flex-1">{dir}</span>
              <span className="text-[9px] px-1 rounded-brand bg-surface-3 text-text-muted flex-shrink-0">{file.matches.length}</span>
            </button>
            {isOpen && file.matches.map((m, idx) => {
              // Exact highlight window from the server's own offsets — right for regex too.
              const hs = Math.max(0, Math.min(m.column - 1 - (m.contextStart || 0), m.lineText.length));
              const he = Math.min(m.lineText.length, hs + (m.matchLength || 0));
              return (
                <button
                  key={`${file.path}-${idx}`}
                  onClick={() => { vibrate(); onOpen(file.path, m); }}
                  className="w-full px-2 pl-6 pr-2 py-0.5 flex items-baseline gap-2 hover:bg-surface-2 transition-colors text-left"
                  title={m.lineText}
                >
                  <span className="text-[10px] text-text-subtle font-mono flex-shrink-0">{m.line}</span>
                  <span className="text-[11px] font-mono text-text-muted truncate">
                    {m.lineText.slice(0, hs)}
                    <span className="bg-brand-500/30 text-text rounded-sm">{m.lineText.slice(hs, he)}</span>
                    {m.lineText.slice(he)}
                  </span>
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

// A worktree root gets its own collapsible section; a lone root renders bare.
function RootSection({ root, multiple, isOpen, onToggle, onRemove = null, removeLabel = "", children }) {
  if (!multiple) return <div className="flex-1 min-h-0 flex flex-col">{children}</div>;
  return (
    <div className={`flex flex-col min-h-0 ${isOpen ? "flex-1" : "flex-shrink-0"}`}>
      <div className="group px-2 py-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-text-muted bg-surface-2/40 hover:bg-surface-2 border-b border-border-subtle transition-colors">
        <button
          onClick={() => { vibrate(); onToggle(); }}
          className="flex-1 min-w-0 flex items-center gap-1.5 hover:text-text transition-colors"
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
        {onRemove && (
          <button
            onClick={() => { vibrate(); onRemove(); }}
            title={removeLabel}
            className="p-0.5 shrink-0 hover:text-red-500 transition-colors"
          >
            <Trash2 size={11} />
          </button>
        )}
      </div>
      {isOpen && <div className="flex-1 min-h-0 flex flex-col">{children}</div>}
    </div>
  );
}

function PanelButton({ icon: Icon, label, onClick, active, disabled, spinning }) {
  return (
    <button
      onClick={() => { vibrate(); onClick?.(); }}
      disabled={disabled}
      title={label}
      className={`p-2 sm:p-1 rounded-[3px] hover:bg-surface-2 transition-colors disabled:opacity-40 ${
        active ? "text-brand-500" : "text-text-muted hover:text-text"
      }`}
    >
      <Icon size={16} className={`sm:w-[13px] sm:h-[13px] ${spinning ? "animate-spin" : ""}`} />
    </button>
  );
}

// VSCode-style search option toggle (Aa / ab / .*).
function SearchOptBtn({ active, onClick, title, children }) {
  return (
    <button
      type="button"
      title={title}
      onClick={() => { vibrate(); onClick(); }}
      className={`px-1 h-5 text-[10px] font-medium rounded-[3px] border transition-colors shrink-0 ${
        active
          ? "bg-brand-500 text-white border-brand-500"
          : "bg-transparent text-text-muted border-transparent hover:bg-surface-2"
      }`}
    >
      {children}
    </button>
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
function RepoSection({ repo, changedCount = 0, isOpen, onToggle, onHide, children }) {
  const { t } = useI18n();
  return (
    <div className="border-b border-border-subtle last:border-0">
      <button
        onClick={() => { vibrate(); onToggle(); }}
        className="group/repo w-full sticky top-0 z-10 px-2 py-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-text-muted hover:text-text bg-surface-3 border-b border-border-subtle transition-colors"
      >
        <ChevronRight size={11} className={`flex-shrink-0 transition-transform duration-150 ${isOpen ? "rotate-90" : ""}`} />
        <span className="truncate flex-1 text-left" title={repo.relPath || repo.name}>{repo.relPath || repo.name}</span>
        {repo.branch && <span className="text-text-subtle normal-case tracking-normal truncate max-w-[45%]" title={repo.branch}>{repo.branch}</span>}
        {changedCount > 0 && (
          <span className="px-1 rounded-[2px] bg-brand-500/15 text-brand-500 normal-case tracking-normal flex-shrink-0">
            {changedCount}
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

// Props are stabilized upstream (memoized panel descriptors, `nav`, store actions), so
// this only re-renders when something it actually shows changed.
export default memo(TerminalRightPanel);
