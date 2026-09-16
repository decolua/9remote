// The harness's task model, read the way the TUI reads it.
//
// There is no translation layer on purpose. The host forwards the CLI's records whole —
// `system`/`task_started`, `task_updated`, `task_notification`, `background_tasks_changed`
// — under their own field names (`task_id`, `is_backgrounded`, `output_file`), so this
// file is the ONLY place that has to know how a task is spelled. When the CLI adds a
// field, nothing here changes; when it adds a record, one line in `apply` does.
//
// The rules are the CLI's own:
//   task_started             a task exists, running
//   task_updated             a patch merges into it
//   task_notification        it ended, with the status the CLI gave
//   background_tasks_changed the live set — absence means the task ended

// Wrapper tags the harness writes around text IT generated, not text a person wrote. The
// CLI says so itself of the task notification ("never quote or paste any part of it"): it
// is the harness reporting a task to itself. Drawing one puts the whole XML block on screen.
//
// Same list the transcript readers keep (agent/features/terminal/agentHistory.js), plus the
// task-notification frame they were missing. Duplicated rather than imported because the web
// bundle cannot reach into agent/ — and a one-line regex is cheaper than a build edge.
// `local-command-*` is deliberately NOT here: that is a slash command's own record, and the
// TUI shows it (`/resume` and its arguments are something the user typed). Only the frames
// the harness writes to talk to ITSELF are hidden.
const HARNESS_FRAME_RE = /^\s*<(task-notification|environment_context|turn_aborted|persisted-output)>/;

/** Would this text put a harness frame on screen? */
const isHarnessFrame = (text) => HARNESS_FRAME_RE.test(String(text || ""));

/**
 * A `<persisted-output>` frame becomes the path it saved to, the way the TUI does it.
 *
 * The frame is a 15KB notice that the real output went to a file; the file is the useful
 * part, and the preview inside the frame is a duplicate of what is already in it.
 */
function collapsePersistedOutput(text) {
  const body = String(text || "").trim();
  if (!body) return "";
  if (!body.startsWith("<persisted-output>")) return body;
  const m = /saved to: (\S+)/.exec(body);
  return m ? `saved to: ${m[1]}` : "";
}

/** A status the CLI will not move a task out of — the task is over. */
const TERMINAL = new Set(["completed", "failed", "killed", "stopped"]);

/** Fold one harness record into the task list. Returns the SAME array when nothing moved. */
export function applyTaskRecord(tasks, type, subtype, record) {
  if (type !== "system") return tasks;
  switch (subtype) {
    case "task_started": {
      if (!record?.task_id) return tasks;
      // Same rule as the live set below: a field the record does not carry is left as it
      // was. The CLI re-announces a task without every field, and writing the blanks over
      // a name it gave earlier is how a sub-agent lost its label.
      return upsert(tasks, record.task_id, {
        taskId: record.task_id,
        status: "running",
        // `is_backgrounded` is the CLI's own word for what this is; a sub-agent leaves it
        // unset and carries `subagent_type` instead.
        background: Boolean(record.is_backgrounded),
        ...(record.tool_use_id ? { toolUseId: record.tool_use_id } : null),
        ...(record.description ? { description: record.description } : null),
        ...(record.subagent_type ? { subagentType: record.subagent_type } : null),
        ...(record.task_type ? { taskType: record.task_type } : null)
      });
    }
    case "task_updated": {
      const at = tasks.findIndex((t) => t.taskId === record?.task_id);
      if (at === -1) return tasks;
      const patch = record.patch || {};
      const next = tasks.slice();
      // A task that moved back OUT of a terminal status is running again, and the end it
      // reported before is no longer true. Leaving the stamp there is how a resumed task
      // printed "ended at …" while it was working.
      const resumed = patch.status && !TERMINAL.has(patch.status);
      const merged = {
        ...next[at],
        ...(patch.status ? { status: patch.status } : null),
        ...(patch.description ? { description: patch.description } : null),
        ...(patch.end_time ? { endedAt: patch.end_time } : null)
      };
      // Deleted, not set to undefined: the key has to be GONE, or a `t.endedAt != null`
      // read on the other side still finds it.
      if (resumed) delete merged.endedAt;
      next[at] = merged;
      return next;
    }
    case "task_notification": {
      const at = tasks.findIndex((t) => t.taskId === record?.task_id);
      if (at === -1) return tasks;
      const next = tasks.slice();
      next[at] = {
        ...next[at],
        status: record.status || "completed",
        ...(record.output_file ? { outputFile: record.output_file } : null),
        ...(record.summary ? { summary: record.summary } : null),
        // The CLI's own token and duration totals for the task, kept under its names.
        ...(record.usage ? { usage: record.usage } : null)
      };
      return next;
    }
    case "background_tasks_changed": {
      const live = new Set((record?.tasks || []).map((t) => t.task_id));
      let next = tasks;
      // Absence means the task is gone. The test is a TERMINAL status, not `running`: a
      // paused task is still alive and still listed, so one that vanished while paused
      // ended too — leaving it paused forever is the stuck row this whole model replaces.
      //
      // Background only. A sub-agent is never in this list, so reading it as "everything
      // else ended" would settle every sub-agent the moment a shell task changed.
      if (next.some((t) => t.background && !TERMINAL.has(t.status) && !live.has(t.taskId))) {
        next = next.map((t) =>
          t.background && !TERMINAL.has(t.status) && !live.has(t.taskId) ? { ...t, status: "stopped" } : t
        );
      }
      for (const t of record?.tasks || []) {
        // Only the fields the record actually carries. The CLI's live set publishes
        // task_id and task_type without a description, and an unconditional write
        // blanked the label the strip shows — a running shell lost its name the moment
        // the set was republished.
        next = upsert(next, t.task_id, {
          background: true,
          status: "running",
          ...(t.description ? { description: t.description } : null),
          ...(t.task_type ? { taskType: t.task_type } : null)
        });
      }
      return next;
    }
    default:
      return tasks;
  }
}

function upsert(tasks, taskId, patch) {
  const at = tasks.findIndex((t) => t.taskId === taskId);
  if (at === -1) return [...tasks, { taskId, toolUseId: "", ...patch }];
  // Copy-on-write: an unchanged re-announcement must not re-render the strip.
  const merged = { ...tasks[at], ...patch };
  if (shallowEqual(merged, tasks[at])) return tasks;
  const next = tasks.slice();
  next[at] = merged;
  return next;
}

const shallowEqual = (a, b) => {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[k] === b[k]);
};

/** The tasks still running, newest last — the strip's read model. */
export const runningTasks = (tasks = []) => tasks.filter((t) => t.status === "running");

/**
 * The line a harness record asks the timeline to draw, or null when it asks for none.
 *
 * The harness decides this, not us: a record it bothers to give `content` (or a formatted
 * `error`) is one it means a person to read — `local_command`, `compact_boundary`,
 * `informational`, `away_summary`, and the errors. Records it writes for bookkeeping
 * (`turn_duration`, `stop_hook_summary`) carry neither, and get no row.
 *
 * `level` is the harness's own (`info` | `warning` | `error` | `suggestion`), passed
 * through so the row is styled the way the CLI would have styled it.
 */
export function noticeFrom(type, record) {
  if (!record) return null;
  // An `attachment` is what the harness put INTO the conversation, and two of its kinds
  // carry text a person reads: a hook's output and a prompt waiting for its turn. The rest
  // (`environment`, `task_reminder`, `prompt_snapshot`, the listings) hold state, not prose.
  if (type === "attachment") {
    const a = record.attachment || record;
    const kind = a.type || "";
    // A file the harness watched change. Its `snippet` is the WHOLE file re-read (8KB on a
    // real one), not the change — so it is named, never drawn as a patch. What this covers
    // is the edit route the diff card cannot see: a file changed through a shell command
    // rather than Edit/Write.
    if (kind === "edited_text_file") {
      const file = typeof a.filename === "string" ? a.filename.trim() : "";
      return file ? { subtype: kind, level: "info", content: file, file } : null;
    }
    // A hook's output reaches the screen in exactly ONE place, and the TUI's own code says
    // which: `if (!("hookEvent" in n) || n.hookEvent !== "SessionStart") return []`. Every
    // other hook — UserPromptSubmit, PostToolUse, a formatter, codegraph — feeds the MODEL,
    // not the reader. Drawing them put a 15KB `<persisted-output>` block in the chat.
    if (kind === "hook_success") {
      if (a.hookEvent !== "SessionStart") return null;
      const shown = collapsePersistedOutput(a.content);
      return shown ? { subtype: kind, level: "info", content: shown } : null;
    }
    const body = kind === "queued_command" ? a.prompt : "";
    if (typeof body !== "string" || !body.trim()) return null;
    // A queued prompt can carry a harness frame — a task notification, or a
    // `<persisted-output>` dumped in place of the real text. Neither is something a person
    // wrote or reads.
    if (isHarnessFrame(body)) return null;
    const collapsed = collapsePersistedOutput(body);
    return collapsed ? { subtype: kind, level: "info", content: collapsed } : null;
  }
  if (type !== "system") return null;
  // The same guard on this door: a `system` record's `content` can carry a harness frame
  // too, and the frame is the one thing that must never reach the screen.
  if (isHarnessFrame(record.content)) return null;
  const text = typeof record.content === "string" && record.content.trim()
    ? record.content.trim()
    : typeof record.error?.formatted === "string" && record.error.formatted.trim()
      ? record.error.formatted.trim()
      // `error.message` is the last resort: some records carry no formatted form.
      : typeof record.error?.message === "string" && record.error.message.trim()
        ? record.error.message.trim()
        : "";
  if (!text) return null;
  return { subtype: record.subtype || "", level: record.level || "info", content: text };
}
