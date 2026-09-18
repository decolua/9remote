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

import { getToolCategory } from "../registry.js";

// Tools whose whole effect is the pinned checklist strip (AiTaskCard) — inline they
// would only repeat it.
const TASK_STRIP_TOOLS = new Set(["TaskCreate", "TaskUpdate", "TodoWrite", "todowrite"]);

// Must match the diff-emitting tool names in the agent adapters: every tool the host
// turns into a diff row has to be hidden here, or the file shows twice. All four claude
// tools name their target, and NotebookEdit uses `notebook_path` rather than `file_path`;
// codex's own name comes from the CLI's item type; opencode's edit/write and
// antigravity's write_to_file/replace_file_content build their diffs in the adapters.
const DIFF_TOOL_NAMES = new Set([
  "Edit", "Write", "MultiEdit", "NotebookEdit", "file_change",
  "edit", "write", "write_to_file", "replace_file_content"
]);
// opencode names it `filePath` (1.18 schema), antigravity's adapter normalizes to
// `file_path` — read every spelling the wire actually carries.
const editTarget = (input = {}) => input.file_path || input.notebook_path || input.path || input.filePath || input.file || "";

/** The tool row a diff replaces, by file — shared with `buildTurnRows`'s dedupe. */
export const editsFile = (t, path) =>
  DIFF_TOOL_NAMES.has(t?.name) && path &&
  // Codex edits several files under one call and lists them all; the other engines name
  // exactly one, so they fall back to the single target.
  ((t.input?.paths || []).includes(path) || editTarget(t.input) === path);

/** Tool calls worth a row: no duplicate of a diff card, no pinned-strip tool. */
export function visibleTools(engine, tools, diffs) {
  return (tools || []).filter((t) => {
    if (!t || !t.name) return false;
    // A diff for this file replaces those calls: same file as a tool row would show
    // twice, as its own row and again as a diff.
    if ((diffs || []).some((d) => d.file && editsFile(t, d.file))) return false;
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
  // The same call id in two segments is one event applied twice (a live copy the hydrate
  // replayed), not two calls — a CLI tool_use id is unique per call, so the first row is
  // the record and the repeat is dropped here, at the one door every path reads through.
  const seenToolIds = new Set();
  for (const m of messages) {
    // A line the harness asked for (see harnessTasks.noticeFrom). Not a step and not
    // prose: the CLI is telling the reader something, so it keeps its own place in the
    // order and never goes behind the "N more" bar.
    if (m.role === "notice") {
      rows.push({
        kind: "notice", id: m.id,
        notice: {
          subtype: m.subtype, level: m.level, content: m.content,
          // The compaction's own numbers, and whether it is still running: the pane draws
          // a spinner for the second, a sized line for the first. See noticeFrom.
          ...(m.compact ? { compact: m.compact } : null),
          ...(m.compacting ? { compacting: true } : null)
        }
      });
      continue;
    }
    if (m.role !== "assistant") continue;
    if (m.thinking?.trim()) rows.push({ kind: "thought", id: `${m.id}-th`, text: m.thinking });

    const tools = visibleTools(engine, m.tools, m.diffs);
    for (let i = 0; i < tools.length; i++) {
      const t = tools[i];
      // A question still running is owned by the pinned card above the composer;
      // an answered one is a row, since the host's output is the only record of it.
      if (getToolCategory(engine, t.name) === "question" && t.status === "running") continue;
      const id = t.id || `${m.id}-t${i}`;
      if (seenToolIds.has(id)) continue;
      seenToolIds.add(id);
      rows.push({ kind: "tool", id, tool: t, engine });
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

// A diff belongs in the same run as the tool calls around it: it is one more step the
// agent took, and it pages with them under the same "N more" bar.
const isStep = (r) => r.kind === "thought" || r.kind === "tool" || r.kind === "diff";

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
