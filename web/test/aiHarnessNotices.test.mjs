// The lines the harness itself asks the timeline to draw.
//
// The pane does not decide which records are worth showing — the harness does. A record
// it gives `content` (or a formatted `error`) is one it means a person to read:
// `local_command`, `compact_boundary`, `informational`, `away_summary`, the errors.
// Records it writes for bookkeeping (`turn_duration`, `stop_hook_summary`) carry neither
// and get no row. Measured on 934 real transcripts on this machine.
//
// Run: cd web && node --import ./test/loader-alias.mjs test/aiHarnessNotices.test.mjs
import assert from "node:assert/strict";
import { reduceSessionEvents } from "../features/ai/hooks/useAiSession.js";
import { buildTurnRows, splitTurnBlocks } from "../features/ai/lib/turnRows.js";
import { noticeFrom } from "../features/ai/lib/harnessTasks.js";
import { useAiStore } from "../shared/stores/aiStore.js";

let pass = 0, fail = 0;
const test = (n, f) => {
  try { f(); pass++; console.log(`  ok  ${n}`); }
  catch (e) { fail++; console.error(`  FAIL ${n}\n       ${e.message}`); }
};

const rec = (subtype, extra) => ({
  seq: 1, event: "cli_event",
  data: { type: "system", subtype, record: { type: "system", subtype, ...extra } }
});
const notices = (out) => out.messages.filter((m) => m.role === "notice");

test("a record the harness gave content becomes a line in the timeline", () => {
  const out = reduceSessionEvents([rec("local_command", { content: "<command-name>/resume</command-name>", level: "info" })], "claude");
  assert.equal(notices(out).length, 1, "the harness wrote something readable; the pane shows it");
  assert.equal(notices(out)[0].level, "info");
  assert.match(notices(out)[0].content, /resume/);
});

test("an error record shows the message the harness formatted", () => {
  // `api_error` carries no `content` — its text is `error.formatted`.
  const out = reduceSessionEvents([rec("api_error", { level: "error", error: { formatted: "Connection dropped (ECONNRESET)" } })], "claude");
  assert.equal(notices(out).length, 1);
  assert.equal(notices(out)[0].level, "error");
  assert.match(notices(out)[0].content, /ECONNRESET/);
});

test("an error with only a message still shows", () => {
  const out = reduceSessionEvents([rec("api_error", { level: "error", error: { message: "Connection error." } })], "claude");
  assert.equal(notices(out).length, 1);
  assert.match(notices(out)[0].content, /Connection error/);
});

test("a record with nothing to show adds no row", () => {
  // `turn_duration` and `stop_hook_summary` are bookkeeping: the harness gives them no
  // text, which is the harness saying "this is not for a person to read".
  for (const subtype of ["turn_duration", "stop_hook_summary"]) {
    const out = reduceSessionEvents([rec(subtype, { durationMs: 27390, hookCount: 2 })], "claude");
    assert.equal(notices(out).length, 0, `${subtype} must not open a row`);
  }
});

test("a notice lands where it happened, not hoisted to an end", () => {
  const out = reduceSessionEvents([
    { seq: 1, event: "user_message", data: { text: "hi" } },
    rec("compact_boundary", { content: "Conversation compacted", level: "info" }),
    { seq: 3, event: "delta", data: { text: "answer" } }
  ], "claude");
  const roles = out.messages.map((m) => m.role);
  // Between the prompt and the answer that followed. The earlier version of this test
  // expected an assistant placeholder here too — but that placeholder is empty until the
  // answer starts, and drawing it put a bare bubble ahead of the notice.
  assert.deepEqual(roles, ["user", "notice", "assistant"]);
});

test("the harness's own level is passed through, not remapped", () => {
  const warn = reduceSessionEvents([rec("informational", { content: "Unknown command: /moo.", level: "warning" })], "claude");
  assert.equal(notices(warn)[0].level, "warning", "the CLI's word, so the row styles as it would there");
});

test("a level the record omits defaults to info, not to an error", () => {
  const out = reduceSessionEvents([rec("away_summary", { content: "Bạn muốn đăng ký Shopee…" })], "claude");
  assert.equal(notices(out)[0].level, "info");
});

test("a notice is not mistaken for a prompt or an answer", () => {
  const out = reduceSessionEvents([rec("informational", { content: "note" })], "claude");
  assert.equal(out.messages.filter((m) => m.role === "user").length, 0);
  assert.equal(out.messages.filter((m) => m.role === "assistant").length, 0);
  assert.equal(out.messages.length, 1);
});

test("a non-system record never becomes a notice", () => {
  const out = reduceSessionEvents([
    { seq: 1, event: "cli_event", data: { type: "tool_progress", subtype: "", record: { content: "not a system row" } } }
  ], "claude");
  assert.equal(notices(out).length, 0);
});

// ── and the pane paints it ──

test("a notice becomes a row of its own, in arrival order", () => {
  const rows = buildTurnRows([
    { id: "a1", role: "assistant", content: "before" },
    { id: "n1", role: "notice", subtype: "compact_boundary", level: "info", content: "Conversation compacted" },
    { id: "a2", role: "assistant", content: "after" }
  ], "claude");
  assert.deepEqual(rows.map((r) => r.kind), ["prose", "notice", "prose"]);
  assert.equal(rows[1].notice.content, "Conversation compacted");
  assert.equal(rows[1].notice.level, "info");
});

test("a notice is never hidden behind the N-more bar", () => {
  // The bar is for STEP runs (tool calls, thoughts). A notice is not a step: it is the
  // harness telling the reader something, and burying it under a bar defeats that.
  const rows = [
    { kind: "notice", id: "n1", notice: { subtype: "compact_boundary", level: "info", content: "x" } },
    ...Array.from({ length: 8 }, (_, i) => ({ kind: "tool", id: `t${i}`, tool: { id: `t${i}`, name: "Bash" }, engine: "claude" }))
  ];
  const blocks = splitTurnBlocks(rows, 6);
  const noticeBlock = blocks.find((b) => b.row?.kind === "notice");
  assert.ok(noticeBlock, "the notice is its own block, outside the steps run");
  assert.equal(noticeBlock.type, "row");
});

// ── the live door lands the same row the replay does ──

test("a notice that arrives live reaches the store, like one that was replayed", () => {
  // The live path and the replay path must land the same row. A notice that only appeared
  // after a reload — or only before one — is the same drift the task list already had.
  useAiStore.getState().initSession("live-notice");
  useAiStore.getState().addNotice("live-notice", { subtype: "compact_boundary", level: "info", content: "Conversation compacted" });
  const msgs = useAiStore.getState().bySession["live-notice"].messages;
  assert.equal(msgs.filter((m) => m.role === "notice").length, 1);
  assert.equal(msgs[0].content, "Conversation compacted");
  assert.equal(msgs[0].level, "info");
});

test("an empty notice is refused by the store too", () => {
  useAiStore.getState().initSession("live-empty");
  useAiStore.getState().addNotice("live-empty", { level: "info", content: "   " });
  useAiStore.getState().addNotice("live-empty", null);
  assert.equal(useAiStore.getState().bySession["live-empty"].messages.length, 0);
});

test("a notice between the prompt and the answer leaves no empty turn behind", () => {
  // `user_message` opens an assistant placeholder for the answer to stream into. A notice
  // landing before that answer used to sit AFTER the empty placeholder, so the pane drew
  // a bare turn (a bubble with nothing in it) and then the notice.
  const out = reduceSessionEvents([
    { seq: 1, event: "user_message", data: { text: "hi" } },
    rec("compact_boundary", { content: "compacted", level: "info" }),
    { seq: 3, event: "delta", data: { text: "answer" } }
  ], "claude");
  const empty = out.messages.filter((m) => m.role === "assistant" && !m.content && !m.thinking && !(m.tools || []).length);
  assert.equal(empty.length, 0, "no orphaned placeholder");
  assert.deepEqual(out.messages.map((m) => m.role), ["user", "notice", "assistant"]);
});

test("a notice after the answer started drops nothing", () => {
  // The guard is only for an EMPTY placeholder. Once the answer is streaming, the notice
  // must sit after it and the segment must survive.
  const out = reduceSessionEvents([
    { seq: 1, event: "user_message", data: { text: "hi" } },
    { seq: 2, event: "delta", data: { text: "partial answer" } },
    rec("informational", { content: "a note", level: "info" })
  ], "claude");
  assert.deepEqual(out.messages.map((m) => m.role), ["user", "assistant", "notice"]);
  assert.equal(out.messages[1].content, "partial answer", "the streamed segment survives");
});

test("a notice after a tool call drops nothing either", () => {
  const out = reduceSessionEvents([
    { seq: 1, event: "user_message", data: { text: "hi" } },
    { seq: 2, event: "tool_start", data: { id: "t1", name: "Bash", input: {} } },
    rec("informational", { content: "a note", level: "info" })
  ], "claude");
  assert.equal(out.messages.filter((m) => m.role === "assistant").length, 1, "the tool row keeps its segment");
  assert.equal(out.messages.filter((m) => m.role === "notice").length, 1);
});

test("the live store drops the empty placeholder too", () => {
  // Same rule as the replay door. One door dropping it and the other not is the drift
  // that makes a bug appear only after a reload.
  useAiStore.getState().initSession("live-orph");
  useAiStore.getState().addUserMessage("live-orph", "hi");
  useAiStore.getState().addNotice("live-orph", { level: "info", content: "compacted" });
  const roles = useAiStore.getState().bySession["live-orph"].messages.map((m) => m.role);
  assert.deepEqual(roles, ["user", "notice"]);
});

test("the live store keeps a segment that already has content", () => {
  useAiStore.getState().initSession("live-keep");
  useAiStore.getState().addUserMessage("live-keep", "hi");
  useAiStore.getState().appendDelta("live-keep", "partial");
  useAiStore.getState().addNotice("live-keep", { level: "info", content: "note" });
  const msgs = useAiStore.getState().bySession["live-keep"].messages;
  assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant", "notice"]);
  assert.equal(msgs[1].content, "partial");
});

test("an edited-file row keeps its filename all the way to the pane", () => {
  // The row is a door to the file, so the filename has to survive both hops — the store's
  // addNotice and the turn's row builder. It did not: both copied subtype/level/content and
  // dropped the rest, so the button would have opened nothing.
  useAiStore.getState().initSession("live-file");
  useAiStore.getState().addNotice("live-file", {
    subtype: "edited_text_file", level: "info", content: "/w/x.sh", file: "/w/x.sh"
  });
  const msgs = useAiStore.getState().bySession["live-file"].messages;
  assert.equal(msgs[0].file, "/w/x.sh", "the store keeps it");

  const rows = buildTurnRows(msgs, "claude");
  assert.equal(rows[0].notice.file, "/w/x.sh", "and the row builder does too");
});

test("a notice with no file stays a plain line", () => {
  const rows = buildTurnRows([{ id: "n1", role: "notice", level: "info", content: "just a note" }], "claude");
  assert.equal(rows[0].notice.file, undefined, "no button where there is nothing to open");
});

// ── harness bookkeeping must never be drawn as a line ──

test("a task notification's own frame is never shown", () => {
  // Reported from real use: the chat drew the whole `<task-notification>…</task-notification>`
  // block as a notice. That text is the harness reporting a task to ITSELF — the CLI's own
  // tool result says "never quote or paste any part of it" — and carrying attachments
  // without filtering it is how it reached the screen.
  const inner = [
    "<task-notification>",
    "<task-id>wrfbfmlsr</task-id>",
    "<tool-use-id>call_46vvs394</tool-use-id>",
    "<status>completed</status>",
    "<summary>Demo workflow</summary>",
    "</task-notification>"
  ].join("\n");

  const queued = noticeFrom("attachment", { type: "queued_command", prompt: inner });
  assert.equal(queued, null, "a queued task-notification is not a line a person reads");

  const hook = noticeFrom("attachment", { type: "hook_success", content: inner });
  assert.equal(hook, null, "and neither is a hook that carried one");
});

test("a real queued prompt still shows", () => {
  // The filter must not throw away the thing the row exists for.
  const n = noticeFrom("attachment", { type: "queued_command", prompt: "chạy test giúp tôi" });
  assert.ok(n);
  assert.equal(n.content, "chạy test giúp tôi");
});

test("a hook whose output is real context still shows — at SessionStart", () => {
  // SessionStart is the one hook whose output the TUI draws. A per-prompt hook carrying the
  // same text is model input, not a line (see the hookEvent test above).
  const n = noticeFrom("attachment", { type: "hook_success", hookEvent: "SessionStart", content: "codegraph: 12 symbols matched" });
  assert.ok(n);
  assert.match(n.content, /codegraph/);
});

test("a harness frame is filtered on the system door too", () => {
  // The same frame can arrive as a `system` record's `content`, not only as an attachment —
  // filtering one door and not the other is how it reached the screen anyway.
  const inner = "<task-notification>\n<task-id>x</task-id>\n</task-notification>";
  assert.equal(noticeFrom("system", { content: inner }), null);
  assert.ok(noticeFrom("system", { content: "Conversation compacted", level: "info" }), "real text still shows");
});

test("a hook's output shows only where the TUI shows it — SessionStart", () => {
  // Reported from real use: the chat drew a codegraph hook's whole `<persisted-output>`
  // block. The TUI draws hook output in exactly one place, and the binary says which:
  //   if (hookEvent !== "SessionStart") return [];
  // Every other hook (UserPromptSubmit, PostToolUse, …) feeds the MODEL, not the screen.
  const persisted = "<persisted-output>\nOutput too large (15.8KB). Full output saved to: /tmp/x.txt\n</persisted-output>";

  const userHook = noticeFrom("attachment", { type: "hook_success", hookEvent: "UserPromptSubmit", content: persisted });
  assert.equal(userHook, null, "a per-prompt hook is not a line a person reads");

  const postTool = noticeFrom("attachment", { type: "hook_success", hookEvent: "PostToolUse", content: "formatted main.js" });
  assert.equal(postTool, null, "nor is a post-tool one");

  const start = noticeFrom("attachment", { type: "hook_success", hookEvent: "SessionStart", content: "project loaded" });
  assert.ok(start, "SessionStart IS shown — that is the one place the TUI draws hook output");
  assert.equal(start.content, "project loaded");
});

test("a hook output that names a saved file says so, not the whole dump", () => {
  // The TUI does this too (its `ogt`): a persisted-output frame becomes the path it saved
  // to. Drawing the frame itself is what put 15KB of XML on the screen.
  const saved = "<persisted-output>\nOutput too large. Full output saved to: /tmp/tool-results/abc.txt\nPreview: <junk>…\n</persisted-output>";
  const n = noticeFrom("attachment", { type: "hook_success", hookEvent: "SessionStart", content: saved });
  assert.ok(n);
  assert.match(n.content, /saved to: \/tmp\/tool-results\/abc\.txt/);
  assert.doesNotMatch(n.content, /<persisted-output>/, "the frame is gone");
  assert.doesNotMatch(n.content, /Preview/, "and so is the preview dump");
});

test("a hook with no hookEvent at all shows nothing", () => {
  // The TUI's first test is `!("hookEvent" in n)` — a hook that cannot say when it ran is
  // not one it can place.
  assert.equal(noticeFrom("attachment", { type: "hook_success", content: "something" }), null);
});

test("a persisted-output frame never reaches a queued prompt's row either", () => {
  // The `<persisted-output>` frame is the other one the harness writes to talk to itself:
  // 15KB saying the real output went to a file. It leaked through `queued_command`, which
  // has no hookEvent to gate on — the frame test is what stops it.
  const txt = "<persisted-output>\nOutput too large. Full output saved to: /tmp/a.txt\nPreview: junk\n</persisted-output>";
  assert.equal(noticeFrom("attachment", { type: "queued_command", prompt: txt }), null);
  // A real prompt still shows.
  assert.equal(noticeFrom("attachment", { type: "queued_command", prompt: "chạy test giúp tôi" }).content, "chạy test giúp tôi");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
