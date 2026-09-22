// Turn read model: arrival-ordered row list split into renderable blocks.

import { getToolCategory } from "../registry.js";

// Tools rendered in pinned checklist strip rather than inline.
const TASK_STRIP_TOOLS = new Set(["TaskCreate", "TaskUpdate", "TodoWrite", "todowrite"]);

// Engines whose question gate renders pinned above the composer (a permission channel the
// CLI answers through). Elsewhere a running question stays in the timeline as a plain row —
// headless engines cannot be answered, but the ask must stay visible while it blocks.
const GATE_ENGINES = new Set(["claude", "omp", "devin"]);

// Diff-emitting tools across agent adapters (hidden inline to prevent duplicate file cards).
const DIFF_TOOL_NAMES = new Set([
  "Edit", "Write", "MultiEdit", "NotebookEdit", "file_change",
  "edit", "write", "write_to_file", "replace_file_content"
]);
// Normalize target file path across tool schemas.
const editTarget = (input = {}) => input.file_path || input.notebook_path || input.path || input.filePath || input.file || "";

export const editsFile = (t, path) =>
  DIFF_TOOL_NAMES.has(t?.name) && path &&
  ((t.input?.paths || []).includes(path) || editTarget(t.input) === path);

export function visibleTools(engine, tools, diffs) {
  return (tools || []).filter((t) => {
    if (!t || !t.name) return false;
    if ((diffs || []).some((d) => d.file && editsFile(t, d.file))) return false;
    if (getToolCategory(engine, t.name) === "task" && TASK_STRIP_TOOLS.has(t.name)) return false;
    return true;
  });
}

export function buildTurnRows(messages = [], engine = "claude") {
  const rows = [];
  // Deduplicate repeated tool call ids across segments.
  const seenToolIds = new Set();
  for (const m of messages) {
    if (m.role === "notice") {
      rows.push({
        kind: "notice", id: m.id,
        notice: {
          subtype: m.subtype, level: m.level, content: m.content,
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
      if (getToolCategory(engine, t.name) === "question" && t.status === "running" && GATE_ENGINES.has(engine)) continue;
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

const isStep = (r) => r.kind === "thought" || r.kind === "tool" || r.kind === "diff";

export function hiddenCount(total, windowSize, revealed = 0) {
  const rest = total - Math.max(0, revealed);
  return rest > windowSize + 1 ? rest - windowSize : 0;
}

export function revealStep(hidden, chunk) {
  return Math.min(chunk, Math.max(0, hidden));
}

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
    const hidden = b.rows.length > windowSize + 1 ? b.rows.length - windowSize : 0;
    return { type: "steps", key: `s${i}`, rows: b.rows, hidden, deferred };
  });
}
