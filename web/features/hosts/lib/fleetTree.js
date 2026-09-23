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

// Workspace ids cross the host boundary as "head:rawId" (scopedFleetLists). These
// are the two directions a tree or nav needs.
export const scopedWsId = (head, rawId) => `${head}:${rawId}`;
export const rawWsIdOf = (scopedId, head) => (
  typeof scopedId === "string" && scopedId.startsWith(`${head}:`)
    ? scopedId.slice(head.length + 1)
    : null
);

// The RAW workspace id a tree should highlight for `scopedId`, or undefined when
// the active workspace belongs to some other host ("_" = the synthetic ungrouped).
export function activeWsForHost(scopedId, head) {
  const raw = rawWsIdOf(scopedId, head);
  if (raw === null) return undefined;
  return raw === "_" ? null : raw;
}

// "seen 2d"-style relative time, shared by the fleet view and the sidebar's
// other-host roots.
export function relTime(ts, t) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  const h = Math.floor(diff / 3600000);
  const d = Math.floor(diff / 86400000);
  if (m < 1) return t("login.justNow");
  if (m < 60) return t("login.minutesAgo", { n: m });
  if (h < 24) return t("login.hoursAgo", { n: h });
  if (d < 7) return t("login.daysAgo", { n: d });
  return new Date(ts).toLocaleDateString();
}

// The sibling roots a sidebar renders below the current host's tree: other saved
// keys, online ones first, label order within a tier. No current host yet (fleet
// not settled) renders nothing — every key would look like "another" host.
export function otherHostsOf(hosts, currentKey) {
  return hosts
    .filter((h) => currentKey && h.key !== currentKey)
    .sort((a, b) => (a.status === "offline") - (b.status === "offline")
      || (a.label || "").localeCompare(b.label || ""));
}

// Other hosts' sessions/workspaces re-keyed under "head:" so they flow through the
// existing workspace model untouched — scoped ids can never collide with the main
// host's, and foreign ungrouped sessions get a named group instead of mixing into
// the main host's ungrouped bucket.
export function scopedFleetLists(hosts, currentKey) {
  const out = { sessions: [], workspaces: [] };
  if (!currentKey) return out;
  for (const h of hosts) {
    if (h.key === currentKey) continue;
    const prefix = `${h.key}:`;
    const ungroupedId = `${prefix}_`;
    const hasUngrouped = (h.sessions || []).some((s) => s.workspaceId == null);
    for (const w of h.workspaces || []) {
      out.workspaces.push({ ...w, id: prefix + w.id, hostKey: h.key });
    }
    if (hasUngrouped) {
      out.workspaces.push({ id: ungroupedId, name: h.label || h.key, hostKey: h.key });
    }
    for (const s of h.sessions || []) {
      out.sessions.push({
        ...s,
        workspaceId: s.workspaceId != null ? prefix + s.workspaceId : ungroupedId,
        hostKey: h.key
      });
    }
  }
  return out;
}
