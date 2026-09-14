// A sub-agent may itself spawn one, so a tool card is the root of a tree, not a flat
// list. Every update has to reach a node at any depth; a top-level-only lookup
// dropped a grandchild's tool calls silently.

// Tools whose row IS a sub-agent. Names are matched exactly: each engine spells them
// its own way, and opencode's is lowercase (`task`), so Claude's `Task` does not cover
// it. Everything else in the agent category (SendMessage, close_agent, wait) is a
// message TO one, not a launch.
export const LAUNCH_TOOLS = new Set([
  "Agent", "Task", "Workflow",   // claude
  "task",                        // opencode
  "browser_subagent", "invoke_subagent", // antigravity
  "spawn_agent",                 // codex
]);

/** A sub-agent's display name: its declared type, or the task it was given. */
export const agentLabel = (t) =>
  t?.input?.subagent_type || t?.input?.agent || t?.input?.description || "agent";

/**
 * Every sub-agent still running, off one message list, deepest-last.
 *
 * Walks the whole tree because a sub-agent can spawn one of its own. Scans messages
 * from the end and stops at the first that yields anything: the running one is the
 * work in flight, so an older turn's agent cannot be live.
 */
export function runningAgents(messages = []) {
  const out = [];
  const walk = (tools) => {
    for (const t of tools || []) {
      if (LAUNCH_TOOLS.has(t?.name) && t.status === "running") out.push({ id: t.id, label: agentLabel(t) });
      if (t?.children?.length) walk(t.children);
    }
  };
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!messages[i]?.tools?.length) continue;
    walk(messages[i].tools);
    if (out.length > 0) break;
  }
  return out;
}

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
