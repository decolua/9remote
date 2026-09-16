// Rebuilding a chat log from Claude's own transcript file. Split out of ptyDaemon
// so the lookup can be tested without starting a daemon — an unbound conversation
// shows as an empty chat pane, which looks like a UI bug rather than a lookup miss.
import fs from "fs";
import path from "path";
import os from "os";
import { isInjectedTurn } from "../terminal/agentHistory.js";
import { buildEditDiff, DIFF_TOOL_NAMES } from "./adapters/claudeAdapter.js";
import { toolStart, toolResult } from "./toolEvent.js";

// `cliSessionId` can originate from a client (a /resume choice), so it is untrusted:
// only a plain id is accepted — the first character may not be "-" (argv would read it
// as a flag) and no path separator or whitespace is allowed — and the resolved path is
// confirmed to sit inside the projects directory. Without this, `..` in the id would
// escape the directory and read any file on disk.
export const CLAUDE_SESSION_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/;

// Origins the CLI writes its own messages under: a background task reporting back, not
// a turn anyone typed. The id is the CLI's, and no other engine writes a record this way.
const CLAUDE_INJECTED_ORIGINS = ["task-notification"];

// The fields of a `<task-notification>` body. The record is a NOTIFICATION, not a turn —
// it is dropped from the log as a prompt (see isClaudeInjectedTurn), but it carries the
// only end signal the transcript keeps for a task, so it is read before it is dropped.
const taskField = (text, name) => {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(text);
  return m ? m[1].trim() : "";
};

/**
 * A task's end, in the shape the pane already reads — the CLI's own `task_notification`
 * record, so the replay door and the live door speak one vocabulary.
 *
 * `type`/`subtype` and the field names are the harness's, deliberately: the pane folds
 * task records with ONE reader (web/features/ai/lib/harnessTasks.js), and a second shape
 * invented here would be a task that vanishes on reopen with nothing on screen to say it
 * was ever there.
 */
function taskNotificationFrom(record) {
  const content = record?.message?.content;
  const text = typeof content === "string"
    ? content
    : (content || []).map((c) => (typeof c === "string" ? c : c?.text || "")).join(" ");
  if (!text.includes("<task-notification>")) return null;
  const taskId = taskField(text, "task-id");
  if (!taskId) return null;
  const toolUseId = taskField(text, "tool-use-id");
  const outputFile = taskField(text, "output-file");
  const status = taskField(text, "status");
  const summary = taskField(text, "summary");
  return {
    event: "cli_event",
    data: {
      type: "system",
      subtype: "task_notification",
      record: {
        type: "system",
        subtype: "task_notification",
        task_id: taskId,
        ...(toolUseId ? { tool_use_id: toolUseId } : null),
        ...(status ? { status } : null),
        ...(outputFile ? { output_file: outputFile } : null),
        ...(summary ? { summary } : null)
      }
    }
  };
}

/**
 * A `user` record the harness wrote, not one the user typed — a slash command and its
 * output, a skill's own body, an attached image, a background task's report.
 *
 * The flags decide, not the text: the injected records whose text is not wrapped in a
 * tag (a skill's markdown, "Base directory for this skill: …", "[Image: …") carry no
 * marker to match on, and they are most of them. Verified against every transcript on
 * this machine: these flags caught all 850 of the injected records, while the text
 * patterns caught 783. Passing one to `--rewind-files` fails the whole rewind — the CLI
 * answers "No file checkpoint found for this message" and reverts nothing.
 */
export function isClaudeInjectedTurn(record) {
  if (record.isMeta || record.turnCompanion) return true;
  return CLAUDE_INJECTED_ORIGINS.includes(record.origin?.kind);
}

const readdirOr = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };

/** The record without a file body it does not need — see the attachment branch below. */
function stripAttachmentBody(record) {
  if (!record?.attachment || record.attachment.type !== "edited_text_file") return record;
  const { snippet, ...attachment } = record.attachment;
  return { ...record, attachment };
}

function findTranscript(cwd, cliSessionId) {
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  const safeCwd = String(cwd).replace(/[/\\:]/g, "-");
  let p = path.join(projectsDir, safeCwd, `${cliSessionId}.jsonl`);
  if (!fs.existsSync(p) && !safeCwd.startsWith("-")) {
    p = path.join(projectsDir, `-${safeCwd}`, `${cliSessionId}.jsonl`);
  }
  // The transcript lives under the directory the CLI was STARTED in, which the
  // terminal may have since `cd`'d away from — so a miss on the cwd-derived path
  // says nothing about the conversation existing. Find it by id instead.
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

// A tool the user refused at the gate. The transcript keeps no "denied" flag, so the
// refusal is only visible in the result's text — and without this an edit that never
// landed would replay as a diff card, which the live path never draws.
const DENIED_RESULT_RE = /doesn't want to proceed|Request interrupted by user for tool use/i;

// Claude keeps the edit as old/new strings on the CALL, so the same builder the live
// adapter uses turns it back into the patch the card parses. Keyed by tool_use id, like
// the adapter's `toolCalls` — a result carries the id and nothing else.
const DIFF_TOOL_SET = new Set(DIFF_TOOL_NAMES);

export function recoverFromClaudeTranscript(cwd, cliSessionId, startSeq = 1) {
  if (!cwd || !cliSessionId) return null;
  if (!CLAUDE_SESSION_ID_RE.test(cliSessionId)) return null;
  const resolved = findTranscript(cwd, cliSessionId);
  if (!resolved) return null;

  try {
    const lines = fs.readFileSync(resolved, "utf8").trim().split("\n");
    const events = [];
    // Tool calls awaiting their result, by tool_use id — see DIFF_TOOL_SET.
    const toolCalls = new Map();
    let seq = startSeq;

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        // A task notification is read BEFORE the injection guard drops it: it is not a
        // turn, but it is the only place the transcript records that a task ended, and a
        // replayed conversation that loses it shows a sub-agent still running forever.
        if (d.type === "user" && d.message) {
          const task = taskNotificationFrom(d);
          if (task) events.push({ seq: seq++, ...task });
        }
        // A sidechain record is a sub-agent's own turn, not one the user typed. Kept out
        // of the log for the same reason the rewind list keeps it out: the pane would
        // show it as a prompt nobody sent, and every turn after it would be counted one
        // too high — which is exactly what the rewind control names turns by. An injected
        // turn is the harness's own writing, and a log rebuilt with one ends on a user
        // turn — which every reader takes to mean a turn is still running.
        if (d.type === "user" && d.message && !d.isSidechain && !isClaudeInjectedTurn(d)) {
          const textBlock = (d.message.content || []).find((c) => c.type === "text");
          if (textBlock && textBlock.text && !isInjectedTurn(textBlock.text)) {
            events.push({ seq: seq++, event: "user_message", data: { text: textBlock.text } });
          }
          const toolResults = (d.message.content || []).filter((c) => c.type === "tool_result");
          for (const tr of toolResults) {
            const output = typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content);
            const isError = Boolean(tr.is_error) || DENIED_RESULT_RE.test(output);
            const call = toolCalls.get(tr.tool_use_id);
            toolCalls.delete(tr.tool_use_id);
            events.push({
              seq: seq++,
              ...toolResult({
                id: tr.tool_use_id,
                // The result carries only the id, so the name comes from the call it
                // answers. Without it a replayed task row was never parsed: the client's
                // task reader is keyed on the tool name.
                name: call?.name || "",
                output,
                error: isError ? output : ""
              })
            });
            // Same rule as the live path: a rejected edit never reached the disk, so it
            // paints no diff — and the tool row stays, which is what says it was refused.
            if (call && !isError && DIFF_TOOL_SET.has(call.name)) {
              const diff = buildEditDiff(call.name, call.input);
              if (diff) events.push({ seq: seq++, event: "diff", data: diff });
            }
          }
        } else if (d.type === "attachment") {
          // What the harness put INTO the conversation: a hook's output, a prompt waiting
          // for its turn, a task reminder. The reader used to take only `environment` out
          // of these, so a reopened chat lost the context a hook had injected.
          //
          // Carried whole — EXCEPT an edited file's `snippet`, which is the entire file
          // re-read (8KB measured), not the change. It was dropped from the row and then
          // travelled anyway inside the raw record, so a file whose body happened to be a
          // `<persisted-output>` frame put that frame on screen. The filename is the fact;
          // the body belongs to the file, where the row's button already points.
          events.push({
            seq: seq++,
            event: "cli_event",
            data: { type: "attachment", subtype: d.attachment?.type || "", record: stripAttachmentBody(d) }
          });
        } else if (d.type === "system") {
          // The harness writes `system` records for things it wants a person to know —
          // `api_error` carries `level` and a formatted message, `stop_hook_summary` carries
          // a hook count and no text at all. Carried whole, under its own name, and the
          // pane decides: `noticeFrom` shows the ones with something to read. The reader
          // used to walk past every one of these, so reopening a chat lost the only record
          // that an API call had failed.
          events.push({
            seq: seq++,
            event: "cli_event",
            data: { type: "system", subtype: d.subtype || "", record: d }
          });
        } else if (d.type === "assistant" && d.message) {
          for (const item of d.message.content || []) {
            if (item.type === "thinking" && item.thinking) {
              events.push({ seq: seq++, event: "thinking", data: { text: item.thinking } });
            } else if (item.type === "tool_use") {
              // Held until its result arrives, the way the live adapter holds it: the
              // diff is built from this call's input, and the result carries only the id.
              toolCalls.set(item.id, { name: item.name, input: item.input });
              events.push({ seq: seq++, ...toolStart({ id: item.id, name: item.name, input: item.input }) });
            } else if (item.type === "text" && item.text) {
              events.push({ seq: seq++, event: "delta", data: { text: item.text } });
            }
          }
          events.push({ seq: seq++, event: "turn_complete", data: { stats: {} } });
        }
      } catch {}
    }

    return events.length > 0 ? events : null;
  } catch {
    return null;
  }
}

/**
 * The session STATE the harness stores beside the conversation.
 *
 * The transcript is not only messages: the TUI's harness also writes `permission-mode`,
 * `mode`, `ai-title` and `last-prompt` as their own records, and those are the same facts
 * 9Remote has been deriving for itself (the mode from a stream-json `init`, the title by
 * reading prose and truncating it, the last prompt kept in memory). Reading them here is
 * what makes the harness the authority instead of a parallel guess.
 *
 * The LAST record of each kind wins: the harness appends one every time the value moves,
 * and the file is in order — measured, `permission-mode` and `mode` sit at the very end of
 * a live session. Absent means absent: this returns null rather than blanks, because an
 * empty string would overwrite a value the live path already had.
 *
 * `cost-state` is deliberately NOT read. Measured on a real session: exactly ONE record,
 * written early, reporting `totalCostUSD: 0` while the session went on to spend real money.
 * The transcript is the authority on what a session IS, not on a running total.
 */
export function readClaudeSessionState(cwd, cliSessionId) {
  if (!cwd || !cliSessionId) return null;
  if (!CLAUDE_SESSION_ID_RE.test(cliSessionId)) return null;
  const file = findTranscript(cwd, cliSessionId);
  if (!file) return null;

  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return null; }

  const out = {};
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    // Cheap gate before the parse: most lines are messages, and JSON.parse on a whole
    // transcript is the expensive part of reading one.
    if (!line.includes('"permission-mode"') && !line.includes('"ai-title"') &&
        !line.includes('"last-prompt"') && !line.includes('"attachment"') &&
        !line.includes('"mode"')) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    switch (d.type) {
      case "permission-mode": if (d.permissionMode) out.permissionMode = d.permissionMode; break;
      case "mode": if (d.mode) out.mode = d.mode; break;
      case "ai-title": if (d.aiTitle) out.title = d.aiTitle; break;
      case "last-prompt": if (d.lastPrompt) out.lastPrompt = d.lastPrompt; break;
      // The harness's own statement of WHERE it ran: the cwd, whether that is a worktree,
      // and whether it is a git repo. 9Remote has been taking the cwd from the session it
      // created instead. Only `environment` carries this — the other attachment types in a
      // real session are `prompt_snapshot` and `task_reminder`, written every turn and
      // holding nothing about the session's own facts.
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

/**
 * Attachments the harness appended since `offset`, and where to resume from.
 *
 * The live door cannot see these: stream-json's records are assistant/user/system/
 * stream_event/result and nothing else (measured), while `attachment` lives only in the
 * transcript. Without this the pane showed a hook's injected context only after a reload —
 * the two doors disagreeing, which is the bug this whole line of work keeps hitting.
 *
 * Reading the whole file per turn is not an option: a real session is 7 MB and grows. The
 * transcript is append-only, so a BYTE OFFSET is the whole trick — read the tail, keep the
 * offset, and never look behind it.
 *
 * A trailing line with no newline is still being written, so the offset stops before it.
 * Returning it half-parsed would lose the record; returning the offset past it would lose
 * it for good.
 */
export function readNewAttachments(cwd, cliSessionId, offset = 0) {
  const nothing = { records: [], offset: offset || 0 };
  if (!cwd || !cliSessionId || !CLAUDE_SESSION_ID_RE.test(cliSessionId)) return nothing;
  const file = findTranscript(cwd, cliSessionId);
  if (!file) return nothing;

  let fd;
  try {
    const size = fs.statSync(file).size;
    // `Infinity` asks for the end of the file and nothing else — how a session seeds its
    // offset without replaying a conversation it has already drawn.
    if (offset === Infinity) return { records: [], offset: size };
    const from = Number.isFinite(offset) && offset > 0 ? offset : 0;
    // A file that shrank (a rewind rewrote it, or a new session took the id) invalidates
    // the offset — reading from a stale one would land mid-record and read garbage.
    if (from > size) return { records: [], offset: 0 };
    if (from === size) return { records: [], offset: from };

    fd = fs.openSync(file, "r");
    const length = size - from;
    const buf = Buffer.allocUnsafe(length);
    const read = fs.readSync(fd, buf, 0, length, from);
    const text = buf.subarray(0, read).toString("utf8");

    // Only whole lines are records; whatever follows the last newline is still being
    // written, and the offset has to stay before it.
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
    // Bytes, not characters: the offset indexes the file, and a multi-byte character in
    // the last line would put a character count short of the byte it must resume at.
    return { records, offset: from + Buffer.byteLength(complete, "utf8") + 1 };
  } catch {
    return nothing;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}
