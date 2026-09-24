"use client";

import { useState, useRef, useCallback } from "react";
import { addRecentWorkspace, getRecentWorkspaces, updateRecentWorkspacePath } from "@/features/fileExplorer/components/WorkspaceList";

// File/git/browse navigation between views: opening the files view at the right cwd,
// workspace selection (recent workspaces), folder browsing, the mobile editor overlay,
// and per-workspace last-folder persistence. Verbatim moves from the workspace layout.
export function useWorkspaceFileNav({
  pushView, viewStack, setViewStack, currentView, cwdBySession, sessions = [], isDesktop, fileBus

  pushView, viewStack, setViewStack, currentView, cwdBySession, sessions = [], isDesktop, fileBus, scope = "" }) {
  const [systemInfo, setSystemInfo] = useState(null);
  // Mobile-only: file opened as an overlay above the files view (no viewStack entry), so the
  // explorer stays mounted and Back (X) returns to the same folder without a reload.
  const [mobileEditor, setMobileEditor] = useState(null);
  // Desktop: stable ref so GitPanel/explorer can ask FileWorkspaceDesktop to open a file
  // in-place (add tab + activate) without pushing a new editor view onto the stack.
  const openFileRef = useRef(null);

  const handleOpenWorkspaceList = useCallback(async () => {
    // Fetch system info when opening the workspaces view
    if (!systemInfo) {
      const info = await fileBus.getSystemInfo();
      if (info.success) setSystemInfo(info);
    }
    pushView({ type: "workspaces" });
  }, [pushView, fileBus, systemInfo]);

  const handleOpenFiles = useCallback(async (prefWorkspace) => {
    // Explicit workspace (side panel's "open full") wins over the terminal's cwd
    if (prefWorkspace) {
      addRecentWorkspace(prefWorkspace, scope);
      pushView({ type: "files", workspace: prefWorkspace, currentPath: prefWorkspace });
      return;
    }
    // From terminal: open the explorer at the active terminal's cwd. Chat UI panes
    // emit no terminal OSC 7, so their dir comes from the session record.
    if (currentView.type === "terminal") {
      const cwd = currentView.sessionId
        ? cwdBySession[currentView.sessionId] || sessions.find((s) => s.id === currentView.sessionId)?.cwd || null
        : null;
      if (cwd) {
        addRecentWorkspace(cwd, scope);
        pushView({ type: "files", workspace: cwd, currentPath: cwd });
        return;
      }
    }
    // Fallback: auto-open the most recent workspace (restore last folder); else show the list
    const recent = getRecentWorkspaces(scope);
    if (recent.length > 0) {
      const last = recent[0];
      pushView({ type: "files", workspace: last.path, currentPath: last.lastPath || last.path });
      return;
    }
    handleOpenWorkspaceList();
  }, [pushView, handleOpenWorkspaceList, currentView, cwdBySession, sessions, scope]);

  const handleSelectWorkspace = useCallback((workspacePath) => {
    addRecentWorkspace(workspacePath, scope);
    // Replace existing workspaces/files views so Back doesn't revisit the old workspace/selector
    const cleaned = viewStack.filter(v => v.type !== "workspaces" && v.type !== "files");
    setViewStack([...cleaned, { type: "files", workspace: workspacePath }]);
  }, [viewStack, setViewStack]);

  const handleBrowseFolder = useCallback((startPath) => {
    pushView({ type: "browse", path: startPath });
  }, [pushView]);

  const handlePathChange = useCallback((workspacePath, currentPath) => {
    // Persist the last visited folder per workspace so the next open restores it.
    // Do NOT patch viewStack here — FileExplorer's onPathChange fires on every currentPath
    // change (incl. agent-normalized paths) and writing it back triggers a re-mount loop.
    updateRecentWorkspacePath(workspacePath, currentPath, scope);
  }, []);

  const handleOpenFile = useCallback((filePath, folderPath, opts = {}) => {
    // Mobile: render the editor as an overlay above the current view (no viewStack push)
    if (!isDesktop) {
      setMobileEditor({ path: filePath, line: opts.line, column: opts.column, workspace: currentView.workspace });
      return;
    }
    // Desktop: open in-place via the workspace tabs (no viewStack push → no nested back)
    openFileRef.current?.(filePath, opts);
  }, [isDesktop, currentView.workspace]);

  const handleOpenGit = useCallback(() => {
    const filesView = viewStack.find(v => v.type === "files");
    if (filesView?.workspace) pushView({ type: "git", workspace: filesView.workspace });
  }, [pushView, viewStack]);

  const handleSetWorkspace = useCallback((workspacePath) => {
    // Replace browse/workspaces/files views so Back doesn't revisit the browse selector
    addRecentWorkspace(workspacePath, scope);
    const cleaned = viewStack.filter(v => v.type !== "browse" && v.type !== "workspaces" && v.type !== "files");
    setViewStack([...cleaned, { type: "files", workspace: workspacePath }]);
  }, [viewStack, setViewStack]);

  return {
    systemInfo,
    mobileEditor,
    setMobileEditor,
    openFileRef,
    handleOpenWorkspaceList,
    handleOpenFiles,
    handleSelectWorkspace,
    handleBrowseFolder,
    handlePathChange,
    handleOpenFile,
    handleOpenGit,
    handleSetWorkspace
  };
}
