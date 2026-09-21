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

import { formatTokens } from "./liveStatus";

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
export const TASK_ENDED = new Set(["completed", "failed", "killed", "stopped"]);

/** How long a task has been running, from the marks the pane keeps on its own clock. */
export const taskElapsedMs = (task, now = Date.now()) => {
  if (task?.usage?.duration_ms > 0) return task.usage.duration_ms;
  if (task?.endedAt && task?.startedAt) return Math.max(0, task.endedAt - task.startedAt);
  return task?.startedAt ? Math.max(0, now - task.startedAt) : 0;
};

/**
 * The mark a task's clock counts from — the host states the task's AGE, never its start.
 *
 * A duration, not a timestamp: the two machines sit on different clocks, and subtracting
 * one machine's mark from the other's prints the skew (same rule as AiSession.turnState's
 * `elapsedMs`). A record that carries no age is one this client is watching arrive, so it
 * starts now. Only ever WRITES the mark onto a task that has none: the harness re-announces
 * a task without the field, and stamping it again would restart a clock the reader has
 * been watching for minutes.
 */
const startedAtPatch = (ageMs, existing) =>
  existing?.startedAt ? null : { startedAt: Date.now() - (Number.isFinite(ageMs) ? Math.max(0, ageMs) : 0) };

/**
 * Where the running "Compacting…" row sits, or -1 when there is none.
 *
 * Scanned rather than read off the end: the CLI can put another readable record between a
 * compaction's start and its end — `api_error` is the one that actually happens, when the
 * summarization call itself fails — and a rule that only checked the last row left the
 * spinner running under the finished one. Shared by both doors (the reducer and the store),
 * which is why it sits with the reader that produced the row rather than in either of them.
 */
export const lastIndexOfCompacting = (messages = []) => {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.compacting) return i;
  return -1;
};

/**
 * The statuses that mean a compaction is RUNNING.
 *
 * The CLI sets one when it starts and clears it when it ends (`status: null` with a
 * `compact_result` beside it), so the clearing is what tells the row to stop. Listed as a
 * set rather than matched on the word "compact" because the field is the CLI's whole
 * activity channel: a future status must be added here on purpose, not matched by luck.
 */
const COMPACTING_STATUSES = new Set(["compacting"]);

/** Fold one harness record into the task list. Returns the SAME array when nothing moved. */
export function applyTaskRecord(tasks, type, subtype, record, ageMs = undefined) {
  if (type !== "system") return tasks;
  const effectiveAge = Number.isFinite(ageMs) ? ageMs : record?.ageMs;
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
        ...(record.task_type ? { taskType: record.task_type } : null),
        ...startedAtPatch(effectiveAge, tasks.find((t) => t.taskId === record.task_id))
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
      const resumed = patch.status && !TASK_ENDED.has(patch.status);
      const merged = {
        ...next[at],
        ...(patch.status ? { status: patch.status } : null),
        ...(patch.description ? { description: patch.description } : null),
        ...(patch.end_time ? { endedAt: patch.end_time } : null)
      };
      // Deleted, not set to undefined: the key has to be GONE, or a `t.endedAt != null`
      // read on the other side still finds it.
      if (resumed) delete merged.endedAt;
      // A task resumed after this client saw it start is running from where it left off —
      // a mark left at its ORIGINAL start would print the pause as work.
      if (resumed && next[at].endedAt) Object.assign(merged, startedAtPatch(effectiveAge, null));
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
        endedAt: next[at].endedAt || Date.now(),
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
      // Absence means the task is gone. The test is a TASK_ENDED status, not `running`: a
      // paused task is still alive and still listed, so one that vanished while paused
      // ended too — leaving it paused forever is the stuck row this whole model replaces.
      //
      // Background only. A sub-agent is never in this list, so reading it as "everything
      // else ended" would settle every sub-agent the moment a shell task changed.
      if (next.some((t) => t.background && !TASK_ENDED.has(t.status) && !live.has(t.taskId))) {
        next = next.map((t) =>
          t.background && !TASK_ENDED.has(t.status) && !live.has(t.taskId)
            ? { ...t, status: "stopped", endedAt: t.endedAt || Date.now() }
            : t
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
          ...(t.task_type ? { taskType: t.task_type } : null),
          // A client that joined mid-task gets the live set, not the history of it — so
          // the record's own age is the only edge this clock can count from.
          ...startedAtPatch(effectiveAge, next.find((x) => x.taskId === t.task_id))
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

/**
 * Fold the host's task records, then the replayed log's, into one list.
 *
 * The two are the SAME records from two doors: the host states the task set beside the
 * log (a task announced at the top of a long turn falls outside the replay tail, which
 * is how an F5 came back with an empty strip), and the window carries whatever of it
 * still fits. Host first, window on top — the window is the newer reading of the events
 * they share, and folding them in that order lands on the same list a client that
 * watched the whole turn live would have.
 *
 * Both are raw records in the harness's own shape, so ONE reader folds them: a second
 * copy of these rules is the drift this file exists to prevent.
 */
export function foldTaskRecords(hostRecords, windowTasks) {
  let tasks = [];
  for (const rec of hostRecords || []) {
    if (!rec) continue;
    tasks = applyTaskRecord(tasks, rec.type || "system", rec.subtype || "", rec.record || null, rec.ageMs);
  }
  // The window came folded already (reduceSessionEvents). Merged by task id — NOT through
  // taskList's upsertTask, whose rules are TaskCreate's (it only opens a row on a
  // `subject`, and refuses to add a task nobody listed): a harness record has no subject,
  // so routing these through it dropped every one of them.
  const byId = new Map(tasks.map((t) => [t.taskId, t]));
  for (const t of windowTasks || []) {
    if (t?.taskId) byId.set(t.taskId, { ...byId.get(t.taskId), ...t });
  }
  return [...byId.values()];
}

/** The tasks still running, newest last — the strip's read model. */
export const runningTasks = (tasks = []) => tasks.filter((t) => t.status === "running");

/**
 * The context compaction, as the CLI's `compact_boundary` record states it.
 *
 * Two spellings of the same fields, because the two doors carry the record differently:
 * stream-json puts snake_case on the frame (`compact_metadata`, `pre_tokens`), and the
 * transcript the CLI writes for itself — which is what a reopened chat replays from —
 * uses camelCase (`compactMetadata`, `preTokens`). Both are read here so one row is drawn
 * either way.
 *
 * The LIVE frame is the reason this exists at all: it carries the metadata and NO
 * `content`, while the transcript copy also carries "Conversation compacted". A reader
 * that only looked for text drew nothing live and a row after a reload.
 */
function compactFrom(record) {
  const m = record.compact_metadata || record.compactMetadata;
  if (!m || typeof m !== "object") return null;
  const num = (v) => (Number.isFinite(v) ? v : null);
  const preTokens = num(m.pre_tokens ?? m.preTokens);
  const postTokens = num(m.post_tokens ?? m.postTokens);
  // The window's own two numbers, in the CLI's shorthand. `preTokens` is what the turn
  // resent before compaction, so it is also the context fill the pane has been showing.
  const shift = preTokens != null && postTokens != null
    ? `${formatTokens(preTokens)} → ${formatTokens(postTokens)} tokens`
    : "";
  return {
    trigger: m.trigger || "auto",
    preTokens,
    postTokens,
    durationMs: num(m.duration_ms ?? m.durationMs),
    // Only what the record actually states — a metadata-only record with no counts draws
    // the word "Compacted" and nothing invented next to it.
    ...(shift ? { detail: shift } : null)
  };
}

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
  // OpenCode runner records ride whole under session.next.* names (cli_event);
  // only the ones a reader needs to see get a row, the rest stay stored silently.
  if (type.startsWith("session.next.")) {
    if (type === "session.next.retried") {
      const text = `Retrying (attempt ${record.attempt ?? "?"}): ${record.error?.message || ""}`.trim();
      return { subtype: type, level: "warning", content: text };
    }
    if (type === "session.next.compaction.started") {
      return { subtype: type, level: "info", content: "Compacting…", compacting: true };
    }
    if (type === "session.next.compaction.ended") {
      return { subtype: type, level: "info", content: "Compacted", compactSettled: true };
    }
    if (type === "session.next.revert.staged") return { subtype: type, level: "info", content: "Rewind staged" };
    if (type === "session.next.revert.committed") return { subtype: type, level: "info", content: "Rewound the conversation" };
    if (type === "session.next.agent.switched") return { subtype: type, level: "info", content: `Agent: ${record.agent || ""}` };
    return null;
  }
  if (type === "warning" || type === "guardianWarning" || type === "configWarning" || type === "deprecationNotice") return null;
  // Codex says the same things under its own names, and it says them the same way: a
  // record whose whole point IS the sentence (`warning`, `warning`/`guardianWarning`,
  // a `configWarning`) is one the CLI means a person to read. Its errors nest one level
  // (`error.error.message`), and a reroute is a change of model the user should see —
  // silently answering from another model is the kind of thing this file exists to stop.
  const codexText =
    type === "error" ? String(record.error?.message || "").trim()
    : type === "warning" || type === "guardianWarning" ? String(record.message || "").trim()
    : type === "configWarning" ? [record.summary, record.details].filter(Boolean).join(" — ").trim()
    : type === "deprecationNotice" ? [record.summary, record.details].filter(Boolean).join(" — ").trim()
    : type === "model/rerouted" ? `Model rerouted: ${record.fromModel} → ${record.toModel}`
    : "";
  if (codexText) {
    // A retrying error is the CLI saying it is still working, and painting it red says the
    // turn died. Only the one it is not retrying is an error.
    const level = type === "error" && !record.willRetry ? "error" : "warning";
    return { subtype: type, level, content: codexText };
  }
  // Codex states a compaction as one notification and nothing else — no start, no counts,
  // and no content. It gets the same one-line row Claude's boundary gets, because it is
  // the same event in the conversation: the context behind this turn was folded, and a
  // reader scrolling back deserves to know why the thread looks different.
  if (type === "thread/compacted") {
    return { subtype: type, level: "info", content: "Compacted", compactSettled: true };
  }
  // The one record whose live frame carries no text at all — see compactFrom. Read before
  // the content rules below, which would otherwise drop it.
  if (type === "system" && record.subtype === "compact_boundary") {
    const compact = compactFrom(record);
    const text = typeof record.content === "string" ? record.content.trim() : "";
    if (!compact && !text) return null;
    return {
      subtype: "compact_boundary", level: record.level || "info", content: text || "Compacted",
      // The boundary is also the end of a compaction the CLI announced it had started, so
      // the pane replaces that row rather than stacking this one under it.
      compactSettled: true,
      ...(compact ? { compact } : null)
    };
  }
  // The CLI's own sign that a compaction is RUNNING, and — on the same channel — the sign
  // that it stopped. Live-only: the harness never writes either to the transcript, so a
  // reopened chat has no such line to replay, which is right, by then it is over.
  if (type === "system" && record.subtype === "status") {
    if (COMPACTING_STATUSES.has(record.status)) {
      return { subtype: "status", level: "info", content: "Compacting…", compacting: true };
    }
    // The end of it. The CLI clears `status` when the compaction finishes and states the
    // outcome beside it when there is one: `compact_result: "failed"` (and then NO boundary
    // is ever written), or nothing at all when it was skipped. Both close the running row —
    // without this the row spun forever over a compaction that had already given up.
    // `requesting` is excluded on purpose: it opens some other request, and the boundary
    // and this clear are the only two frames that end a compaction.
    if (record.status != null && !record.compact_result) return null;
    const failed = record.compact_result === "failed";
    return {
      subtype: "status",
      level: failed ? "error" : "info",
      // `compact_error` is behind a feature flag in the CLI and is often stripped; the
      // outcome word is always there, so that is what the row falls back to.
      content: failed ? String(record.compact_error || "").trim() || "Compaction failed" : "",
      compactSettled: true
    };
  }
  // An `attachment` is what the harness put INTO the conversation, and two of its kinds
  // carry text a person reads: a hook's output and a prompt waiting for its turn. The rest
  // (`environment`, `task_reminder`, `prompt_snapshot`, the listings) hold state, not prose.
  if (type === "attachment") {
    const a = record.attachment || record;
    const kind = a.type || "";
    // `edited_text_file` draws NO row. It is the one attachment the reader carries without
    // ever looking at it, and the row it used to draw said only the file's PATH — a line
    // the pane already has beside it: a diff card's own title for an edit, the shell
    // command's text for a script that wrote the file. What that cost was one path line
    // per file touched, every turn that touched one, on a pane whose whole job is to stay
    // readable. The record still travels (see the caller) — dropping it there would mean
    // this reader deciding which attachments the rest of the system gets to see.
    if (kind === "edited_text_file") return null;
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
