// The TASKS checklist's write model — ONE copy, because two doors write it.
//
// The live path (useAiSession's socket handlers → aiStore.upsertTask) and the replay path
// (reduceSessionEvents → hydrateSession) fold the same TaskCreate/TaskUpdate events, and
// the strip cannot tell which door filled it. Two copies of these rules is how the list
// after an F5 drifts from the one that was on screen live.

/**
 * Fold one parsed task event into the list. Returns a new array, or the SAME one when
 * nothing moved — the strip re-derives on every streamed token.
 *
 * A row is matched by the CLI's own number, then by the tool call id. A `TaskCreate`
 * carries no number until its result lands ("Task #N created successfully"), so the result
 * finds its row by call id; an update only ever has the number.
 */
export function upsertTask(tasks = [], patch) {
  if (!patch) return tasks || [];
  // TodoWrite carries the whole list — it replaces, never appends.
  if (patch.replaceAll) return patch.todos || [];
  const list = tasks || [];
  const num = patch.taskId ? String(patch.taskId) : "";
  const callId = patch.id ? String(patch.id) : "";
  const at = list.findIndex(
    (t) => (num && String(t.taskId) === num) || (callId && t.id && String(t.id) === callId)
  );
  // `deleted` is permanent: the CLI removed the task, so the row leaves the list. Kept as
  // a status it stays counted — the strip reads "1/2" on a chat with one task left, and
  // the modal counts it as pending.
  if (patch.status === "deleted") {
    return at === -1 ? list : [...list.slice(0, at), ...list.slice(at + 1)];
  }
  if (at === -1) {
    // An update to a task nobody listed is dropped; only a create opens a row.
    return patch.subject ? [...list, patch] : list;
  }
  const next = list.slice();
  next[at] = { ...next[at], ...patch };
  return next;
}
