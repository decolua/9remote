// Fleet view pure helpers: nest a host's flat session list under its workspaces
// (ungrouped bucket last, same order SessionList shows) and count the summary a
// collapsed host card displays. Dependency-free so the test runs under plain node.

export function hostTree(sessions = [], workspaces = []) {
  const known = new Set(workspaces.map((w) => w.id));
  const buckets = new Map();
  for (const s of sessions) {
    const id = known.has(s.workspaceId) ? s.workspaceId : null;
    if (!buckets.has(id)) buckets.set(id, []);
    buckets.get(id).push(s);
  }
  return [
    ...workspaces.filter((w) => buckets.has(w.id)).map((w) => ({ workspace: w, sessions: buckets.get(w.id) })),
    ...(buckets.has(null) ? [{ workspace: null, sessions: buckets.get(null) }] : [])
  ];
}

// States mirror statusManager's 4-state map (idle/working/blocked/done).
export function hostSummary(sessions = [], statusMap = {}) {
  let working = 0;
  let attention = 0;
  for (const s of sessions) {
    const state = statusMap[s.id]?.state;
    if (state === "working") working++;
    else if (state === "blocked" || state === "done") attention++;
  }
  return { sessions: sessions.length, working, attention };
}
