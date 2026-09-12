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

// Width an auto-fit pane takes this render. Auto-fit is narrowing-only: a side panel
// opening narrows the panes so nothing is clipped, but a panel closing leaves the freed
// space empty until the user asks for it. Widening re-fits the PTY and cols is one-way —
// it would re-wrap scrollback nobody asked to re-wrap. A deliberate action (double-click,
// sidebar drag, pane add/remove, viewport resize) clears `applied` and full-fits; there is
// no other way back up, so a row clamped at the floor stays clamped until one of those.
export function autoFitPaneWidth({ rowWidth, paneCount, sidebarWidth, sidePx, gapPx, paddingPx, minWidth, applied }) {
  if (!(rowWidth > 0) || paneCount <= 0) return null;
  const base = rowWidth - sidebarWidth - paddingPx - sidePx;
  const full = Math.max(minWidth, Math.floor((base - (paneCount - 1) * gapPx) / paneCount));
  return applied == null ? full : Math.min(applied, full);
}
