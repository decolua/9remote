// The session STATE the harness stores beside the conversation.
//
// The transcript is not only messages. The TUI's harness also writes `permission-mode`,
// `mode`, `ai-title` and `last-prompt` as their own records — the same facts 9Remote has
// been deriving for itself: a mode inferred from a stream-json `init`, a title cut from
// prose, the last prompt held in memory. Reading them is what makes the harness the
// authority instead of a parallel guess, which is the whole point of this work.
//
// Measured on a real session (7.7 MB, 3341 records): these records sit at the very END of
// live file — the harness appends one each time the value moves, so the LAST one wins.
//
// `cost-state` is deliberately NOT read, and there is a test for that below.
//
// Run: cd web && node --import ./test/loader-alias.mjs ../agent/test/claudeSessionState.test.mjs
//
// FROM web/, not from the repo root: three of these cases read `noticeFrom` out of
// web/features/ai/lib, and that module's own imports are extensionless (the project
// convention, resolved by the webpack bundler). Node needs the alias loader to follow
// them — running this file with a bare `node` reported three failures that were really
// "Cannot find module ./liveStatus", not anything about the session state under test.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "state-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

const ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const dir = path.join(home, ".claude", "projects", "-tmp-p");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, `${ID}.jsonl`), [
  JSON.stringify({ type: "permission-mode", permissionMode: "plan", sessionId: ID }),
  JSON.stringify({ type: "mode", mode: "normal", sessionId: ID }),
  JSON.stringify({ type: "ai-title", aiTitle: "Bàn về harness", sessionId: ID }),
  JSON.stringify({ type: "last-prompt", lastPrompt: "câu hỏi đầu", sessionId: ID }),
  JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "xin chào" }] } }),
  JSON.stringify({ type: "permission-mode", permissionMode: "bypassPermissions", sessionId: ID }),
  JSON.stringify({ type: "last-prompt", lastPrompt: "câu hỏi cuối", sessionId: ID }),
  JSON.stringify({ type: "cost-state", totalCostUSD: 0, sessionId: ID })
].join("\n"));

// A second session carries the harness's environment snapshot.
const ID3 = "33333333-4444-5555-6666-777777777777";
fs.writeFileSync(path.join(dir, `${ID3}.jsonl`), [
  JSON.stringify({
    type: "attachment",
    attachment: {
      type: "environment",
      snapshot: {
        workingDirectory: "/Users/someone/repo", isWorktree: true,
        isGitRepo: true, platform: "darwin", additionalWorkingDirectories: ["/tmp/extra"]
      }
    }
  }),
  JSON.stringify({ type: "attachment", attachment: { type: "hook_success", hookName: "UserPromptSubmit", content: "injected context" } }),
  JSON.stringify({ type: "attachment", attachment: { type: "edited_text_file", filename: "/w/edited/by/bash.sh", snippet: "1\t#!/bin/sh\n2\techo hi" } }),
  JSON.stringify({
    type: "attachment",
    attachment: { type: "edited_text_file", filename: "/w/reads-this-file.sh", snippet: "<persisted-output>\nOutput too large. Full output saved to: /tmp/big.txt\n</persisted-output>" }
  }),
  JSON.stringify({ type: "attachment", attachment: { type: "queued_command", prompt: "a prompt waiting its turn", commandMode: "normal" } }),
  JSON.stringify({ type: "attachment", attachment: { type: "task_reminder", content: [], itemCount: 0 } }),
  JSON.stringify({
    type: "system", subtype: "api_error", level: "error",
    error: { message: "503 fetch failed", status: 503, formatted: "503 [model] fetch failed (timeout)" },
    retryAttempt: 1, maxRetries: 5
  }),
  JSON.stringify({ type: "system", subtype: "stop_hook_summary", hookCount: 2, hookInfos: [] }),
  JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "hi" }] } })
].join("\n"));

const { readClaudeSessionState, recoverFromClaudeTranscript } = await import("../features/ai/claudeTranscript.js");

let pass = 0, fail = 0;
const test = (name, fn) => {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });
};

console.log("Running harness session-state tests...");

await test("the LAST record of each kind wins, not the first", () => {
  const st = readClaudeSessionState("/tmp", ID);
  assert.equal(st.permissionMode, "bypassPermissions", "the harness moved the mode mid-session");
  assert.equal(st.lastPrompt, "câu hỏi cuối");
});

await test("the title the harness wrote is read as-is", () => {
  assert.equal(readClaudeSessionState("/tmp", ID).title, "Bàn về harness");
});

await test("a session with no state records yields null, not blanks that would overwrite", () => {
  // Null, not `{}` and not empty strings: the caller overrides live values with these, and
  // an empty string would wipe a mode the session is actually running with.
  assert.equal(readClaudeSessionState("/tmp", "ffffffff-0000-1111-2222-333333333333"), null);
});

await test("an id that is not id-shaped is refused", () => {
  assert.equal(readClaudeSessionState("/tmp", "../../etc/passwd"), null);
  assert.equal(readClaudeSessionState("/tmp", "-flag-shaped"), null);
  assert.equal(readClaudeSessionState("/tmp", ""), null);
});

await test("a cwd that has moved on is not a miss — the id is what identifies a transcript", () => {
  // `findTranscript` scans the projects dir by id, because the CLI writes a transcript
  // under the directory it STARTED in and the terminal may have `cd`'d away since. So a
  // cwd that never existed still resolves — that is the design, not a hole.
  assert.deepEqual(readClaudeSessionState("/nowhere", ID).title, "Bàn về harness");
});

await test("a session with no transcript anywhere yields null rather than throwing", () => {
  assert.equal(readClaudeSessionState("/tmp", "99999999-9999-9999-9999-999999999999"), null);
  assert.equal(readClaudeSessionState(null, ID), null);
});

await test("cost-state is not read — the transcript is not the authority on a running total", () => {
  // Measured: exactly ONE cost-state record in a live session, written early, reporting
  // totalCostUSD 0 while the session went on to spend real money. Reading it would show a
  // stale zero over the adapter's own live counting.
  const st = readClaudeSessionState("/tmp", ID);
  assert.equal(st.cost, undefined);
  assert.equal(st.totalCostUSD, undefined);
});

await test("a transcript that is only conversation yields null", () => {
  const id2 = "11111111-2222-3333-4444-555555555555";
  fs.writeFileSync(path.join(dir, `${id2}.jsonl`), [
    JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "hi" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hello" }] } })
  ].join("\n"));
  assert.equal(readClaudeSessionState("/tmp", id2), null);
});

await test("the harness's environment snapshot is read as the session's own facts", () => {
  // `attachment`/`environment` is where the harness states the cwd it ran in, whether that
  // is a worktree, and whether it is a git repo. 9Remote has been taking the cwd from the
  // session it created — this is the harness's own word for it.
  const st = readClaudeSessionState("/tmp", ID3);
  assert.equal(st.cwd, "/Users/someone/repo");
  assert.equal(st.isWorktree, true);
  assert.equal(st.isGitRepo, true);
});

await test("a transcript with only prompt_snapshot attachments yields no environment facts", () => {
  // 275 attachment records in a real session, and most are `prompt_snapshot` — the system
  // prompt, written again every turn. Not environment, and not something to read.
  const id4 = "44444444-5555-6666-7777-888888888888";
  fs.writeFileSync(path.join(dir, `${id4}.jsonl`), [
    JSON.stringify({ type: "attachment", attachment: { type: "prompt_snapshot", systemPrompt: ["x"] } }),
    JSON.stringify({ type: "permission-mode", permissionMode: "plan", sessionId: id4 })
  ].join("\n"));
  const st = readClaudeSessionState("/tmp", id4);
  assert.equal(st.cwd, undefined);
  assert.equal(st.permissionMode, "plan", "the other records still read");
});

// ── and the session must not RUN on what the harness reported ──

await test("the harness's cwd is kept as a fact, not adopted as the session's working directory", async () => {
  // The transcript records the directory the CLI STARTED in. A session's `cwd` is where
  // its next process will run — adopting the recorded one would send a later spawn
  // somewhere the user never chose, and a resumed conversation that `cd`'d away would
  // silently move with it.
  const { AiSession } = await import("../features/ai/aiSession.js");
  const chosen = "/Users/Working/9remote";
  const s = new AiSession({
    id: `state-${Date.now()}`, engine: "claude", cwd: chosen,
    options: { mock: true, cliSessionId: ID3 }
  });
  assert.equal(s.cwd, chosen, "the session runs where it was told to");
  assert.equal(s.harnessCwd, "/Users/someone/repo", "and the harness's word is kept beside it");
});

await test("a system record the harness marked readable survives the replay", () => {
  // `api_error` is the harness writing a failure down for a person to read: it carries
  // `level: "error"` and a formatted message. The reader used to walk past every `system`
  // record, so reopening a chat lost the only record that an API call failed.
  const events = recoverFromClaudeTranscript("/tmp", ID3);
  const notices = events.filter((e) => e.event === "cli_event" && e.data.subtype === "api_error");
  assert.equal(notices.length, 1, "the failure is in the rebuilt log");
  assert.equal(notices[0].data.record.level, "error");
  assert.match(notices[0].data.record.error.formatted, /fetch failed/);
  assert.equal(notices[0].data.record.retryAttempt, 1, "the harness's own field name, as the transcript spells it");
});

await test("a system record with nothing to read is still carried, for the pane to ignore", () => {
  // The agent does NOT decide which records a person reads — it carries them and the pane
  // decides (`noticeFrom` in web/features/ai/lib/harnessTasks.js). Filtering here would be
  // a second copy of that rule, and two copies is how they drift.
  const events = recoverFromClaudeTranscript("/tmp", ID3);
  const hooks = events.filter((e) => e.data?.subtype === "stop_hook_summary");
  assert.equal(hooks.length, 1, "carried whole");
  assert.equal(hooks[0].data.record.hookCount, 2, "with the harness's own field names");
});

await test("the pane reads a carried system record exactly as it reads a live one", async () => {
  // One reader for both doors: the same `noticeFrom` decides a replayed `api_error` is a
  // line and a replayed `stop_hook_summary` is not.
  const { noticeFrom } = await import("../../web/features/ai/lib/harnessTasks.js");
  const events = recoverFromClaudeTranscript("/tmp", ID3);

  const err = events.find((e) => e.data?.subtype === "api_error");
  const n = noticeFrom(err.data.type, err.data.record);
  assert.ok(n, "an API failure the harness marked readable is a line");
  assert.equal(n.level, "error");
  assert.match(n.content, /fetch failed/);

  const hook = events.find((e) => e.data?.subtype === "stop_hook_summary");
  assert.equal(noticeFrom(hook.data.type, hook.data.record), null, "a hook count is not a line");
});

// ── the attachment kinds a person reads ──

await test("hook, queue and reminder attachments are carried, under their own names", () => {
  // `attachment` is how the harness records what it put INTO the conversation: a hook's
  // output, a prompt waiting for its turn. The reader used to take only `environment` out
  // of these, so a reopened chat lost the context a hook had injected.
  const events = recoverFromClaudeTranscript("/tmp", ID3);
  const of = (t) => events.filter((e) => e.data?.subtype === t);
  assert.equal(of("hook_success").length, 1);
  assert.equal(of("hook_success")[0].data.record.attachment.content, "injected context");
  assert.equal(of("queued_command").length, 1);
  assert.equal(of("task_reminder").length, 1, "carried too — whether it is readable is the pane's call");
});

await test("the pane reads a hook's injected context and a queued prompt as lines", async () => {
  const { noticeFrom } = await import("../../web/features/ai/lib/harnessTasks.js");
  const events = recoverFromClaudeTranscript("/tmp", ID3);
  const at = (t) => events.find((e) => e.data?.subtype === t).data;

  // A hook's output reaches the screen only at SessionStart — the TUI's own rule, read from
  // its code: `if (hookEvent !== "SessionStart") return []`. The fixture carries
  // `UserPromptSubmit`, so this row is model input and rightly shows nothing.
  const hook = at("hook_success");
  assert.equal(noticeFrom(hook.type, hook.record.attachment), null, "a per-prompt hook is not a line");
  assert.match(
    noticeFrom(hook.type, { ...hook.record.attachment, hookEvent: "SessionStart" }).content,
    /injected context/,
    "the same output at SessionStart IS a line"
  );

  const queued = at("queued_command");
  assert.match(noticeFrom(queued.type, queued.record.attachment).content, /waiting its turn/);

  const reminder = at("task_reminder");
  assert.equal(noticeFrom(reminder.type, reminder.record.attachment), null, "an empty reminder is bookkeeping");
});

// ── attachments reach the LIVE door too, without re-reading the whole file ──

await test("new attachments are read from where the last read stopped", async () => {
  // The live door cannot see an `attachment`: stream-json does not emit them (measured —
  // its records are assistant/user/system/stream_event/result, nothing else). They exist
  // only in the transcript. Reading the whole 7MB file every turn would be absurd, and the
  // transcript is append-only, so a byte offset is the whole trick: read from where the
  // last read stopped and take only what is new.
  const { readNewAttachments } = await import("../features/ai/claudeTranscript.js");
  const id5 = "55555555-6666-7777-8888-999999999999";
  const file = path.join(dir, `${id5}.jsonl`);

  fs.writeFileSync(file, [
    JSON.stringify({ type: "attachment", attachment: { type: "hook_success", hookName: "A", content: "first" } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "hi" }] } })
  ].join("\n") + "\n");

  const first = readNewAttachments("/tmp", id5, 0);
  assert.equal(first.records.length, 1, "the first read takes what is there");
  assert.equal(first.records[0].attachment.content, "first");
  assert.ok(first.offset > 0, "and reports where it stopped");

  // Nothing new: the same offset must yield nothing, not the same record again.
  const again = readNewAttachments("/tmp", id5, first.offset);
  assert.deepEqual(again.records, [], "a second read at the same offset finds nothing");

  // The CLI appends; only the new line comes back.
  fs.appendFileSync(file, JSON.stringify({ type: "attachment", attachment: { type: "hook_success", hookName: "B", content: "second" } }) + "\n");
  const third = readNewAttachments("/tmp", id5, again.offset);
  assert.equal(third.records.length, 1, "only what was appended");
  assert.equal(third.records[0].attachment.content, "second");
});

await test("a read that lands mid-line does not lose or duplicate the record", async () => {
  // The CLI writes a file in whole lines, but a read can still land between the write and
  // the newline. The offset must stay before an incomplete line so the next read sees it
  // whole — a record half-parsed is a record lost.
  const { readNewAttachments } = await import("../features/ai/claudeTranscript.js");
  const id6 = "66666666-7777-8888-9999-000000000000";
  const file = path.join(dir, `${id6}.jsonl`);
  const line = JSON.stringify({ type: "attachment", attachment: { type: "hook_success", content: "half" } });
  fs.writeFileSync(file, line);  // no trailing newline: the line is still being written

  const r = readNewAttachments("/tmp", id6, 0);
  assert.deepEqual(r.records, [], "an unterminated line is not a record yet");
  assert.equal(r.offset, 0, "and the offset stays before it");

  fs.appendFileSync(file, "\n");
  const r2 = readNewAttachments("/tmp", id6, r.offset);
  assert.equal(r2.records.length, 1, "once terminated, it is read whole");
});

await test("no transcript yet is not an error", async () => {
  const { readNewAttachments } = await import("../features/ai/claudeTranscript.js");
  const r = readNewAttachments("/tmp", "77777777-8888-9999-0000-111111111111", 0);
  assert.deepEqual(r.records, []);
  assert.equal(r.offset, 0);
});

await test("an edit the harness saw is carried even when no Edit tool made it", () => {
  // `edited_text_file` is the harness recording a file it watched change — by ANY route,
  // including a shell command. 9Remote's diff card only covers Edit/Write/MultiEdit, so an
  // edit made through Bash was invisible to the pane while the harness had it. Measured on
  // a real session: 16 files the harness saw, 1 of them no tool call covered.
  const events = recoverFromClaudeTranscript("/tmp", ID3);
  const rows = events.filter((e) => e.data?.subtype === "edited_text_file");
  assert.equal(rows.length, 2, "both edited files reach the pane");
  assert.equal(rows[0].data.record.attachment.filename, "/w/edited/by/bash.sh");
});

await test("an edited-file record draws no row of its own", async () => {
  // The record still travels — the task model and the store read other attachments, and a
  // reader that dropped this one would have to know which. It is the ROW that is gone: the
  // harness writes one for `Edit`/`Write` too, so the row mostly repeated a diff card
  // already on screen, and the file's name is on the row beside it either way.
  const { noticeFrom } = await import("../../web/features/ai/lib/harnessTasks.js");
  const events = recoverFromClaudeTranscript("/tmp", ID3);
  const row = events.find((e) => e.data?.subtype === "edited_text_file").data;
  assert.equal(noticeFrom(row.type, row.record.attachment), null, "nothing to draw");
});

await test("an edited-file row never carries the file body as its text", () => {
  // `edited_text_file.snippet` is the WHOLE file re-read — 8KB measured — not the change.
  // The reader takes the filename and drops the snippet, but the record also travels as a
  // `rendered` block (the shape a replayed card draws from), and that one still held the
  // body: a file whose content happened to be a `<persisted-output>` frame put the frame
  // itself on screen.
  const events = recoverFromClaudeTranscript("/tmp", ID3);
  const rows = events.filter((e) => e.data?.subtype === "edited_text_file");
  assert.equal(rows.length, 2, "both edited files arrive");

  for (const r of rows) {
    const a = r.data.record.attachment;
    assert.ok(a.filename, "the file is named");
    assert.equal(a.snippet, undefined, "and its body is not carried at all");
  }
});

if (fail > 0) {
  console.error(`\nTests failed: ${fail}/${pass + fail}`);
  process.exit(1);
}
console.log(`\nAll tests passed: ${pass}/${pass}`);
