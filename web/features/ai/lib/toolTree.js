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

/** A shell card's display name: the command it runs, not the word "Bash". */
const shellLabel = (t) => t?.input?.description || t?.input?.command || "shell";

/**
 * Everything launched asynchronously that is still going — the pinned strip's read model.
 *
 * The harness's task set is the authority when it is there (`harnessTasks`, from
 * task_started / background_tasks_changed): the CLI states a task's status, so the strip
 * stops guessing. The tool-row scan below is the FALLBACK for engines that keep no task
 * model of their own — codex and antigravity hand work off without ever saying its name
 * again, and for those the row is all there is.
 */
export function runningAsync(messages = [], harnessTasks = []) {
  if (harnessTasks.length > 0) {
    return harnessTasks
      .filter((t) => t?.status === "running")
      .map((t) => ({
        kind: t.background ? "shell" : "agent",
        // Two ids, deliberately: `id` is what the pane's own rows are keyed by (the tool
        // call), while `taskId` is the name the CLI minted and the only one a stop can
        // address. They coincide on a row the scan produced, and only there is a stop
        // meaningless anyway — nothing on the other side answers to a tool call id.
        id: t.toolUseId || t.taskId,
        taskId: t.taskId,
        label: t.description || t.subagentType || "task"
      }));
  }
  return scanRunningRows(messages);
}

/** The tool-row fallback: work handed off and never reported on again. */
function scanRunningRows(messages = []) {
  const out = [];
  const walk = (tools) => {
    for (const t of tools || []) {
      if (t?.status === "running") {
        if (LAUNCH_TOOLS.has(t?.name)) out.push({ kind: "agent", id: t.id, label: agentLabel(t) });
        else if (t?.async) out.push({ kind: "shell", id: t.id, label: shellLabel(t) });
      }
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

/** Every sub-agent still running. */
export function runningAgents(messages = [], harnessTasks = []) {
  return runningAsync(messages, harnessTasks)
    .filter((r) => r.kind === "agent")
    .map(({ id, label }) => ({ id, label }));
}

// A turn ended, so nothing this tool had to say is still coming. A row left spinning
// past its turn is wrong in every case; `done` is the least-wrong claim for the ones
// whose result never arrived (codex emits an item.started with no matching
// item.completed when a spawn fails and is retried).
//
// `async` rows are the exception: a sub-agent or background shell was handed off ON
// PURPOSE and goes on working after the turn that launched it ends. The host owns their
// clock instead (AiSession.armAsyncWatchdog) and settles them there.
export function settleRunningTools(tools) {
  return (tools || []).map((t) => {
    const children = t.children ? settleRunningTools(t.children) : null;
    if (t.status !== "running" || t.async) return children ? { ...t, children } : t;
    return { ...t, status: "done", ...(children ? { children } : null) };
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
