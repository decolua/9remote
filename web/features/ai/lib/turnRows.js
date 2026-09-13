// A turn's read model: one flat, arrival-ordered row list, then a split into the
// blocks the pane actually paints.
//
// Order is the contract. A coding agent reads, edits, runs, reads again — an earlier
// revision grouped consecutive same-kind steps and destroyed exactly that signal.
// Nothing here sorts, merges or reorders rows; it only decides what is a row and
// where the reader stops reading.
//
// A turn is one user message plus every assistant segment after it. The reducer emits
// that shape (useAiSession's reduceSessionEvents, aiStore's appendTool): text, thinking,
// tools and diffs each land in the segment they arrived in.

import { getToolCategory } from "../registry";

// Tools whose whole effect is the pinned checklist strip (AiTaskCard) — inline they
// would only repeat it.
const TASK_STRIP_TOOLS = new Set(["TaskCreate", "TaskUpdate", "TodoWrite", "todowrite"]);

/** Tool calls worth a row: no duplicate of a diff card, no pinned-strip tool. */
export function visibleTools(engine, tools, diffs) {
  return (tools || []).filter((t) => {
    if (!t || !t.name) return false;
    const path = t.input?.file_path || t.input?.path || "";
    if ((t.name === "Edit" || t.name === "Write") && path && (diffs || []).some((d) => d.file === path)) {
      return false;
    }
    if (getToolCategory(engine, t.name) === "task" && TASK_STRIP_TOOLS.has(t.name)) return false;
    return true;
  });
}

/**
 * Ordered rows for one turn.
 *
 * A segment renders in the order the pane has always painted it: thinking, then tools,
 * then diffs, then the segment's text. A segment holds either thinking or tools (the
 * store closes a segment when a tool arrives on top of streamed text), so these
 * interleave across segments the way the CLI printed them.
 */
export function buildTurnRows(messages = [], engine = "claude") {
  const rows = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    if (m.thinking?.trim()) rows.push({ kind: "thought", id: `${m.id}-th`, text: m.thinking });

    const tools = visibleTools(engine, m.tools, m.diffs);
    for (let i = 0; i < tools.length; i++) {
      const t = tools[i];
      // A question still running is owned by the pinned card above the composer;
      // an answered one is a row, since the host's output is the only record of it.
      if (getToolCategory(engine, t.name) === "question" && t.status === "running") continue;
      rows.push({ kind: "tool", id: t.id || `${m.id}-t${i}`, tool: t, engine });
    }

    for (let i = 0; i < (m.diffs?.length || 0); i++) {
      const d = m.diffs[i];
      rows.push({ kind: "diff", id: `${m.id}-d${i}`, diff: d });
    }

    if (m.content) rows.push({ kind: "prose", id: `${m.id}-p`, content: m.content, isLive: m.isLive });
    if (m.permission) rows.push({ kind: "permission", id: `${m.id}-perm`, permission: m.permission });
  }
  return rows;
}

const isStep = (r) => r.kind === "thought" || r.kind === "tool";

/**
 * Split rows into what the pane paints.
 *
 * Prose is NEVER hidden — it is the thing being read. Only a run of consecutive steps
 * (tool calls and thoughts with no prose between them) is windowed, and the run is the
 * unit: prose in the middle of a turn ends one run and starts the next, so the order
 * the agent worked in survives intact.
 *
 * Each step block reports how many of its rows are still hidden, which is what the
 * "N more" bar above it shows.
 *
 * `deferred` marks a turn read back from history rather than one being watched live.
 * Its cards open collapsed even when they carry an error, so paging in old turns does
 * not mount every failed command's output at once.
 */
// A run one step longer than the window still shows whole — a bar costs more to open
// than it saves, so it takes windowSize + 1 steps before anything goes behind it.
/** Steps of a run that stay off-screen, given how many the reader has paged in. */
export function hiddenCount(total, windowSize, revealed = 0) {
  const rest = total - Math.max(0, revealed);
  return rest > windowSize + 1 ? rest - windowSize : 0;
}

/** How many steps one press of "more" adds — never past what is still hidden. */
export function revealStep(hidden, chunk) {
  return Math.min(chunk, Math.max(0, hidden));
}

/** How many steps one press of "less" takes back — never past what was paged in. */
export function collapseStep(revealed, chunk) {
  return Math.min(chunk, Math.max(0, revealed));
}

export function splitTurnBlocks(rows = [], windowSize = 6, { deferred = false } = {}) {
  const blocks = [];
  for (const row of rows) {
    if (isStep(row)) {
      const last = blocks[blocks.length - 1];
      if (last?.type === "steps") last.rows.push(row);
      else blocks.push({ type: "steps", rows: [row] });
    } else {
      blocks.push({ type: "row", row });
    }
  }
  return blocks.map((b, i) => {
    if (b.type !== "steps") return { ...b, key: `r${i}`, deferred };
    // A short run is not worth a bar — it costs more to open than it saves.
    const hidden = b.rows.length > windowSize + 1 ? b.rows.length - windowSize : 0;
    return { type: "steps", key: `s${i}`, rows: b.rows, hidden, deferred };
  });
}
