// Tests harness timeline notices rendering.
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

test("the LIVE compact_boundary frame draws a row even though it has no content", () => {
  const out = reduceSessionEvents([rec("compact_boundary", {
    compact_metadata: { trigger: "manual", pre_tokens: 40053, post_tokens: 2452, cumulative_dropped_tokens: 37601, duration_ms: 22885 }
  })], "claude");
  const row = notices(out)[0];
  assert.ok(row, "the live frame must draw a row");
  assert.equal(row.content, "Compacted");
  assert.equal(row.compact.trigger, "manual");
  assert.equal(row.compact.preTokens, 40053);
  assert.equal(row.compact.postTokens, 2452);
  assert.equal(row.compact.durationMs, 22885);
  assert.match(row.compact.detail, /40.1k → 2.5k tokens/);
});

test("the REPLAY copy of the same record keeps the harness's own sentence", () => {
  const out = reduceSessionEvents([rec("compact_boundary", {
    content: "Conversation compacted", level: "info",
    compactMetadata: { trigger: "auto", preTokens: 557511, postTokens: 20680, durationMs: 51369 }
  })], "claude");
  const row = notices(out)[0];
  assert.equal(row.content, "Conversation compacted");
  assert.equal(row.compact.trigger, "auto");
  assert.equal(row.compact.preTokens, 557511);
  assert.match(row.compact.detail, /558k → 20.7k tokens/);
});

test("a metadata-only record with no counts invents nothing", () => {
  const out = reduceSessionEvents([rec("compact_boundary", { compact_metadata: { trigger: "auto" } })], "claude");
  assert.equal(notices(out)[0].content, "Compacted");
  assert.equal(notices(out)[0].compact.detail, undefined, "no numbers stated, none printed");
});

test("a compaction with neither text nor metadata adds no row", () => {
  assert.equal(notices(reduceSessionEvents([rec("compact_boundary", {})], "claude")).length, 0);
});

test("the running status opens a row, and the boundary that follows settles it", () => {
  const out = reduceSessionEvents([
    { seq: 1, event: "user_message", data: { text: "/compact" } },
    rec("status", { status: "compacting" }),
    rec("compact_boundary", { compact_metadata: { trigger: "manual", pre_tokens: 40053, post_tokens: 2452, duration_ms: 22885 } })
  ], "claude");
  const rows = notices(out);
  assert.equal(rows.length, 1, "the pair is one row, not two");
  assert.equal(rows[0].compacting, undefined, "the settled row is not still running");
  assert.equal(rows[0].compact.preTokens, 40053);
});

test("a status that is not a compaction is not a row", () => {
  for (const status of ["requesting"]) {
    assert.equal(notices(reduceSessionEvents([rec("status", { status })], "claude")).length, 0, `${status} must not open a row`);
  }
  assert.equal(notices(reduceSessionEvents([rec("status", { status: "requesting", permissionMode: "plan" })], "claude")).length, 0);
});

test("a FAILED compaction closes its row instead of spinning forever", () => {
  const out = reduceSessionEvents([
    { seq: 1, event: "user_message", data: { text: "/compact" } },
    rec("status", { status: "compacting" }),
    rec("status", { status: null, compact_result: "failed", compact_error: "Compaction failed · conversation could not be reduced" })
  ], "claude");
  const rows = notices(out);
  assert.equal(rows.length, 1, "the running row is replaced, not joined");
  assert.equal(rows[0].compacting, undefined, "nothing is still running");
  assert.equal(rows[0].level, "error");
  assert.match(rows[0].content, /could not be reduced/);
});

test("a failed compaction with the detail stripped still says it failed", () => {
  const out = reduceSessionEvents([
    { seq: 1, event: "user_message", data: { text: "/compact" } },
    rec("status", { status: "compacting" }),
    rec("status", { status: null, compact_result: "failed" })
  ], "claude");
  assert.equal(notices(out)[0].content, "Compaction failed");
  assert.equal(notices(out)[0].level, "error");
});

test("a SUCCESSFUL compaction's clearing closes the row, and the boundary draws the result", () => {
  const out = reduceSessionEvents([
    { seq: 1, event: "user_message", data: { text: "/compact" } },
    rec("status", { status: "compacting" }),
    rec("status", { status: null, compact_result: "success" }),
    rec("compact_boundary", { compact_metadata: { trigger: "manual", pre_tokens: 40053, post_tokens: 2452, duration_ms: 22885 } })
  ], "claude");
  const rows = notices(out);
  assert.equal(rows.length, 1, "one compaction, one row");
  assert.equal(rows[0].compact.preTokens, 40053);
});

test("a skipped compaction does not leave its row spinning", () => {
  const out = reduceSessionEvents([
    { seq: 1, event: "user_message", data: { text: "/compact" } },
    rec("status", { status: "compacting" }),
    rec("status", { status: null })
  ], "claude");
  assert.equal(notices(out).length, 0, "the spinner is gone and no empty row replaces it");
  assert.equal(out.messages.filter((m) => m.role === "assistant" && !m.content).length, 0);
});

test("a settled compaction with nothing to say still closes the row in the store", () => {
  useAiStore.getState().initSession("live-settle");
  useAiStore.getState().addNotice("live-settle", { subtype: "status", level: "info", content: "Compacting…", compacting: true });
  assert.equal(useAiStore.getState().bySession["live-settle"].messages.length, 1);
  useAiStore.getState().addNotice("live-settle", { subtype: "status", level: "info", content: "", compactSettled: true });
  assert.equal(useAiStore.getState().bySession["live-settle"].messages.length, 0, "the spinner is dropped");
});

test("a compaction whose row is NOT the last one still gets replaced", () => {
  const out = reduceSessionEvents([
    { seq: 1, event: "user_message", data: { text: "/compact" } },
    rec("status", { status: "compacting" }),
    rec("api_error", { level: "error", error: { formatted: "503 Service Unavailable" } }),
    rec("compact_boundary", { compact_metadata: { trigger: "manual", pre_tokens: 40053, post_tokens: 2452, duration_ms: 22885 } })
  ], "claude");
  const rows = notices(out);
  assert.equal(rows.length, 2, "the error keeps its place, the compaction settles in its own");
  assert.equal(rows.filter((r) => r.compacting).length, 0, "nothing is left spinning");
  assert.equal(rows[0].compact.preTokens, 40053, "the settled row took the spinner's SLOT, not the end of the list");
  assert.equal(rows[1].subtype, "api_error", "and the error stayed where it happened, after it");
});

test("a skipped compaction removes its row from the middle, not the end", () => {
  const out = reduceSessionEvents([
    { seq: 1, event: "user_message", data: { text: "/compact" } },
    rec("status", { status: "compacting" }),
    rec("api_error", { level: "error", error: { formatted: "503 Service Unavailable" } }),
    rec("status", { status: null })
  ], "claude");
  const rows = notices(out);
  assert.equal(rows.length, 1, "the spinner is gone and the error survives");
  assert.equal(rows[0].subtype, "api_error");
});

test("a settled compaction that is NOT running yet adds no empty row", () => {
  useAiStore.getState().initSession("live-settle-stray");
  useAiStore.getState().addNotice("live-settle-stray", { subtype: "status", level: "info", content: "", compactSettled: true });
  assert.equal(useAiStore.getState().bySession["live-settle-stray"].messages.length, 0);
});

test("a refused notice leaves the store intact, every session still in it", () => {
  useAiStore.getState().initSession("live-keep-a");
  useAiStore.getState().initSession("live-keep-b");
  useAiStore.getState().addUserMessage("live-keep-a", "still here");
  useAiStore.getState().addNotice("live-keep-b", { level: "info", content: "   " });
  const after = useAiStore.getState();
  assert.ok(after?.bySession, "the store survives an update that changed nothing");
  assert.ok(after.bySession["live-keep-a"], "and it did not drop the other sessions");
  assert.equal(after.bySession["live-keep-a"].messages.length, 2, "user prompt plus its placeholder");
});

test("the compaction row reaches the pane with its numbers, not just its text", () => {
  const rows = buildTurnRows([
    { id: "n1", role: "notice", subtype: "compact_boundary", level: "info", content: "Compacted", compact: { trigger: "manual", preTokens: 40053, postTokens: 2452, detail: "40k → 2.5k tokens", durationMs: 22885 } }
  ], "claude");
  assert.equal(rows[0].kind, "notice");
  assert.equal(rows[0].notice.compact.preTokens, 40053, "the row carries what the pane prints");
});

test("a running compaction reaches the pane as a running row", () => {
  const rows = buildTurnRows([
    { id: "n1", role: "notice", subtype: "status", level: "info", content: "Compacting…", compacting: true }
  ], "claude");
  assert.equal(rows[0].notice.compacting, true);
});

test("a record with nothing to show adds no row", () => {
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
  const rows = [
    { kind: "notice", id: "n1", notice: { subtype: "compact_boundary", level: "info", content: "x" } },
    ...Array.from({ length: 8 }, (_, i) => ({ kind: "tool", id: `t${i}`, tool: { id: `t${i}`, name: "Bash" }, engine: "claude" }))
  ];
  const blocks = splitTurnBlocks(rows, 6);
  const noticeBlock = blocks.find((b) => b.row?.kind === "notice");
  assert.ok(noticeBlock, "the notice is its own block, outside the steps run");
  assert.equal(noticeBlock.type, "row");
});

test("a notice that arrives live reaches the store, like one that was replayed", () => {
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

test("a notice is a plain line, whatever it carries", () => {
  useAiStore.getState().initSession("live-plain");
  useAiStore.getState().addNotice("live-plain", { level: "info", content: "compacted" });
  const msgs = useAiStore.getState().bySession["live-plain"].messages;
  assert.equal(msgs[0].file, undefined, "the store keeps no file on a notice");

  const rows = buildTurnRows(msgs, "claude");
  assert.equal(rows[0].notice.content, "compacted");
  assert.equal(rows[0].notice.file, undefined, "and the row carries none either");
});

test("a task notification's own frame is never shown", () => {
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
  const n = noticeFrom("attachment", { type: "queued_command", prompt: "chạy test giúp tôi" });
  assert.ok(n);
  assert.equal(n.content, "chạy test giúp tôi");
});

test("a hook whose output is real context still shows — at SessionStart", () => {
  const n = noticeFrom("attachment", { type: "hook_success", hookEvent: "SessionStart", content: "codegraph: 12 symbols matched" });
  assert.ok(n);
  assert.match(n.content, /codegraph/);
});

test("a harness frame is filtered on the system door too", () => {
  const inner = "<task-notification>\n<task-id>x</task-id>\n</task-notification>";
  assert.equal(noticeFrom("system", { content: inner }), null);
  assert.ok(noticeFrom("system", { content: "Conversation compacted", level: "info" }), "real text still shows");
});

test("a hook's output shows only where the TUI shows it — SessionStart", () => {
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
  const saved = "<persisted-output>\nOutput too large. Full output saved to: /tmp/tool-results/abc.txt\nPreview: <junk>…\n</persisted-output>";
  const n = noticeFrom("attachment", { type: "hook_success", hookEvent: "SessionStart", content: saved });
  assert.ok(n);
  assert.match(n.content, /saved to: \/tmp\/tool-results\/abc\.txt/);
  assert.doesNotMatch(n.content, /<persisted-output>/, "the frame is gone");
  assert.doesNotMatch(n.content, /Preview/, "and so is the preview dump");
});

test("a hook with no hookEvent at all shows nothing", () => {
  assert.equal(noticeFrom("attachment", { type: "hook_success", content: "something" }), null);
});

test("a persisted-output frame never reaches a queued prompt's row either", () => {
  const txt = "<persisted-output>\nOutput too large. Full output saved to: /tmp/a.txt\nPreview: junk\n</persisted-output>";
  assert.equal(noticeFrom("attachment", { type: "queued_command", prompt: txt }), null);
  assert.equal(noticeFrom("attachment", { type: "queued_command", prompt: "chạy test giúp tôi" }).content, "chạy test giúp tôi");
});

test("codex warnings stay out of the chat", () => {
  assert.equal(noticeFrom("warning", { threadId: "t-1", message: "Stream error: retrying" }), null);
});

test("a codex error is read one level down, where its message lives", () => {
  const n = noticeFrom("error", { error: { message: "sandbox denied" }, willRetry: false });
  assert.equal(n.content, "sandbox denied");
  assert.equal(n.level, "error");
});

test("an error the CLI is retrying is not painted as a dead turn", () => {
  const n = noticeFrom("error", { error: { message: "stream closed" }, willRetry: true });
  assert.equal(n.level, "warning");
});

test("a config warning stays out of the chat", () => {
  assert.equal(noticeFrom("configWarning", { summary: "unknown key", details: "line 4" }), null);
});

test("a rerouted model is stated, not hidden", () => {
  const n = noticeFrom("model/rerouted", { fromModel: "gpt-5.6-sol", toModel: "gpt-5.5" });
  assert.match(n.content, /gpt-5\.6-sol → gpt-5\.5/);
});

test("a codex notification that says nothing readable draws nothing", () => {
  for (const type of ["turn/started", "thread/started", "item/started", "account/rateLimits/updated"]) {
    assert.equal(noticeFrom(type, { threadId: "t-1" }), null, `${type} is state, not prose`);
  }
});

test("a codex compaction draws the one line it has", () => {
  const n = noticeFrom("thread/compacted", { threadId: "t-1", turnId: "turn-1" });
  assert.equal(n.content, "Compacted");
  assert.equal(n.level, "info");
  assert.equal(n.compactSettled, true, "and it closes a running compaction row if one is open");
});

test("a failed turn draws the CLI's own sentence", () => {
  const out = reduceSessionEvents([
    { seq: 1, event: "user_message", data: { text: "hi" } },
    { seq: 2, event: "delta", data: { text: "…" } },
    { seq: 3, event: "turn_complete", data: { isError: true, subtype: "error_during_execution", result: "Reached maximum number of turns (5)" } }
  ], "claude");
  const n = notices(out);
  assert.equal(n.length, 1, "the failure is a row of its own");
  assert.equal(n[0].level, "error");
  assert.equal(n[0].content, "Reached maximum number of turns (5)");
});

test("a turn that answered draws nothing", () => {
  const out = reduceSessionEvents([
    { seq: 1, event: "user_message", data: { text: "hi" } },
    { seq: 2, event: "turn_complete", data: { isError: false, subtype: "success", result: "done" } }
  ], "claude");
  assert.equal(notices(out).length, 0, "a finished turn is not a line");
});

test("a failure the answer already printed is not printed twice", () => {
  const said = "There is an issue with the selected model (x).";
  const dup = reduceSessionEvents([
    { seq: 1, event: "user_message", data: { text: "hi" } },
    { seq: 2, event: "delta", data: { text: said } },
    { seq: 3, event: "turn_complete", data: { isError: true, subtype: "success", result: said } }
  ], "claude");
  assert.equal(notices(dup).length, 0, "the reader is already looking at that sentence");

  const other = reduceSessionEvents([
    { seq: 1, event: "delta", data: { text: said } },
    { seq: 2, event: "turn_complete", data: { isError: true, result: "The connection dropped." } }
  ], "claude");
  assert.equal(notices(other)[0].content, "The connection dropped.");
});

test("a failed turn that states no text still says it failed", () => {
  const out = reduceSessionEvents([{ seq: 1, event: "turn_complete", data: { isError: true } }], "claude");
  assert.equal(notices(out)[0].content, "The turn ended in an error.");
});

test("a process that died draws a row, an ordinary exit does not", () => {
  const bad = reduceSessionEvents([{ seq: 1, event: "exit", data: { code: 1, signal: null } }], "claude");
  assert.match(notices(bad)[0].content, /code 1/);
  assert.equal(notices(bad)[0].level, "error");

  const noBin = reduceSessionEvents([{ seq: 1, event: "exit", data: { code: null, error: "spawn claude ENOENT" } }], "claude");
  assert.match(notices(noBin)[0].content, /ENOENT/);

  assert.equal(notices(reduceSessionEvents([{ seq: 1, event: "exit", data: { code: 0, signal: "SIGINT" } }], "claude")).length, 0);
});

test("a spawn failure is the same row the harness's own errors use", () => {
  const out = reduceSessionEvents([{ seq: 1, event: "error", data: { message: "spawn claude ENOENT" } }], "claude");
  const n = notices(out);
  assert.equal(n.length, 1);
  assert.equal(n[0].level, "error");
  assert.match(n[0].content, /ENOENT/);
});

test("a refused prompt is a notice, not a turn ending", () => {
  const out = reduceSessionEvents([
    { event: "user_message", data: { text: "chào" } },
    { event: "prompt_refused", data: { text: "bạn khỏe ko", reason: "Codex turn is already running." } }
  ], "codex");
  assert.equal(out.isTurnRunning, true, "the running turn keeps its flag through a refusal");
  const rows = out.messages.filter((m) => m.role === "notice");
  assert.equal(rows.length, 1, "the refusal draws exactly one row");
  assert.equal(rows[0].subtype, "prompt_refused");
  assert.match(rows[0].content, /Not sent/);
  assert.match(rows[0].content, /bạn khỏe ko/);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
