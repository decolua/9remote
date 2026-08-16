// Which panes render, which of those mount, and their join order. Active-workspace panes drive
// tabs/visibility; the LRU union stays mounted so a workspace switch never remounts.

// Sequential join within a freshly-active workspace: focus first (0ms), then stagger the rest
// so concurrent joins don't pile up and stall the main thread.
export const STAGGER_MS = 120;

export const UNGROUPED_KEY = "__ungrouped__";

// Session -> workspace id. Falls back to the legacy groupId while agents on older
// versions still only send that field.
export const sessionWorkspaceId = (session) => session?.workspaceId ?? session?.groupId ?? null;

export function derivePaneLayout({
  sessions, openedSessions, livePanes, mountedWorkspaces, activeWorkspaceId, isDesktop
}) {
  const workspaceSessionIds = new Set(
    sessions.filter(s => sessionWorkspaceId(s) === (activeWorkspaceId ?? null)).map(s => s.id)
  );
  const workspaceOpenedSessions = openedSessions.filter(sid => workspaceSessionIds.has(sid));
  const liveSet = new Set([
    ...workspaceOpenedSessions,
    ...livePanes.filter(sid => openedSessions.includes(sid))
  ]);
  const renderedSessions = openedSessions.filter(sid => liveSet.has(sid));

  // A pane mounts only if its workspace has been visited once (the active workspace auto-marks
  // mounted). Desktop keeps panes from other VISITED workspaces mounted (split/LRU); mobile mounts
  // ONLY the active workspace — one visible pane at a time, keeping others alive wastes memory + joins.
  const sessionWorkspace = new Map(sessions.map(s => [s.id, sessionWorkspaceId(s)]));
  const mountedSet = new Set(openedSessions.filter(sid => {
    if (workspaceSessionIds.has(sid)) return true;
    if (!isDesktop) return false;
    return !!mountedWorkspaces[sessionWorkspace.get(sid) ?? UNGROUPED_KEY];
  }));

  const workspaceIndex = new Map(workspaceOpenedSessions.map((sid, i) => [sid, i]));
  return { workspaceSessionIds, workspaceOpenedSessions, renderedSessions, mountedSet, workspaceIndex };
}

// Panes already alive (revisit) join with no delay — their PTY is already running.
export const mountDelayFor = (sessionId, isFocused, workspaceIndex) =>
  !isFocused && workspaceIndex.has(sessionId) ? workspaceIndex.get(sessionId) * STAGGER_MS : 0;
