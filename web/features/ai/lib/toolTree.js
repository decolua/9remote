// A sub-agent may itself spawn one, so a tool card is the root of a tree, not a flat
// list. Every update has to reach a node at any depth; a top-level-only lookup
// dropped a grandchild's tool calls silently.

// A turn ended, so nothing this tool had to say is still coming. A row left spinning
// past its turn is wrong in every case; `done` is the least-wrong claim for the ones
// whose result never arrived (codex emits an item.started with no matching
// item.completed when a spawn fails and is retried).
export function settleRunningTools(tools) {
  return (tools || []).map((t) => {
    const children = t.children ? settleRunningTools(t.children) : null;
    if (t.status !== "running" && !children) return t;
    return { ...t, ...(t.status === "running" ? { status: "done" } : null), ...(children ? { children } : null) };
  });
}

// Returns a rebuilt array with the first node matching `match` replaced by
// `update(node)`, its ancestors copied along the way — or null when nothing matched,
// which is how a caller tells "no such card here" from "updated, look elsewhere".
export function updateToolTree(tools, match, update) {
  let changed = false;
  const next = (tools || []).map((t) => {
    if (match(t)) {
      changed = true;
      return update(t);
    }
    const children = updateToolTree(t.children, match, update);
    if (!children) return t;
    changed = true;
    return { ...t, children };
  });
  return changed ? next : null;
}
