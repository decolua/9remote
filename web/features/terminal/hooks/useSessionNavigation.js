"use client";

import { useCallback, useEffect, useMemo } from "react";
import { useI18n } from "@/shared/i18n";
import { sessionWorkspaceId } from "@/features/terminal/lib/paneLayout";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { useNotificationStore } from "@/shared/stores/notificationStore";
import { agentLaunchCommand, applySkipPermissions } from "@/features/terminal/constants/agentCli";

// Session/workspace navigation: select, create, delete, rename, and the workspace-aware
// tab cycling used by the PC input bar.
export function useSessionNavigation({
  sessions, currentView, viewStack, setViewStack, pushView, storePopView,
  activeWorkspaceId, setActiveWorkspaceId, activeSessionId,
  addOpenedSession, removeOpenedSession, touchLivePane,
  createSession, deleteSession, renameSession, busRef,
  isDesktop = false, requestFocus = null
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

  const alertCreateFailed = useCallback(
    (error) => alert(t("workspace.failedCreateSession", { error })),
    [t]
  );

  // Entering terminal view: open sessions of the selected session's workspace, set it active.
  // Selecting a pane does NOT mark its done badge read — only typing/sending into it does.
  const handleSelectSession = useCallback((sessionId) => {
    const selected = sessions.find(s => s.id === sessionId);
    // A caller can hold an id that has since closed (a history row, a stale
    // notification): pushing a view for it renders an empty terminal that no
    // longer has anything behind it.
    if (!selected) return;
    const workspaceId = sessionWorkspaceId(selected);
    setActiveWorkspaceId(workspaceId);
    const ids = workspaceSessionIds(workspaceId);
    ids.forEach(id => addOpenedSession(id));
    addOpenedSession(sessionId);
    touchLivePane([...ids, sessionId]); // keep this workspace's panes alive (LRU)

    if (currentView.type === "terminal") replaceTopWithSession(sessionId);
    else pushView({ type: "terminal", sessionId });
  }, [
    sessions, workspaceSessionIds, addOpenedSession, touchLivePane, setActiveWorkspaceId,
    currentView, pushView, replaceTopWithSession
  ]);

  // Deep-link from a push notification tap (SW postMessage) or OS Dock icon click
  useEffect(() => {
    const onMessage = (e) => {
      if (e.data?.type !== "NOTIFICATION_CLICK") return;
      const sid = new URLSearchParams(new URL(e.data.url || "", location.origin).search).get("t");
      if (sid) handleSelectSession(sid);
    };

    const onDockClick = () => {
      const activeNotifs = useNotificationStore.getState().notifications;
      const entries = Object.values(activeNotifs || {});
      if (!entries.length) return;

      const inCurrentWorkspace = (sId) => {
        const sess = sessions.find((s) => s.id === sId);
        return sess && sessionWorkspaceId(sess) === (activeWorkspaceId ?? null);
      };

      const sorted = entries.sort((a, b) => {
        // 1. Prioritize active/focused workspace first
        const aCur = inCurrentWorkspace(a.sessionId);
        const bCur = inCurrentWorkspace(b.sessionId);
        if (aCur && !bCur) return -1;
        if (!aCur && bCur) return 1;

        // 2. Blocked (waiting approval) > done
        if (a.type === "blocked" && b.type !== "blocked") return -1;
        if (b.type === "blocked" && a.type !== "blocked") return 1;

        // 3. Latest timestamp
        return (b.timestamp || 0) - (a.timestamp || 0);
      });

      const target = sorted[0];
      if (target?.sessionId) {
        handleSelectSession(target.sessionId);
      }
    };

    window.addEventListener("message", onMessage);
    window.addEventListener("9remote:dock-click", onDockClick);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("9remote:dock-click", onDockClick);
    };
  }, [handleSelectSession, sessions, activeWorkspaceId]);

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
  // `agent` = {id,label,cmd,...} from the modal — the CLI is typed into the session on
  // first join. `yolo` adds the agent's own skip-permission flag/env to that command.
  const handleCreateSession = useCallback((name, workspaceId = null, shellId = null, cwd = null, agent = null, yolo = false, nameIsAuto = false) => {
    createSession(name, shellId, workspaceId, cwd || null, (result) => {
      if (!result?.success) return alertCreateFailed(result?.error);
      if (!result.sessionId) return;
      const startupCmd = agentLaunchCommand(agent, yolo);
      if (startupCmd) useTerminalStore.getState().queueStartup(result.sessionId, startupCmd);
      if (agent?.id) useTerminalStore.getState().setSessionAgent(result.sessionId, agent.id);
      const targetWs = workspaceId ?? null;
      setActiveWorkspaceId(targetWs);
      const wsIds = workspaceSessionIds(targetWs);
      wsIds.forEach((id) => addOpenedSession(id));
      addOpenedSession(result.sessionId);
      touchLivePane([...wsIds, result.sessionId]);
      if (currentView.type === "terminal") {
        replaceTopWithSession(result.sessionId);
      } else {
        pushView({ type: "terminal", sessionId: result.sessionId });
      }
      requestFocus?.(result.sessionId);
    }, nameIsAuto, agent);
  }, [createSession, workspaceSessionIds, addOpenedSession, touchLivePane, alertCreateFailed, currentView, replaceTopWithSession, pushView, setActiveWorkspaceId, requestFocus]);

  // Re-enter one past agent-CLI conversation: a fresh terminal parked in the
  // directory that conversation ran in, with the CLI's own resume line queued.
  const handleResumeAgentSession = useCallback((row) => {
    if (!row?.resume) return;
    // A conversation the host remembers as a chat takes the chat's own resume —
    // the id it was rebindable to on the host, not a CLI flag typed into a shell.
    const asUi = row.mode === "ui";
    // Resuming keeps the CLI's skip-permission mode: dropping back to per-action
    // approval is not where the conversation left off.
    const agent = useTerminalStore.getState().agentClis?.find((a) => a.id === row.agent) || null;
    const resumeLine = asUi ? null : applySkipPermissions(agent, row.resume);
    // Created unnamed on purpose: the agent names an auto-named terminal after
    // the conversation it runs, so the tab keeps following that chat's title.
    createSession(null, null, activeWorkspaceId, row.cwd || null, (result) => {
      if (!result?.success) return alertCreateFailed(result?.error);
      if (!result.sessionId) return;
      if (resumeLine) useTerminalStore.getState().queueStartup(result.sessionId, resumeLine);
      const agentId = asUi ? `${row.agent}-ui` : row.agent;
      if (agentId) useTerminalStore.getState().setSessionAgent(result.sessionId, agentId);
      // Tell the agent which conversation this terminal is resuming, so the
      // history row points at it before the CLI reports anything of its own.
      busRef?.current?.emit("claimAgentSession", {
        sessionId: result.sessionId, agent: agentId, conversationId: row.sessionId
      }, () => useTerminalStore.getState().invalidateAgentHistory());
      addOpenedSession(result.sessionId);
      touchLivePane(result.sessionId);
      if (currentView.type === "terminal") {
        replaceTopWithSession(result.sessionId);
      } else {
        pushView({ type: "terminal", sessionId: result.sessionId });
      }
      requestFocus?.(result.sessionId);
    });
  }, [createSession, activeWorkspaceId, addOpenedSession, touchLivePane, alertCreateFailed, replaceTopWithSession, pushView, currentView, requestFocus, busRef]);

  // Quick create in the active workspace (header "+" button, Mod+Shift+Enter chord).
  // Always focuses the new pane, unlike handleCreateSession which only does so from
  // terminal view. `agent`/`yolo`/`name` let the chord replay the modal's last choice.
  const handleQuickCreateSession = useCallback((shellId, agent = null, yolo = false, name = null, nameIsAuto = false) => {
    createSession(name, shellId, activeWorkspaceId, null, (result) => {
      if (!result?.success) return alertCreateFailed(result?.error);
      if (!result.sessionId) return;
      const startupCmd = agentLaunchCommand(agent, yolo);
      if (startupCmd) useTerminalStore.getState().queueStartup(result.sessionId, startupCmd);
      if (agent?.id) useTerminalStore.getState().setSessionAgent(result.sessionId, agent.id);
      addOpenedSession(result.sessionId);
      touchLivePane(result.sessionId);
      if (currentView.type === "terminal") {
        replaceTopWithSession(result.sessionId);
      } else {
        pushView({ type: "terminal", sessionId: result.sessionId });
      }
      requestFocus?.(result.sessionId);
    }, nameIsAuto, agent);
  }, [createSession, activeWorkspaceId, addOpenedSession, touchLivePane, alertCreateFailed, replaceTopWithSession, pushView, currentView, requestFocus]);

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

  // Passed down as a single `nav` prop — a fresh object per render would re-render every
  // memoized consumer even though all ten handlers are stable.
  return useMemo(() => ({
    handleSelectSession,
    handleSelectWorkspace,
    handleCreateSession,
    handleQuickCreateSession,
    handleResumeAgentSession,
    handleCreateSessionInline,
    handleDeleteSession,
    handleRenameSession,
    switchSession,
    switchToIndex
  }), [handleSelectSession, handleSelectWorkspace, handleCreateSession, handleQuickCreateSession,
    handleResumeAgentSession, handleCreateSessionInline, handleDeleteSession, handleRenameSession,
    switchSession, switchToIndex]);
}
