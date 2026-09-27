// Tests reading Claude session state from harness transcript records.
// Run: cd web && node --import ./test/loader-alias.mjs ../agent/test/claudeSessionState.test.mjs
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
  assert.equal(readClaudeSessionState("/tmp", "ffffffff-0000-1111-2222-333333333333"), null);
});

await test("an id that is not id-shaped is refused", () => {
  assert.equal(readClaudeSessionState("/tmp", "../../etc/passwd"), null);
  assert.equal(readClaudeSessionState("/tmp", "-flag-shaped"), null);
  assert.equal(readClaudeSessionState("/tmp", ""), null);
});

await test("a cwd that has moved on is not a miss — the id is what identifies a transcript", () => {
  assert.deepEqual(readClaudeSessionState("/nowhere", ID).title, "Bàn về harness");
});

await test("a session with no transcript anywhere yields null rather than throwing", () => {
  assert.equal(readClaudeSessionState("/tmp", "99999999-9999-9999-9999-999999999999"), null);
  assert.equal(readClaudeSessionState(null, ID), null);
});

await test("cost-state is not read — the transcript is not the authority on a running total", () => {
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

await test("the mode filed on user records is read, and the last turn's wins", () => {
  const id7 = "88888888-9999-0000-1111-222222222222";
  fs.writeFileSync(path.join(dir, `${id7}.jsonl`), [
    JSON.stringify({ type: "user", permissionMode: "default", message: { content: [{ type: "text", text: "mở phiên" }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "nghe rồi" }] } }),
    JSON.stringify({ type: "user", permissionMode: "bypassPermissions", message: { content: [{ type: "text", text: "chuyển yolo" }] } })
  ].join("\n"));
  const st = readClaudeSessionState("/tmp", id7);
  assert.equal(st.permissionMode, "bypassPermissions", "the newest turn's mode is the session's");
});

await test("the harness's environment snapshot is read as the session's own facts", () => {
  const st = readClaudeSessionState("/tmp", ID3);
  assert.equal(st.cwd, "/Users/someone/repo");
  assert.equal(st.isWorktree, true);
  assert.equal(st.isGitRepo, true);
});

await test("a transcript with only prompt_snapshot attachments yields no environment facts", () => {
  const id4 = "44444444-5555-6666-7777-888888888888";
  fs.writeFileSync(path.join(dir, `${id4}.jsonl`), [
    JSON.stringify({ type: "attachment", attachment: { type: "prompt_snapshot", systemPrompt: ["x"] } }),
    JSON.stringify({ type: "permission-mode", permissionMode: "plan", sessionId: id4 })
  ].join("\n"));
  const st = readClaudeSessionState("/tmp", id4);
  assert.equal(st.cwd, undefined);
  assert.equal(st.permissionMode, "plan", "the other records still read");
});

await test("the harness's cwd is kept as a fact, not adopted as the session's working directory", async () => {
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
  const events = recoverFromClaudeTranscript("/tmp", ID3);
  const notices = events.filter((e) => e.event === "cli_event" && e.data.subtype === "api_error");
  assert.equal(notices.length, 1, "the failure is in the rebuilt log");
  assert.equal(notices[0].data.record.level, "error");
  assert.match(notices[0].data.record.error.formatted, /fetch failed/);
  assert.equal(notices[0].data.record.retryAttempt, 1, "the harness's own field name, as the transcript spells it");
});

await test("a system record with nothing to read is still carried, for the pane to ignore", () => {
  const events = recoverFromClaudeTranscript("/tmp", ID3);
  const hooks = events.filter((e) => e.data?.subtype === "stop_hook_summary");
  assert.equal(hooks.length, 1, "carried whole");
  assert.equal(hooks[0].data.record.hookCount, 2, "with the harness's own field names");
});

await test("the pane reads a carried system record exactly as it reads a live one", async () => {
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

await test("hook, queue and reminder attachments are carried, under their own names", () => {
  const events = recoverFromClaudeTranscript("/tmp", ID3);
  const of = (t) => events.filter((e) => e.data?.subtype === t);
  assert.equal(of("hook_success").length, 1);
  assert.equal(of("hook_success")[0].data.record.attachment.content, "injected context");
  assert.equal(of("queued_command").length, 1);
  assert.equal(of("task_reminder").length, 1, "carried too — whether it is readable is the pane's call");
  // A body the pane never draws is dropped on the way back — whole attachments evict
  // real turns from the replay window a reopened pane hydrates from.
  assert.equal(of("environment").length, 1, "the kind still travels");
  assert.equal(of("environment")[0].data.record.attachment.snapshot, undefined, "its snapshot does not");
});

await test("the pane reads a hook's injected context and a queued prompt as lines", async () => {
  const { noticeFrom } = await import("../../web/features/ai/lib/harnessTasks.js");
  const events = recoverFromClaudeTranscript("/tmp", ID3);
  const at = (t) => events.find((e) => e.data?.subtype === t).data;

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

await test("new attachments are read from where the last read stopped", async () => {
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

  const again = readNewAttachments("/tmp", id5, first.offset);
  assert.deepEqual(again.records, [], "a second read at the same offset finds nothing");

  fs.appendFileSync(file, JSON.stringify({ type: "attachment", attachment: { type: "hook_success", hookName: "B", content: "second" } }) + "\n");
  const third = readNewAttachments("/tmp", id5, again.offset);
  assert.equal(third.records.length, 1, "only what was appended");
  assert.equal(third.records[0].attachment.content, "second");
});

await test("a read that lands mid-line does not lose or duplicate the record", async () => {
  const { readNewAttachments } = await import("../features/ai/claudeTranscript.js");
  const id6 = "66666666-7777-8888-9999-000000000000";
  const file = path.join(dir, `${id6}.jsonl`);
  const line = JSON.stringify({ type: "attachment", attachment: { type: "hook_success", content: "half" } });
  fs.writeFileSync(file, line);

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
  const events = recoverFromClaudeTranscript("/tmp", ID3);
  const rows = events.filter((e) => e.data?.subtype === "edited_text_file");
  assert.equal(rows.length, 2, "both edited files reach the pane");
  assert.equal(rows[0].data.record.attachment.filename, "/w/edited/by/bash.sh");
});

await test("an edited-file record draws no row of its own", async () => {
  const { noticeFrom } = await import("../../web/features/ai/lib/harnessTasks.js");
  const events = recoverFromClaudeTranscript("/tmp", ID3);
  const row = events.find((e) => e.data?.subtype === "edited_text_file").data;
  assert.equal(noticeFrom(row.type, row.record.attachment), null, "nothing to draw");
});

await test("an edited-file row never carries the file body as its text", () => {
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
