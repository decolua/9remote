"use client";

import { useCallback, useEffect } from "react";
import { useI18n } from "@/shared/i18n";
import { sessionWorkspaceId } from "@/features/terminal/lib/paneLayout";

// Session/workspace navigation: select, create, delete, rename, and the workspace-aware
// tab cycling used by the PC input bar.
export function useSessionNavigation({
  sessions, currentView, viewStack, setViewStack, pushView, storePopView,
  activeWorkspaceId, setActiveWorkspaceId, activeSessionId,
  addOpenedSession, removeOpenedSession, touchLivePane,
  createSession, deleteSession, renameSession, clearNotification
}) {
  const { t } = useI18n();

  // Replace the top of the stack with a terminal view for this session
  const replaceTopWithSession = useCallback((sessionId) => {
    const newStack = [...viewStack];
    newStack[newStack.length - 1] = { type: "terminal", sessionId };
    setViewStack(newStack);
  }, [viewStack, setViewStack]);

  // Session ids belonging to a workspace, in list order
  const workspaceSessionIds = useCallback(
    (workspaceId) => sessions.filter((s) => sessionWorkspaceId(s) === (workspaceId ?? null)).map((s) => s.id),
    [sessions]
  );

  // Inherit cwd from the last session in the same workspace (null when none/ungrouped)
  const lastWorkspaceCwd = useCallback((workspaceId) => {
    const inWorkspace = sessions.filter((s) => sessionWorkspaceId(s) === (workspaceId ?? null) && s.cwd);
    return inWorkspace.length ? inWorkspace[inWorkspace.length - 1].cwd : null;
  }, [sessions]);

  const alertCreateFailed = useCallback(
    (error) => alert(t("workspace.failedCreateSession", { error })),
    [t]
  );

  // Entering terminal view: open sessions of the selected session's workspace, set it active
  const handleSelectSession = useCallback((sessionId) => {
    const selected = sessions.find(s => s.id === sessionId);
    const workspaceId = sessionWorkspaceId(selected);
    setActiveWorkspaceId(workspaceId);
    const ids = workspaceSessionIds(workspaceId);
    ids.forEach(id => addOpenedSession(id));
    addOpenedSession(sessionId);
    touchLivePane([...ids, sessionId]); // keep this workspace's panes alive (LRU)
    clearNotification?.(sessionId);

    if (currentView.type === "terminal") replaceTopWithSession(sessionId);
    else pushView({ type: "terminal", sessionId });
  }, [
    sessions, workspaceSessionIds, addOpenedSession, touchLivePane, setActiveWorkspaceId,
    currentView, pushView, clearNotification, replaceTopWithSession
  ]);

  // Deep-link from a push notification tap (SW postMessage): open the right terminal
  useEffect(() => {
    const onMessage = (e) => {
      if (e.data?.type !== "NOTIFICATION_CLICK") return;
      const sid = new URLSearchParams(new URL(e.data.url || "", location.origin).search).get("t");
      if (sid) handleSelectSession(sid);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [handleSelectSession]);

  // Tab/Shift+Tab in the PC input bar cycles sessions within the active workspace (wrap-round)
  const switchSession = useCallback((direction) => {
    const ids = workspaceSessionIds(activeWorkspaceId);
    if (ids.length < 2) return;
    const idx = ids.indexOf(activeSessionId);
    if (idx === -1) return;
    const next = direction === "prev"
      ? (idx - 1 + ids.length) % ids.length
      : (idx + 1) % ids.length;
    handleSelectSession(ids[next]);
  }, [workspaceSessionIds, activeWorkspaceId, activeSessionId, handleSelectSession]);

  // Ctrl+1..9 in the PC input bar jumps to the Nth session in the active workspace
  const switchToIndex = useCallback((i) => {
    const ids = workspaceSessionIds(activeWorkspaceId);
    if (i < 0 || i >= ids.length) return;
    handleSelectSession(ids[i]);
  }, [workspaceSessionIds, activeWorkspaceId, handleSelectSession]);

  // Named create (from the session list / sidebar / file tree). Keeps activeWorkspaceId
  // unchanged — the new session isn't in `sessions` yet (loadSessions is async) so
  // handleSelectSession would reset it. `cwd` overrides the inherited one (tree "new terminal here").
  const handleCreateSession = useCallback((name, workspaceId = null, shellId = null, cwd = null) => {
    createSession(name, shellId, workspaceId, cwd || lastWorkspaceCwd(workspaceId), (result) => {
      if (!result.success) return alertCreateFailed(result.error);
      if (!result.sessionId) return;
      addOpenedSession(result.sessionId);
      // Auto-select the new terminal when created from within terminal view
      if (currentView.type === "terminal") replaceTopWithSession(result.sessionId);
    });
  }, [createSession, lastWorkspaceCwd, addOpenedSession, alertCreateFailed, currentView, replaceTopWithSession]);

  // Quick create in the active workspace (header "+" button)
  const handleQuickCreateSession = useCallback((shellId) => {
    createSession(null, shellId, activeWorkspaceId, lastWorkspaceCwd(activeWorkspaceId), (result) => {
      if (!result.success) return alertCreateFailed(result.error);
      if (!result.sessionId) return;
      addOpenedSession(result.sessionId);
      replaceTopWithSession(result.sessionId);
    });
  }, [createSession, activeWorkspaceId, lastWorkspaceCwd, addOpenedSession, alertCreateFailed, replaceTopWithSession]);

  // Create from the FileExplorer bottom panel — stay in the current view
  const handleCreateSessionInline = useCallback((onCreated) => {
    createSession(null, (result) => {
      if (!result.success) return alertCreateFailed(result.error);
      if (!result.sessionId) return;
      addOpenedSession(result.sessionId);
      onCreated?.(result.sessionId);
    });
  }, [createSession, addOpenedSession, alertCreateFailed]);

  // Switch active workspace in terminal view — focus its first session
  const handleSelectWorkspace = useCallback((workspaceId) => {
    setActiveWorkspaceId(workspaceId);
    const inWorkspace = sessions.filter(s => sessionWorkspaceId(s) === (workspaceId ?? null));
    inWorkspace.forEach(s => addOpenedSession(s.id));
    touchLivePane(inWorkspace.map(s => s.id)); // keep this workspace's panes alive (LRU)
    const first = inWorkspace[0];
    if (first) replaceTopWithSession(first.id);
  }, [sessions, setActiveWorkspaceId, addOpenedSession, touchLivePane, replaceTopWithSession]);

  const handleDeleteSession = useCallback((sessionId) => {
    const deleted = sessions.find((s) => s.id === sessionId);
    const workspaceId = sessionWorkspaceId(deleted);
    const isDeletingActive = currentView?.type === "terminal" && currentView.sessionId === sessionId;
    deleteSession(sessionId, () => {
      removeOpenedSession(sessionId);
      if (!isDeletingActive) return;
      // Focus the next session (same workspace first, then any) or fall back to the list
      const remaining = sessions.filter((s) => s.id !== sessionId);
      const sameWorkspace = remaining.filter((s) => sessionWorkspaceId(s) === workspaceId);
      const next = sameWorkspace[0] || remaining[0];
      if (next) {
        replaceTopWithSession(next.id);
        touchLivePane(next.id);
      } else {
        storePopView();
      }
    });
  }, [sessions, currentView, deleteSession, removeOpenedSession, touchLivePane, storePopView, replaceTopWithSession]);

  const handleRenameSession = useCallback((sessionId, newName) => {
    renameSession(sessionId, newName, (result) => {
      if (!result.success) alert(t("workspace.failedRenameSession", { error: result.error }));
    });
  }, [renameSession, t]);

  return {
    lastWorkspaceCwd,
    handleSelectSession,
    handleSelectWorkspace,
    handleCreateSession,
    handleQuickCreateSession,
    handleCreateSessionInline,
    handleDeleteSession,
    handleRenameSession,
    switchSession,
    switchToIndex
  };
}
