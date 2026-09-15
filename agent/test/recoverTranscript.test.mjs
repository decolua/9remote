// A resumed conversation is found by id, not by the directory the terminal happens
// to be standing in: the CLI writes its transcript under the directory it STARTED
// in, and the terminal may have `cd`'d away since. Getting this wrong is silent —
// the chat pane opens empty on a conversation that plainly exists.
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

// A turn the CLI wrote itself — the note left where a turn was interrupted — must not
// come back as something the user typed. It carries no turn_complete after it, so a
// replayed log ending on one reads as "a turn is still running" to every client, and the
// chat stops sending. Both shapes were seen in the wild; the shorter one is older.
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

// An edit tool's diff is rebuilt from the CALL's old/new strings, so a reopened pane
// draws the same card the stream did. A refused edit never reached the disk and paints
// none — the tool row alone stays, which is what says it was refused.
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
  result("t3", "The user doesn't want to proceed with this tool use.")
].join("\n"));

const edits = recover(elsewhere, EDIT_ID);
const diffs = edits.filter((e) => e.event === "diff").map((e) => e.data);
assert.equal(diffs.length, 2, `expected 2 diff cards, got ${JSON.stringify(diffs)}`);
assert.equal(diffs[0].file, "/repo/a.txt");
assert.equal(diffs[0].patch, "-old\n+new");
// Write carries content, not a patch — the card renders it as additions on its own.
assert.equal(diffs[1].patch, "");
assert.equal(diffs[1].content, "hi\nthere");

const statuses = edits.filter((e) => e.event === "tool_result").map((e) => e.data.status);
assert.deepEqual(statuses, ["done", "done", "error"],
  `a refused edit must not replay as done, got: ${JSON.stringify(statuses)}`);

// ── Codex: the rollout holds the tool calls, in two spellings of the same call ──
//
// A reopened codex chat showed no tool cards at all: the reader understood only the
// message and reasoning records, so every call the CLI wrote was skipped, and each
// `tool_result` landed on an id the client had never seen and was dropped whole. The two
// sources agree on the id (`item.id` === `function_call.call_id`, checked on a real
// rollout), and the item log is the richer one, so its copy is the one that survives.
const CODEX_ID = "019d9c60-6463-7f51-a61d-ef8951e73fdc";
const codexCwd = "/tmp/codex-project";
const codexDir = path.join(home, ".codex", "sessions", "2026", "04", "17");
fs.mkdirSync(codexDir, { recursive: true });
fs.writeFileSync(path.join(codexDir, `rollout-2026-04-17T23-57-36-${CODEX_ID}.jsonl`), [
  JSON.stringify({ type: "session_meta", payload: { cwd: codexCwd } }),
  JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "text", text: "list the files" }] } }),
  // The same call, twice: the item log's copy (with the command's output) and the
  // response_item copy (with the raw arguments). One card, not two.
  JSON.stringify({ type: "event_msg", payload: { type: "item_completed", item: {
    type: "CommandExecution", id: "call_1", command: ["/bin/bash", "-lc", "ls -F"],
    status: "completed", aggregated_output: "a.txt\nb.txt\n", exit_code: 0
  } } }),
  JSON.stringify({ type: "response_item", payload: { type: "function_call", call_id: "call_1", name: "exec_command", arguments: '{"cmd":"ls -F"}' } }),
  JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "call_1", output: "a.txt\nb.txt\n" } }),
  // A call the item log never covered — the fallback has to carry it on its own.
  JSON.stringify({ type: "response_item", payload: { type: "function_call", call_id: "call_2", name: "exec_command", arguments: '{"cmd":"pwd"}' } }),
  JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "call_2", output: "/tmp/codex-project\n" } }),
  // The harness's own writing: codex injects the project doc as a user message and its
  // skills as a developer one. Neither is a turn the user typed.
  JSON.stringify({ type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "text", text: "<skills_instructions>…" }] } }),
  JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "text", text: "# AGENTS.md instructions\n\n<INSTRUCTIONS>be brief" }] } }),
  JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "text", text: "a.txt and b.txt" }] } }),
  // A patch: the call and the item it produced carry DIFFERENT ids (the real rollout had
  // `call_OsNL…` against `exec-7336…`), which is why matching on the id drew two cards for
  // one edit. 31 rollouts on this machine have this shape.
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
// One card for the patch, from the item — not a second one from the `exec` call that
// produced it, which is the whole point of matching by kind and order.
assert.equal(codexTools[2].data.name, "file_change");
assert.equal(codexTools[2].data.input.file_path, "/w/new.txt");
assert.equal((codex || []).filter((e) => e.event === "diff").length, 1);
assert.deepEqual((codex || []).filter((e) => e.event === "user_message").map((e) => e.data.text), ["list the files"],
  "codex's injected project doc must not replay as a prompt");

// ── OpenCode: the part on disk IS the part the live stream carried ──
//
// Same object, so the same mapper reads both — the shared function is what keeps a
// reopened chat's cards identical to the ones the live turn drew.
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
// A shell command that ran and exited non-zero is a failure, not a done card.
assert.equal(ocResults[1].status, "error");
assert.match(ocResults[1].error, /exit 1/);
assert.equal(ocResults[0].error, "", "both keys always, empty on the other side");

fs.rmSync(home, { recursive: true, force: true });
console.log("recoverTranscript: ok");
