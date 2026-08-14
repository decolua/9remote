"use client";

import { useCallback, useEffect } from "react";
import { useI18n } from "@/shared/i18n";

// Session/group navigation: select, create, delete, rename, and the group-aware
// tab cycling used by the PC input bar.
export function useSessionNavigation({
  sessions, currentView, viewStack, setViewStack, pushView, storePopView,
  activeGroupId, setActiveGroupId, activeSessionId,
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

  // Session ids belonging to a group, in list order
  const groupSessionIds = useCallback(
    (groupId) => sessions.filter((s) => (s.groupId || null) === groupId).map((s) => s.id),
    [sessions]
  );

  // Inherit cwd from the last session in the same group (null when none/ungrouped)
  const lastGroupCwd = useCallback((groupId) => {
    const groupSessions = sessions.filter((s) => (s.groupId || null) === groupId && s.cwd);
    return groupSessions.length ? groupSessions[groupSessions.length - 1].cwd : null;
  }, [sessions]);

  const alertCreateFailed = useCallback(
    (error) => alert(t("workspace.failedCreateSession", { error })),
    [t]
  );

  // Entering terminal view: open sessions of the selected session's group, set active group
  const handleSelectSession = useCallback((sessionId) => {
    const selected = sessions.find(s => s.id === sessionId);
    const groupId = selected?.groupId || null;
    setActiveGroupId(groupId);
    const groupIds = groupSessionIds(groupId);
    groupIds.forEach(id => addOpenedSession(id));
    addOpenedSession(sessionId);
    touchLivePane([...groupIds, sessionId]); // keep this group's panes alive (LRU)
    clearNotification?.(sessionId);

    if (currentView.type === "terminal") replaceTopWithSession(sessionId);
    else pushView({ type: "terminal", sessionId });
  }, [
    sessions, groupSessionIds, addOpenedSession, touchLivePane, setActiveGroupId,
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

  // Tab/Shift+Tab in the PC input bar cycles sessions within the active group (wrap-round)
  const switchSession = useCallback((direction) => {
    const groupIds = groupSessionIds(activeGroupId);
    if (groupIds.length < 2) return;
    const idx = groupIds.indexOf(activeSessionId);
    if (idx === -1) return;
    const next = direction === "prev"
      ? (idx - 1 + groupIds.length) % groupIds.length
      : (idx + 1) % groupIds.length;
    handleSelectSession(groupIds[next]);
  }, [groupSessionIds, activeGroupId, activeSessionId, handleSelectSession]);

  // Ctrl+1..9 in the PC input bar jumps to the Nth session in the active group
  const switchToIndex = useCallback((i) => {
    const groupIds = groupSessionIds(activeGroupId);
    if (i < 0 || i >= groupIds.length) return;
    handleSelectSession(groupIds[i]);
  }, [groupSessionIds, activeGroupId, handleSelectSession]);

  // Named create (from the session list / sidebar). Keeps activeGroupId unchanged — the new
  // session isn't in `sessions` yet (loadSessions is async) so handleSelectSession would reset it.
  const handleCreateSession = useCallback((name, groupId = null, shellId = null) => {
    createSession(name, shellId, groupId, lastGroupCwd(groupId), (result) => {
      if (!result.success) return alertCreateFailed(result.error);
      if (!result.sessionId) return;
      addOpenedSession(result.sessionId);
      // Auto-select the new terminal when created from within terminal view
      if (currentView.type === "terminal") replaceTopWithSession(result.sessionId);
    });
  }, [createSession, lastGroupCwd, addOpenedSession, alertCreateFailed, currentView, replaceTopWithSession]);

  // Quick create in the active group (header "+" button)
  const handleQuickCreateSession = useCallback((shellId) => {
    createSession(null, shellId, activeGroupId, lastGroupCwd(activeGroupId), (result) => {
      if (!result.success) return alertCreateFailed(result.error);
      if (!result.sessionId) return;
      addOpenedSession(result.sessionId);
      replaceTopWithSession(result.sessionId);
    });
  }, [createSession, activeGroupId, lastGroupCwd, addOpenedSession, alertCreateFailed, replaceTopWithSession]);

  // Create from the FileExplorer bottom panel — stay in the current view
  const handleCreateSessionInline = useCallback((onCreated) => {
    createSession(null, (result) => {
      if (!result.success) return alertCreateFailed(result.error);
      if (!result.sessionId) return;
      addOpenedSession(result.sessionId);
      onCreated?.(result.sessionId);
    });
  }, [createSession, addOpenedSession, alertCreateFailed]);

  // Switch active group in terminal view — focus the first session of that group
  const handleSelectGroup = useCallback((groupId) => {
    setActiveGroupId(groupId);
    const groupSessions = sessions.filter(s => (s.groupId || null) === groupId);
    groupSessions.forEach(s => addOpenedSession(s.id));
    touchLivePane(groupSessions.map(s => s.id)); // keep this group's panes alive (LRU)
    const first = groupSessions[0];
    if (first) replaceTopWithSession(first.id);
  }, [sessions, setActiveGroupId, addOpenedSession, touchLivePane, replaceTopWithSession]);

  const handleDeleteSession = useCallback((sessionId) => {
    const deleted = sessions.find((s) => s.id === sessionId);
    const groupId = deleted?.groupId || null;
    const isDeletingActive = currentView?.type === "terminal" && currentView.sessionId === sessionId;
    deleteSession(sessionId, () => {
      removeOpenedSession(sessionId);
      if (!isDeletingActive) return;
      // Focus the next session (same group first, then any) or fall back to the list
      const remaining = sessions.filter((s) => s.id !== sessionId);
      const sameGroup = remaining.filter((s) => (s.groupId || null) === groupId);
      const next = sameGroup[0] || remaining[0];
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
    lastGroupCwd,
    handleSelectSession,
    handleSelectGroup,
    handleCreateSession,
    handleQuickCreateSession,
    handleCreateSessionInline,
    handleDeleteSession,
    handleRenameSession,
    switchSession,
    switchToIndex
  };
}
