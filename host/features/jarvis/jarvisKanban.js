// The Jarvis coordinator's kanban board — a pure action reducer. The agent process
// holds the board (single source of truth); the MCP tool, the socket handler, and
// the web UI mirror all funnel through applyKanbanAction so the rules live once.
//
// A task's home column is one of KANBAN_STATUSES; everything else (sessionId,
// branch, notes, summary) is descriptive and never gates a transition.

export const KANBAN_STATUSES = ["todo", "in_progress", "needs_input", "done"];
const STATUS_SET = new Set(KANBAN_STATUSES);

let seq = 0;
const newId = () => `t-${Date.now().toString(36)}-${++seq}`;

export function emptyBoard() {
  return { tasks: {} };
}

/**
 * Apply one action to a board. Never mutates the input; returns
 * { board, error? } — error set means the board in the result is the input.
 *   { type: "create", title, sessionId?, branch?, notes? }
 *   { type: "update", taskId, patch }
 *   { type: "move",   taskId, status }
 *   { type: "delete", taskId }
 *   { type: "report", sessionId, summary, status? } — a worker's own line back:
 *        upserts its auto card; summary is worker-owned, sync never touches it.
 */
export function applyKanbanAction(board, action) {
  const base = board && typeof board === "object" && board.tasks ? board : emptyBoard();
  const fail = (error) => ({ board: base, error });

  const type = action?.type;
  if (type === "create") {
    const title = String(action.title || "").trim();
    if (!title) return fail("title is required");
    const now = Date.now();
    const task = {
      id: newId(),
      title,
      status: "todo",
      sessionId: action.sessionId || null,
      branch: action.branch || null,
      workspace: action.workspace || null,
      notes: action.notes || "",
      summary: "",
      createdAt: now,
      updatedAt: now
    };
    return { board: { tasks: { ...base.tasks, [task.id]: task } } };
  }

  if (type === "report") {
    const sessionId = action.sessionId || "";
    const summary = String(action.summary || "").trim();
    if (!sessionId) return fail("sessionId is required");
    if (!summary) return fail("summary is required");
    if (action.status !== undefined && !STATUS_SET.has(action.status)) return fail(`unknown status: ${action.status}`);
    const now = Date.now();
    const id = fleetCardId(sessionId);
    const existing = base.tasks[id];
    if (existing) {
      return { board: patchTask(base, id, {
        summary,
        ...(action.status !== undefined ? { status: action.status, reportedStatus: action.status } : {})
      }) };
    }
    const card = {
      id, auto: true, title: `Worker ${sessionId}`,
      status: action.status || "todo", reportedStatus: action.status || null,
      sessionId, engine: null, branch: null, workspace: null,
      notes: "", summary, question: "",
      createdAt: now, updatedAt: now
    };
    return { board: { tasks: { ...base.tasks, [id]: card } } };
  }

  const id = action?.taskId;
  const existing = id ? base.tasks[id] : null;
  if (!existing) return fail(`unknown task: ${id}`);

  if (type === "move") {
    if (!STATUS_SET.has(action.status)) return fail(`unknown status: ${action.status}`);
    return { board: patchTask(base, id, { status: action.status }) };
  }
  if (type === "update") {
    const patch = action.patch && typeof action.patch === "object" ? action.patch : {};
    // id/createdAt are identity; status moves through "move" only.
    const { id: _i, createdAt: _c, status: _s, ...rest } = patch;
    return { board: patchTask(base, id, rest) };
  }
  if (type === "delete") {
    const tasks = { ...base.tasks };
    delete tasks[id];
    return { board: { tasks } };
  }
  return fail(`unknown action type: ${type}`);
}

function patchTask(board, id, fields) {
  return {
    tasks: {
      ...board.tasks,
      [id]: { ...board.tasks[id], ...fields, updatedAt: Date.now() }
    }
  };
}

// ── Fleet ⇄ board sync ──
// Every live session (the conductor excluded — the fleet snapshot already drops
// it) owns one AUTO card that mirrors the session's real state, so an empty board
// with two terminals running is a lie the user never sees. Manual tasks are the
// conductor's and the user's alone — sync never creates, moves, or sweeps them.

const FLEET_STATUS_TO_COLUMN = { idle: "todo", running: "in_progress", needs_input: "needs_input" };
const fleetCardId = (sessionId) => `fleet-${sessionId}`;

/**
 * Fold a fleet snapshot into the board's auto cards.
 * Returns { board, changed } — board is the SAME reference when nothing moved.
 */
export function syncFleetCards(board, fleet = []) {
  const base = board && typeof board === "object" && board.tasks ? board : emptyBoard();
  const tasks = { ...base.tasks };
  let changed = false;
  const live = new Set();

  for (const row of fleet) {
    if (!row?.sessionId) continue;
    live.add(row.sessionId);
    const id = fleetCardId(row.sessionId);
    const existing = tasks[id];
    // Precedence: a live turn/gate signal outranks the worker's self-report; with
    // no signal (idle — every plain terminal), the last self-report stands.
    const status = row.status !== "idle"
      ? (FLEET_STATUS_TO_COLUMN[row.status] || "todo")
      : (existing?.reportedStatus || "todo");
    const title = row.title || row.sessionId;
    // The ask rides the card only while the gate holds; answered, it clears.
    // summary is the worker's own report and is never touched here.
    const ask = row.status === "needs_input" ? (row.question || "") : "";
    if (!existing) {
      const now = Date.now();
      tasks[id] = {
        id, auto: true, title, status,
        sessionId: row.sessionId,
        engine: row.engine || null,
        branch: row.branch || null,
        workspace: row.workspacePath || null,
        notes: "", summary: "", question: ask,
        createdAt: now, updatedAt: now
      };
      changed = true;
      continue;
    }
    const patch = {};
    if (existing.status !== status) patch.status = status;
    if (existing.title !== title) patch.title = title;
    if (existing.engine !== (row.engine || null)) patch.engine = row.engine || null;
    if (existing.branch !== (row.branch || null)) patch.branch = row.branch || null;
    if (existing.workspace !== (row.workspacePath || null)) patch.workspace = row.workspacePath || null;
    if (existing.question !== ask) patch.question = ask;
    if (Object.keys(patch).length) {
      tasks[id] = { ...existing, ...patch, updatedAt: Date.now() };
      changed = true;
    }
  }

  // Sessions that closed leave; their cards leave with them.
  for (const id of Object.keys(tasks)) {
    if (tasks[id]?.auto && !live.has(tasks[id].sessionId)) {
      delete tasks[id];
      changed = true;
    }
  }

  return { board: changed ? { tasks } : base, changed };
}
