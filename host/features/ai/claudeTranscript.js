// Rebuilds a chat log from Claude's own transcript file; split from ptyDaemon so the lookup is testable without a daemon.
import fs from "fs";
import path from "path";
import os from "os";
import { isInjectedTurn } from "../terminal/agentHistory.js";
import { buildEditDiff, DIFF_TOOL_NAMES, collapsePersisted } from "./adapters/claudeAdapter.js";
import { toolStart, toolResult, asyncHandle, taskNotificationFrom } from "./toolEvent.js";

// Untrusted client-supplied id: plain ids only, plus a projects-dir jail below — `..` would otherwise read any file on disk.
export const CLAUDE_SESSION_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/;

// Origins the CLI writes its own messages under — not turns anyone typed.
const CLAUDE_INJECTED_ORIGINS = ["task-notification"];

// Replay emits subtype: "task_notification" via taskNotificationFrom (shared with claudeAdapter).
export { taskNotificationFrom };

// The flags decide, not the text — most injected records carry no text marker, and passing one to --rewind-files fails the whole rewind.
export function isClaudeInjectedTurn(record) {
  if (record.isMeta || record.turnCompanion) return true;
  // The compaction's own summary — harness talking to itself, nothing a pane shows.
  if (record.isCompactSummary) return true;
  return CLAUDE_INJECTED_ORIGINS.includes(record.origin?.kind);
}

const readdirOr = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };

// The pane draws a row from only two kinds (a SessionStart hook's output, a queued
// prompt); every other attachment body (environment snapshot, listings, instructions)
// renders nothing. Carried whole, one conversation's attachments evict its real turns
// from the replay window a reopened pane hydrates from.
function slimAttachmentRecord(record) {
  const a = record?.attachment || {};
  const attachment = {};
  for (const key of ["type", "hookEvent", "hookName", "filename", "content", "prompt"]) {
    if (a[key] !== undefined) attachment[key] = a[key];
  }
  return { attachment };
}

function findTranscript(cwd, cliSessionId) {
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  const safeCwd = String(cwd).replace(/[/\\:]/g, "-");
  let p = path.join(projectsDir, safeCwd, `${cliSessionId}.jsonl`);
  if (!fs.existsSync(p) && !safeCwd.startsWith("-")) {
    p = path.join(projectsDir, `-${safeCwd}`, `${cliSessionId}.jsonl`);
  }
  // The transcript lives under the dir the CLI was started in, not the terminal's current cwd — find by id on miss.
  if (!fs.existsSync(p)) {
    for (const entry of readdirOr(projectsDir)) {
      const candidate = path.join(projectsDir, entry, `${cliSessionId}.jsonl`);
      if (fs.existsSync(candidate)) { p = candidate; break; }
    }
  }
  // Defense in depth: even with the id validated, never read outside the projects dir.
  const resolved = path.resolve(p);
  if (!resolved.startsWith(path.resolve(projectsDir) + path.sep)) return null;
  return fs.existsSync(resolved) ? resolved : null;
}

// The CALL carries the edit strings, the result only the id — keyed like the live adapter's toolCalls.
const DIFF_TOOL_SET = new Set(DIFF_TOOL_NAMES);

// The SAME test decides user_message, tool results and rewind indices — disagreeing copies misplace the rewind cut.
export const textOf = (record) => {
  const content = record?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.find((c) => c.type === "text")?.text || "";
  return "";
};
export const isTypedTurn = (record) => {
  const text = textOf(record);
  // isInjectedTurn is the reader's last word here too — without it the rewind list counted turns the pane never drew.
  return record.type === "user" && !record.isSidechain && !isClaudeInjectedTurn(record)
    && Boolean(text) && !isInjectedTurn(text);
};

// One read of the transcript for every reader that needs it: a record parsed once,
// kept beside its line. The live-turn rule, the event walk and the session state all
// read the same file, and parsing it once per reader cost more than the walk itself.
export function readTranscript(file) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return { lines: [], records: [] }; }
  // Walk the string instead of split()ing it: a tens-of-megabytes transcript pays for
  // every line string it allocates, and only the records are ever read. Empty lines
  // keep their slot so `records[i]` still lines up with `lines[i]`.
  const lines = [];
  const records = [];
  let start = 0;
  for (;;) {
    const nl = raw.indexOf("\n", start);
    const end = nl === -1 ? raw.length : nl;
    const line = end > start ? raw.slice(start, end) : "";
    lines.push(line);
    if (!line.trim()) records.push(null);
    else { try { records.push(JSON.parse(line)); } catch { records.push(null); } }
    if (nl === -1) break;
    start = nl + 1;
  }
  return { lines, records };
}

// A rewind only moves the leafUuid pointer and leaves dropped turns in the file, and the live branch can be non-contiguous — so keep the parentUuid chain, never a line range.
function liveTurns(records, leafOverride = null) {
  let leaf = leafOverride;
  // leafOverride: the CLI answers a rewind ~50ms before it flushes the new last-prompt — read as-if-written in that window.
  let lastPointer = -1;
  const byUuid = new Map();
  const at = new Map();
  const turns = [];
  for (let index = 0; index < records.length; index++) {
    const d = records[index];
    if (!d) continue;
    if (d.type === "last-prompt" && d.leafUuid) { if (!leafOverride) leaf = d.leafUuid; lastPointer = index; }
    if (!d.uuid) continue;
    byUuid.set(d.uuid, d);
    at.set(d.uuid, index);
    if (isTypedTurn(d)) turns.push(d.uuid);
  }
  if (!leaf || !turns.length) return null;

  const onBranch = new Set();
  for (let cur = leaf; cur && byUuid.has(cur) && !onBranch.has(cur); ) {
    onBranch.add(cur);
    cur = byUuid.get(cur).parentUuid;
  }
  if (!onBranch.size) return null;

  // Outside the pointer's reach, believe the file: turns above a compaction and below the newest last-prompt stay live — but an override speaks for everything below it.
  let firstReached = Infinity;
  for (const uuid of onBranch) firstReached = Math.min(firstReached, at.get(uuid) ?? Infinity);

  const live = new Set();
  for (const uuid of turns) {
    const line = at.get(uuid) ?? -1;
    if (onBranch.has(uuid) || (leafOverride ? false : (line < firstReached || line > lastPointer))) live.add(uuid);
  }
  return live;
}

// The ONE place the leaf rule is applied, so the pane and the rewind list cannot disagree on which turns exist.
export function liveTranscript(file, leafOverride = null) {
  const { lines, records } = readTranscript(file);
  return { lines, records, live: liveTurns(records, leafOverride) };
}

// Reopening a chat re-reads the same transcript, and it is usually unchanged since the
// last look — a reattach after an F5 must still answer, but it need not redo the whole
// rebuild to do it. Keyed on size+mtime, so any append invalidates it; a file that
// shrank (a rewind rewrote it) misses too, since the key cannot match.
//
// Only the ANSWER is kept: the parsed records are what a cold read produces on its way
// to it, and holding both doubled what an open chat costs in RAM for a value nothing
// reads again. A miss re-reads the file, which is exactly when it is needed.
const TRANSCRIPT_CACHE_MAX = 4;
const transcriptCache = new Map();

/** The file's cache identity, or null when it cannot be read. */
function transcriptKey(file) {
  try {
    const stat = fs.statSync(file);
    return `${stat.size}\u0000${stat.mtimeMs}`;
  } catch {
    return null;
  }
}

function cacheLookup(file, key) {
  const hit = transcriptCache.get(file);
  if (!hit || hit.key !== key) return null;
  // Refresh LRU position.
  transcriptCache.delete(file);
  transcriptCache.set(file, hit);
  return hit;
}

function cacheStore(file, key, value) {
  transcriptCache.delete(file);
  transcriptCache.set(file, { key, ...value });
  if (transcriptCache.size > TRANSCRIPT_CACHE_MAX) {
    transcriptCache.delete(transcriptCache.keys().next().value);
  }
}

/** Test seam: the cache must never make a stale read look fresh. */
export function clearTranscriptCache() { transcriptCache.clear(); }

// leafOverride: read as if that pointer were already flushed — see liveTurns.
export function recoverFromClaudeTranscript(cwd, cliSessionId, startSeq = 1, leafOverride = null) {
  const bundle = recoverClaudeBundle(cwd, cliSessionId, { startSeq, leafOverride });
  return bundle?.events || null;
}

/**
 * Both readers of one transcript in a single read: the rebuilt event log and the
 * session state. They always look at the same file, so reading it twice bought
 * nothing but a second parse of everything the first pass had already decoded.
 */
export function recoverClaudeBundle(cwd, cliSessionId, { startSeq = 1, leafOverride = null } = {}) {
  if (!cwd || !cliSessionId) return null;
  if (!CLAUDE_SESSION_ID_RE.test(cliSessionId)) return null;
  const resolved = findTranscript(cwd, cliSessionId);
  if (!resolved) return null;

  // A rewind is rewriting this very file as it asks; the caller needs what is on disk
  // right now, not what the last open happened to see. It also reads a different
  // branch than a plain open, so its answer is not the one to cache either.
  if (leafOverride) {
    return buildBundle(resolved, readTranscript(resolved).records, leafOverride, startSeq);
  }

  const key = transcriptKey(resolved);
  // A file that could not be stat'ed cannot be cached; read it and let the read decide.
  if (key == null) {
    const read = readTranscript(resolved);
    return buildBundle(resolved, read.records, null, startSeq);
  }

  // The cache stores the ANSWER, not the parse: rebuilding events from unchanged
  // records is where the remaining time went, so reusing only the records saved half.
  const hit = cacheLookup(resolved, key);
  if (hit?.bundle && hit.startSeq === startSeq) return hit.bundle;

  const bundle = buildBundle(resolved, readTranscript(resolved).records, null, startSeq);
  cacheStore(resolved, key, { bundle, startSeq });
  return bundle;
}

function buildBundle(resolved, records, leafOverride, startSeq) {
  const live = liveTurns(records, leafOverride);
  const events = buildClaudeEvents(resolved, records, live, startSeq);
  const state = readClaudeSessionStateFromRecords(records);
  return events ? { events, state } : { events: null, state };
}

function buildClaudeEvents(resolved, records, live, startSeq) {
  try {
    const events = [];
    // Tool calls awaiting their result, by tool_use id — see DIFF_TOOL_SET.
    const toolCalls = new Map();
    let seq = startSeq;
    let cut = false;   // set when the walk passes a turn the branch no longer holds

    // CLI 2.1+: a sub-agent's records live in their own file beside the main one —
    // <sid>/subagents/agent-*.jsonl — with the spawner's tool_use id in the .meta.json.
    // Replayed as tool_child/tool_result_child so a reopened chat rebuilds the card tree.
    const subByTool = new Map();
    const subsDir = path.join(path.dirname(resolved), path.basename(resolved, ".jsonl"), "subagents");
    for (const name of readdirOr(subsDir)) {
      if (!name.endsWith(".meta.json")) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(subsDir, name), "utf8"));
        const file = path.join(subsDir, name.replace(/\.meta\.json$/, ".jsonl"));
        if (meta.toolUseId && fs.existsSync(file)) subByTool.set(meta.toolUseId, file);
      } catch {}
    }
    // Tool ids this walk emitted a start for — a sub-agent of a rewound-away turn has no card to nest under.
    const launchedIds = new Set();
    const walkedSubs = new Set();
    const walkSubagent = (file, parent) => {
      if (walkedSubs.has(file)) return;
      walkedSubs.add(file);
      let subLines;
      try { subLines = fs.readFileSync(file, "utf8").split("\n"); } catch { return; }
      for (const line of subLines) {
        if (!line.trim()) continue;
        let d;
        try { d = JSON.parse(line); } catch { continue; }
        const items = d.message?.content;
        if (!Array.isArray(items)) continue;
        if (d.type === "assistant") {
          for (const item of items) {
            if (item?.type !== "tool_use") continue;
            toolCalls.set(item.id, { name: item.name, input: item.input });
            const start = toolStart({ id: item.id, name: item.name, input: item.input, parentToolUseId: parent });
            start.event = "tool_child";
            events.push({ seq: seq++, ...start });
            // A sub-agent may spawn one of its own — its file nests the same way.
            if (subByTool.has(item.id)) walkSubagent(subByTool.get(item.id), item.id);
          }
        } else if (d.type === "user") {
          for (const tr of items.filter((c) => c?.type === "tool_result")) {
            const isError = Boolean(tr.is_error);
            const resultText = typeof tr.content === "string"
              ? tr.content
              : (tr.content || []).map((c) => (typeof c === "string" ? c : c?.text || "")).join("");
            const call = toolCalls.get(tr.tool_use_id);
            toolCalls.delete(tr.tool_use_id);
            events.push({
              seq: seq++,
              event: "tool_result_child",
              data: {
                id: tr.tool_use_id,
                name: call?.name || "",
                output: isError ? resultText : collapsePersisted(resultText),
                error: isError ? resultText : "",
                status: isError ? "error" : "done",
                parentToolUseId: parent
              }
            });
          }
        }
      }
    };

    // A notification ends the tool row it names — on this door the settle is the row's only end (no watchdog in a replay).
    const pushTaskNotification = (task) => {
      events.push({ seq: seq++, ...task });
      const toolUseId = task.data.record.tool_use_id;
      if (toolUseId) {
        // Same shape armAsyncWatchdog settles with, so both doors close the row the same way.
        events.push({ seq: seq++, event: "tool_result", data: { id: toolUseId, status: "done", async: true } });
      }
    };

    for (const d of records) {
      if (!d) continue;
      try {
        // A dropped turn takes its answer with it; the cuts interleave, so follow the turns, not one cut point.
        if (live && isTypedTurn(d)) cut = !live.has(d.uuid);
        if (cut) continue;
        // Read before the injection guard drops it: the only end signal for a task, or a replay shows it running forever.
        if (d.type === "user" && d.message) {
          const task = taskNotificationFrom(d);
          if (task) pushTaskNotification(task);
        }
        // Sidechain/injected records are not typed turns — drawing them miscounts the rewind indices and ends the log mid-turn.
        if (d.type === "user" && d.message && !d.isSidechain && !isClaudeInjectedTurn(d)) {
          // Through textOf: a typed turn may be a plain string, and .find on a string throws.
          const text = textOf(d);
          if (text && !isInjectedTurn(text)) {
            events.push({ seq: seq++, event: "user_message", data: { text } });
          }
          // A tool result is a `user` record too, and only ever the array form.
          const content = Array.isArray(d.message.content) ? d.message.content : [];
          const toolResults = content.filter((c) => c.type === "tool_result");
          for (const tr of toolResults) {
            const output = typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content);
            // Person-visible text: a <persisted-output> frame starts at char 0 of the TEXT, never the serialized form.
            const resultText = typeof tr.content === "string"
              ? tr.content
              : (tr.content || []).map((c) => (typeof c === "string" ? c : c?.text || "")).join("");
            // The flag is the whole answer on both doors — a text match only ever added false errors.
            const isError = Boolean(tr.is_error);
            const call = toolCalls.get(tr.tool_use_id);
            toolCalls.delete(tr.tool_use_id);
            // A launch ack is not a result — same rule as the live door, or a reload shows running work as finished.
            const async = isError ? null : asyncHandle(output, call?.name || "");
            events.push({
              seq: seq++,
              ...toolResult({
                id: tr.tool_use_id,
                // The result carries only the id — the name comes from the call it answers.
                name: call?.name || "",
                // Same collapse the live door applies, so a reopened chat shows the line the pane showed live.
                output: isError ? output : collapsePersisted(resultText),
                error: isError ? output : "",
                // `running`, not `done` — the work outlives the call, and the handle lets a later record settle it.
                ...(async ? { status: "running", async: true, handle: async.id } : null)
              })
            });
            // A rejected edit never reached the disk, so it paints no diff — the tool row stays to say it was refused.
            if (call && !isError && DIFF_TOOL_SET.has(call.name)) {
              const diff = buildEditDiff(call.name, call.input);
              if (diff) events.push({ seq: seq++, event: "diff", data: diff });
            }
          }
        } else if (d.type === "user" && d.isSidechain && d.parent_tool_use_id) {
          // A sub-agent's tool results nest under their spawner — same wire events the
          // live door's remap produces (aiSession CHILD_EVENTS), so a reopened chat
          // rebuilds the card tree instead of dropping the sub-agent's results.
          const content = Array.isArray(d.message.content) ? d.message.content : [];
          for (const tr of content.filter((c) => c.type === "tool_result")) {
            const isError = Boolean(tr.is_error);
            const resultText = typeof tr.content === "string"
              ? tr.content
              : (tr.content || []).map((c) => (typeof c === "string" ? c : c?.text || "")).join("");
            const call = toolCalls.get(tr.tool_use_id);
            toolCalls.delete(tr.tool_use_id);
            events.push({
              seq: seq++,
              event: "tool_result_child",
              data: {
                id: tr.tool_use_id,
                name: call?.name || "",
                output: isError ? resultText : collapsePersisted(resultText),
                error: isError ? resultText : "",
                status: isError ? "error" : "done",
                parentToolUseId: d.parent_tool_use_id
              }
            });
          }
        } else if (d.type === "attachment") {
          // Harness-injected context, slimmed to what the pane can ever draw (see slimAttachmentRecord).
          events.push({
            seq: seq++,
            event: "cli_event",
            data: { type: "attachment", subtype: d.attachment?.type || "", record: slimAttachmentRecord(d) }
          });
        } else if (d.type === "queue-operation") {
          // A notification queued mid-turn is removed at the turn's end, never re-delivered as a user record — this is its only door.
          const task = taskNotificationFrom(d);
          if (task) pushTaskNotification(task);
        } else if (d.type === "system") {
          // Carried whole under its own name — the pane (noticeFrom) decides what to show.
          events.push({
            seq: seq++,
            event: "cli_event",
            data: { type: "system", subtype: d.subtype || "", record: d }
          });
        } else if (d.type === "assistant" && d.message) {
          // A sidechain record is a sub-agent at work: its calls nest (tool_child), and
          // its thinking/text/turn-end belong to the card, not the main timeline.
          const parent = d.parent_tool_use_id || "";
          for (const item of d.message.content || []) {
            if (item.type === "thinking" && item.thinking && !parent) {
              events.push({ seq: seq++, event: "thinking", data: { text: item.thinking } });
            } else if (item.type === "tool_use") {
              // Held for its result: the diff is built from this call's input — the result carries only the id.
              toolCalls.set(item.id, { name: item.name, input: item.input });
              const start = toolStart({ id: item.id, name: item.name, input: item.input, parentToolUseId: parent || null });
              if (parent) start.event = "tool_child";
              events.push({ seq: seq++, ...start });
              if (!parent) launchedIds.add(item.id);
            } else if (item.type === "text" && item.text && !parent) {
              events.push({ seq: seq++, event: "delta", data: { text: item.text } });
            }
          }
          const isTurnEnd = !parent && d.message.stop_reason !== "tool_use" &&
            !(d.message.content || []).some((item) => item.type === "tool_use");
          if (isTurnEnd) events.push({ seq: seq++, event: "turn_complete", data: { stats: {} } });
        }
      } catch {}
    }

    // Sub-agent files nest after the main walk — every parent card exists before its children arrive.
    for (const [toolUseId, file] of subByTool) {
      if (launchedIds.has(toolUseId)) walkSubagent(file, toolUseId);
    }

    return events.length > 0 ? events : null;
  } catch {
    return null;
  }
}

// The LAST record of each kind wins; absent stays absent so it cannot blank a live value. cost-state is skipped — stale at 0.
// Reads already-parsed records when a caller has them (one file read serves the rebuild too).
export function readClaudeSessionStateFromRecords(records) {
  const out = {};
  for (const d of records || []) {
    if (!d) continue;
    switch (d.type) {
      case "permission-mode": if (d.permissionMode) out.permissionMode = d.permissionMode; break;
      // The harness files the mode on every user record too (the TUI's own field), so a
      // stream-json session that never wrote a `permission-mode` record still states one.
      // Last one wins, same as above — the mode the newest turn ran with.
      case "user": if (d.permissionMode) out.permissionMode = d.permissionMode; break;
      case "mode": if (d.mode) out.mode = d.mode; break;
      case "ai-title": if (d.aiTitle) out.title = d.aiTitle; break;
      case "last-prompt": if (d.lastPrompt) out.lastPrompt = d.lastPrompt; break;
      // Only `environment` carries the session's own cwd/git facts — other attachment types are per-turn noise.
      case "attachment": {
        const snap = d.attachment?.type === "environment" ? d.attachment.snapshot : null;
        if (!snap) break;
        if (snap.workingDirectory) out.cwd = snap.workingDirectory;
        out.isWorktree = Boolean(snap.isWorktree);
        out.isGitRepo = Boolean(snap.isGitRepo);
        break;
      }
      default: break;
    }
  }
  return Object.keys(out).length ? out : null;
}

export function readClaudeSessionState(cwd, cliSessionId) {
  if (!cwd || !cliSessionId) return null;
  if (!CLAUDE_SESSION_ID_RE.test(cliSessionId)) return null;
  const file = findTranscript(cwd, cliSessionId);
  if (!file) return null;

  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return null; }

  // Cheap gate before parsing: only these record kinds carry state. Kept as a
  // substring test so a line the walk does not need is never parsed.
  const records = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    if (!line.includes('"permission-mode"') && !line.includes('"ai-title"') &&
        !line.includes('"last-prompt"') && !line.includes('"attachment"') &&
        !line.includes('"permissionMode"') && !line.includes('"mode"')) continue;
    try { records.push(JSON.parse(line)); } catch {}
  }
  return readClaudeSessionStateFromRecords(records);
}

// stream-json never carries attachments, so tail-read by byte offset; stop before a trailing line still being written.
export function readNewAttachments(cwd, cliSessionId, offset = 0) {
  const nothing = { records: [], offset: offset || 0 };
  if (!cwd || !cliSessionId || !CLAUDE_SESSION_ID_RE.test(cliSessionId)) return nothing;
  const file = findTranscript(cwd, cliSessionId);
  if (!file) return nothing;

  let fd;
  try {
    const size = fs.statSync(file).size;
    // Infinity seeds the offset at EOF without replaying an already-drawn conversation.
    if (offset === Infinity) return { records: [], offset: size };
    const from = Number.isFinite(offset) && offset > 0 ? offset : 0;
    // A shrunk file invalidates the offset — a stale one lands mid-record.
    if (from > size) return { records: [], offset: 0 };
    if (from === size) return { records: [], offset: from };

    fd = fs.openSync(file, "r");
    const length = size - from;
    const buf = Buffer.allocUnsafe(length);
    const read = fs.readSync(fd, buf, 0, length, from);
    const text = buf.subarray(0, read).toString("utf8");

    // Only whole lines are records — keep the offset before the partial last line.
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline === -1) return { records: [], offset: from };
    const complete = text.slice(0, lastNewline);

    const records = [];
    for (const line of complete.split("\n")) {
      if (!line.trim()) continue;
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      if (d?.type === "attachment" && d.attachment?.type) records.push(d);
    }
    // Bytes, not characters — a multi-byte char would resume short.
    return { records, offset: from + Buffer.byteLength(complete, "utf8") + 1 };
  } catch {
    return nothing;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}
