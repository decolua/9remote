// Tests transcript recovery by session ID across engines (Claude, Codex, OpenCode).
// Run: node agent/test/recoverTranscript.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const home = fs.mkdtempSync(path.join(os.tmpdir(), "recover-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

const ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const startedIn = "/Users/someone/repo";
const elsewhere = "/tmp";
const projectsDir = path.join(home, ".claude", "projects");
const dir = path.join(projectsDir, startedIn.replace(/[/\\:]/g, "-"));
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, `${ID}.jsonl`), [
  JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "hello there" }] } }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } })
].join("\n"));

import { recoverFromClaudeTranscript as recover } from "../features/ai/claudeTranscript.js";
import { recoverFromCodexTranscript, recoverFromOpencodeTranscript } from "../features/ai/transcript.js";

const found = recover(elsewhere, ID);
assert.ok(found, "transcript must be found even when cwd has moved on");
assert.equal(found.filter((e) => e.event === "user_message").length, 1);
assert.equal(found.filter((e) => e.event === "delta").length, 1);

// The id stays untrusted: a path-shaped one must not escape the projects dir.
assert.equal(recover(elsewhere, "../../../etc/passwd"), null);
assert.equal(recover(elsewhere, "-flag-shaped"), null);
assert.equal(recover(elsewhere, "no/slashes"), null);

const HARNESS_ID = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
fs.writeFileSync(path.join(dir, `${HARNESS_ID}.jsonl`), [
  JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "real question" }] } }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "an answer" }] } }),
  JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } }),
  JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } }),
  JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "[Image #1]" }] } })
].join("\n"));

const harness = recover(elsewhere, HARNESS_ID);
const texts = harness.filter((e) => e.event === "user_message").map((e) => e.data.text);
assert.deepEqual(texts, ["real question", "[Image #1]"],
  `interrupt notes must not replay as prompts, got: ${JSON.stringify(texts)}`);

const EDIT_ID = "cccccccc-dddd-eeee-ffff-000000000000";
const call = (id, name, input) => JSON.stringify({
  type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] }
});
const result = (id, content, isError) => JSON.stringify({
  type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] }
});
fs.writeFileSync(path.join(dir, `${EDIT_ID}.jsonl`), [
  JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "change it" }] } }),
  call("t1", "Edit", { file_path: "/repo/a.txt", old_string: "old", new_string: "new" }),
  result("t1", "The file /repo/a.txt has been updated successfully."),
  call("t2", "Write", { file_path: "/repo/b.txt", content: "hi\nthere" }),
  result("t2", "File created successfully at: /repo/b.txt"),
  call("t3", "Edit", { file_path: "/repo/c.txt", old_string: "x", new_string: "y" }),
  result("t3", "The user doesn't want to proceed with this tool use.", true)
].join("\n"));

const edits = recover(elsewhere, EDIT_ID);
const diffs = edits.filter((e) => e.event === "diff").map((e) => e.data);
assert.equal(diffs.length, 2, `expected 2 diff cards, got ${JSON.stringify(diffs)}`);
assert.equal(diffs[0].file, "/repo/a.txt");
assert.equal(diffs[0].patch, "-old\n+new");
assert.equal(diffs[1].patch, "");
assert.equal(diffs[1].content, "hi\nthere");

const statuses = edits.filter((e) => e.event === "tool_result").map((e) => e.data.status);
assert.deepEqual(statuses, ["done", "done", "error"],
  `a refused edit must not replay as done, got: ${JSON.stringify(statuses)}`);

const CODEX_ID = "019d9c60-6463-7f51-a61d-ef8951e73fdc";
const codexCwd = "/tmp/codex-project";
const codexDir = path.join(home, ".codex", "sessions", "2026", "04", "17");
fs.mkdirSync(codexDir, { recursive: true });
fs.writeFileSync(path.join(codexDir, `rollout-2026-04-17T23-57-36-${CODEX_ID}.jsonl`), [
  JSON.stringify({ type: "session_meta", payload: { cwd: codexCwd } }),
  JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "text", text: "list the files" }] } }),
  JSON.stringify({ type: "event_msg", payload: { type: "item_completed", item: {
    type: "CommandExecution", id: "call_1", command: ["/bin/bash", "-lc", "ls -F"],
    status: "completed", aggregated_output: "a.txt\nb.txt\n", exit_code: 0
  } } }),
  JSON.stringify({ type: "response_item", payload: { type: "function_call", call_id: "call_1", name: "exec_command", arguments: '{"cmd":"ls -F"}' } }),
  JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "call_1", output: "a.txt\nb.txt\n" } }),
  JSON.stringify({ type: "response_item", payload: { type: "function_call", call_id: "call_2", name: "exec_command", arguments: '{"cmd":"pwd"}' } }),
  JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "call_2", output: "/tmp/codex-project\n" } }),
  JSON.stringify({ type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "text", text: "<skills_instructions>…" }] } }),
  JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "text", text: "# AGENTS.md instructions\n\n<INSTRUCTIONS>be brief" }] } }),
  JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "text", text: "a.txt and b.txt" }] } }),
  JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call", call_id: "call_patch", name: "exec", input: "const patch = \"*** Begin Patch\\n*** Add File: /w/new.txt\\n+hi\\n*** End Patch\";" } }),
  JSON.stringify({ type: "event_msg", payload: { type: "item_completed", item: {
    type: "FileChange", id: "exec-7336174b", status: "completed",
    changes: { "/w/new.txt": { type: "add", content: "hi\n" } }
  } } }),
  JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call_patch", output: "Success." } })
].join("\n"));

const codex = recoverFromCodexTranscript(codexCwd, CODEX_ID);
const codexTools = (codex || []).filter((e) => e.event === "tool_start");
assert.deepEqual(codexTools.map((e) => e.data.id), ["call_1", "call_2", "exec-7336174b"],
  `the item log and its response_item twin are ONE call, got: ${JSON.stringify(codexTools.map((e) => e.data.id))}`);
assert.equal(codexTools[0].data.name, "command");
assert.equal(codexTools[1].data.input.command, "pwd", "the fallback carries the command it ran");
assert.deepEqual((codex || []).filter((e) => e.event === "tool_result").map((e) => e.data.output),
  ["a.txt\nb.txt\n", "/tmp/codex-project\n", ""]);
assert.equal(codexTools[2].data.name, "file_change");
assert.equal(codexTools[2].data.input.file_path, "/w/new.txt");
assert.equal((codex || []).filter((e) => e.event === "diff").length, 1);
assert.deepEqual((codex || []).filter((e) => e.event === "user_message").map((e) => e.data.text), ["list the files"],
  "codex's injected project doc must not replay as a prompt");

const OC_ID = "ses_recover0001";
const ocPart = (id, tool, status, output, exit) => JSON.stringify({
  type: "tool", tool, callID: id,
  state: { status, input: { command: "ls" }, output, ...(exit === undefined ? {} : { metadata: { exit } }) }
});
const ocDb = path.join(home, ".local", "share", "opencode", "opencode.db");
fs.mkdirSync(path.dirname(ocDb), { recursive: true });
const db = new (require("node:sqlite").DatabaseSync)(ocDb);
db.exec("CREATE TABLE session (id TEXT, directory TEXT); CREATE TABLE message (id TEXT, data TEXT); CREATE TABLE part (session_id TEXT, message_id TEXT, data TEXT)");
db.prepare("INSERT INTO session VALUES (?, ?)").run(OC_ID, codexCwd);
db.prepare("INSERT INTO message VALUES (?, ?)").run("m1", JSON.stringify({ role: "user" }));
db.prepare("INSERT INTO part VALUES (?, ?, ?)").run(OC_ID, "m1", JSON.stringify({ type: "text", text: "run it" }));
db.prepare("INSERT INTO message VALUES (?, ?)").run("m2", JSON.stringify({ role: "assistant" }));
for (const p of [ocPart("c1", "bash", "completed", "ok", 0), ocPart("c2", "bash", "completed", "boom", 1)]) {
  db.prepare("INSERT INTO part VALUES (?, ?, ?)").run(OC_ID, "m2", p);
}
db.close();

const oc = recoverFromOpencodeTranscript(codexCwd, OC_ID);
assert.deepEqual((oc || []).filter((e) => e.event === "tool_start").map((e) => e.data.id), ["c1", "c2"]);
const ocResults = (oc || []).filter((e) => e.event === "tool_result").map((e) => e.data);
assert.equal(ocResults[0].status, "done");
assert.equal(ocResults[1].status, "error");
assert.match(ocResults[1].error, /exit 1/);
assert.equal(ocResults[0].error, "", "both keys always, empty on the other side");

const REWIND_ID = "99999999-8888-7777-6666-555555555555";
const rec = (uuid, parent, text) => JSON.stringify({
  type: "user", uuid, parentUuid: parent, message: { role: "user", content: [{ type: "text", text }] }
});
const ans = (uuid, parent, text) => JSON.stringify({
  type: "assistant", uuid, parentUuid: parent, message: { role: "assistant", content: [{ type: "text", text }] }
});
const WOUND = [
  rec("u1", null, "first question"),
  ans("a1", "u1", "first answer"),
  rec("u2", "a1", "second question"),
  ans("a2", "u2", "second answer"),
  rec("u3", "a2", "third question"),
  ans("a3", "u3", "third answer"),
  JSON.stringify({ type: "last-prompt", leafUuid: "a2", lastPrompt: "second question" })
];
fs.writeFileSync(path.join(dir, `${REWIND_ID}.jsonl`), WOUND.join("\n"));

const cut = recover(elsewhere, REWIND_ID);
const cutTexts = cut.filter((e) => e.event === "user_message").map((e) => e.data.text);
assert.deepEqual(cutTexts, ["first question", "second question"],
  `turns after the leaf must not replay, got: ${JSON.stringify(cutTexts)}`);
const cutDeltas = cut.filter((e) => e.event === "delta").map((e) => e.data.text);
assert.deepEqual(cutDeltas, ["first answer", "second answer"],
  `the kept turn's reply must survive, got: ${JSON.stringify(cutDeltas)}`);

const WHOLE_ID = "dddddddd-eeee-ffff-0000-111111111111";
fs.writeFileSync(path.join(dir, `${WHOLE_ID}.jsonl`), [
  ...WOUND.slice(0, 6),
  JSON.stringify({ type: "last-prompt", leafUuid: "a3", lastPrompt: "third question" })
].join("\n"));
const whole = recover(elsewhere, WHOLE_ID);
assert.deepEqual(whole.filter((e) => e.event === "user_message").map((e) => e.data.text),
  ["first question", "second question", "third question"], "nothing dropped when nothing was rewound");

const PLAIN_ID = "eeeeeeee-ffff-0000-1111-222222222222";
fs.writeFileSync(path.join(dir, `${PLAIN_ID}.jsonl`), WOUND.slice(0, 6).join("\n"));
const plain = recover(elsewhere, PLAIN_ID);
assert.equal(plain.filter((e) => e.event === "user_message").length, 3, "no leaf, no cut");

const TASK_ID = "a2b292cd45a42d6da";
const TOOL_USE = "toolu_01Km3Bv5R6d76cGsh7r3oQBp";
const dir2 = path.join(projectsDir, "-tmp-taskprobe");
fs.mkdirSync(dir2, { recursive: true });
const TASK_ID_CONV = "11111111-2222-3333-4444-555555555555";
fs.writeFileSync(path.join(dir2, `${TASK_ID_CONV}.jsonl`), [
  JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "spawn an agent" }] }, isSidechain: false }),
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: TOOL_USE, name: "Agent", input: { description: "look it up" } }] }
  }),
  JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: `<task-notification>
<task-id>${TASK_ID}</task-id>
<tool-use-id>${TOOL_USE}</tool-use-id>
<status>completed</status>
<summary>Agent "look it up" finished</summary>
</task-notification>` }]
    },
    origin: { kind: "task-notification" },
    isSidechain: false
  })
].join("\n"));

const taskLog = recover(elsewhere, TASK_ID_CONV);
assert.ok(taskLog, "the conversation must still be recovered");
assert.equal(taskLog.filter((e) => e.event === "user_message").length, 1,
  "a task notification is not a prompt the user typed");
assert.equal(taskLog.filter((e) => e.event === "tool_start").length, 1, "the launch is still there");

const done = taskLog.filter((e) => e.event === "cli_event" && e.data?.subtype === "task_notification");
assert.equal(done.length, 1, "the task's end must survive the replay");
assert.equal(done[0].data.record.task_id, TASK_ID);
assert.equal(done[0].data.record.tool_use_id, TOOL_USE);
assert.equal(done[0].data.record.status, "completed");
assert.equal(done[0].data.type, "system", "the harness's own type, not a name of our own");

const ASYNC_ID = "77777777-6666-5555-4444-333333333333";
const ASYNC_TOOL = "toolu_monitor_1";
fs.writeFileSync(path.join(dir, `${ASYNC_ID}.jsonl`), [
  JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "watch the sweep" }] } }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: ASYNC_TOOL, name: "Monitor", input: { command: "until …" } }] } }),
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: ASYNC_TOOL, content: [{ type: "text", text: "Monitor started (task b301ffx4j, timeout 600000ms). You will be notified on each event." }] }] } })
].join("\n"));

const live = recover(elsewhere, ASYNC_ID);
const [monitor] = live.filter((e) => e.event === "tool_result").map((e) => e.data);
assert.equal(monitor.name, "Monitor");
assert.equal(monitor.status, "running", "a handed-off task is not finished");
assert.equal(monitor.async, true);
assert.equal(monitor.handle, "b301ffx4j", "and the handle it named survives the replay");

const PLAIN_TOOL = "toolu_plain_1";
fs.writeFileSync(path.join(dir, `${ASYNC_ID}.jsonl`), [
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: PLAIN_TOOL, name: "Bash", input: { command: "ls" } }] } }),
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: PLAIN_TOOL, content: [{ type: "text", text: "a.txt" }] }] } })
].join("\n"));
const [ordinary] = recover(elsewhere, ASYNC_ID).filter((e) => e.event === "tool_result").map((e) => e.data);
assert.equal(ordinary.status, "done");
assert.equal(ordinary.async, undefined);

const PERSIST_TOOL = "toolu_persist_1";
const FRAME = "<persisted-output>\nOutput too large (2MB). Full output saved to: /tmp/tool-results/abc.txt\nPreview (first 2KB): junk…\n</persisted-output>";
fs.writeFileSync(path.join(dir, `${ASYNC_ID}.jsonl`), [
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: PERSIST_TOOL, name: "Bash", input: { command: "cat big" } }] } }),
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: PERSIST_TOOL, content: [{ type: "text", text: FRAME }] }] } })
].join("\n"));
const [persisted] = recover(elsewhere, ASYNC_ID).filter((e) => e.event === "tool_result").map((e) => e.data);
assert.match(persisted.output, /saved to: \/tmp\/tool-results\/abc\.txt/, "the path survives");
assert.doesNotMatch(persisted.output, /<persisted-output>/, "the frame does not");
assert.doesNotMatch(persisted.output, /Preview/, "nor the preview dump");

const QUOTE_ID = "88888888-7777-6666-5555-444444444444";
const QUOTE_TOOL = "toolu_quote_1";
fs.writeFileSync(path.join(dir, `${QUOTE_ID}.jsonl`), [
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: QUOTE_TOOL, name: "Edit", input: { file_path: "/repo/d.txt", old_string: "a", new_string: "b" } }] } }),
  JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: QUOTE_TOOL, content: [{ type: "text", text: "claudeTranscript.js:119:const RE = /doesn't want to proceed|Request interrupted/i;" }] }] } })
].join("\n"));
const quoted = recover(elsewhere, QUOTE_ID);
const [quoteResult] = quoted.filter((e) => e.event === "tool_result").map((e) => e.data);
assert.equal(quoteResult.status, "done", "quoting the phrase is not a refusal");
assert.equal(quoted.filter((e) => e.event === "diff").length, 1, "and its diff is drawn");

fs.rmSync(home, { recursive: true, force: true });
console.log("recoverTranscript: ok");
