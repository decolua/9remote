// The codex item mapping, checked at the one seam that keeps breaking: a tool call is
// reported TWICE by the CLI, and the two reports do not carry the same fields.
//
//   live     `codex exec --json`  — no `parsed_cmd` on a CommandExecution (verified
//                                   against codex-cli 0.154.0: the item carries id,
//                                   command, aggregated_output, exit_code, status only)
//   rollout  ~/.codex/sessions/…  — the whole record, same item id, parsed_cmd included
//
// So a live turn showed every read, search and listing as a bare `command` row running
// `/bin/bash -lc '…'`, while reopening the same chat named each one and printed the clean
// line. The adapter reads the rollout back by item id to close that gap; these tests hold
// the two doors to the same answer.
//
// Run: node agent/test/codexItems.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "codexitems-"));
process.env.CODEX_HOME = home;

import { codexItemEvents } from "../features/ai/codexItems.js";
import { readCodexParsedCommands } from "../features/ai/transcript.js";
import { CodexAdapter } from "../features/ai/adapters/codexAdapter.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

// Writes a rollout the way the CLI does, and returns its thread id for lookup.
let clock = 0;
function writeRollout(cwd, items) {
  const id = `01a0${String(++clock).padStart(4, "0")}-1111-2222-3333-444455556666`;
  const [y, m, d] = ["2026", "09", "15"];
  const dir = path.join(home, "sessions", y, m, d);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `rollout-2026-09-15T10-00-00-${id}.jsonl`), [
    JSON.stringify({ type: "session_meta", payload: { cwd } }),
    ...items.map((item) => JSON.stringify({ type: "event_msg", payload: { type: "item_completed", item } }))
  ].join("\n"));
  return id;
}

// The live stream's CommandExecution: argv only, no parsed_cmd.
const liveItem = (over = {}) => ({
  id: "call_1", type: "command_execution",
  command: "/bin/bash -lc 'cat a.txt'",
  aggregated_output: "hi\n", exit_code: 0, status: "completed",
  ...over
});

const start = (item) => codexItemEvents({ item, status: "started" })[0].data;

// ── the two doors ──

test("a live command with its rollout read back names what it did", () => {
  const cwd = "/tmp/proj-a";
  const id = writeRollout(cwd, [{
    id: "call_1", type: "CommandExecution", command: ["/bin/bash", "-lc", "cat a.txt"],
    parsed_cmd: [{ type: "read", cmd: "cat a.txt", name: "a.txt", path: "a.txt" }]
  }]);
  const parsed = readCodexParsedCommands(cwd, id);

  const enriched = { ...liveItem(), parsed_cmd: parsed["call_1"] };
  const got = start(enriched);
  assert.equal(got.name, "read");
  assert.equal(got.input.command, "cat a.txt");
  assert.equal(got.input.path, "a.txt");
});

test("the replayed door gives the same name and the same line as the live one", () => {
  const cwd = "/tmp/proj-b";
  const rolloutItem = {
    id: "call_1", type: "CommandExecution", command: ["/bin/bash", "-lc", "cat a.txt"],
    parsed_cmd: [{ type: "read", cmd: "cat a.txt", name: "a.txt", path: "a.txt" }]
  };
  const id = writeRollout(cwd, [rolloutItem]);
  const parsed = readCodexParsedCommands(cwd, id);

  // Replay hands the rollout's own record straight to the mapper.
  const replayed = start(rolloutItem);
  // Live hands the stream's record plus whatever the rollout could add.
  const live = start({ ...liveItem(), parsed_cmd: parsed["call_1"] });

  assert.deepEqual(
    { name: live.name, input: live.input },
    { name: replayed.name, input: replayed.input },
    "one call must read the same whichever door it came through"
  );
});

test("codex's own tag decides the name; a tag it has no word for stays a command", () => {
  const named = (parsed_cmd) => start({ ...liveItem(), parsed_cmd }).name;
  assert.equal(named([{ type: "read", cmd: "cat a", path: "a" }]), "read");
  assert.equal(named([{ type: "search", cmd: "rg x", query: "x", path: "." }]), "search");
  assert.equal(named([{ type: "list_files", cmd: "ls", path: null }]), "list_files");
  // `unknown` is the CLI saying it did not recognise the command — `npm test`, `git
  // status` — which is a shell row and nothing more.
  assert.equal(named([{ type: "unknown", cmd: "npm test" }]), "command");
  assert.equal(named(undefined), "command");
});

test("a compound call keeps every command it ran, not just the first", () => {
  const got = start({
    ...liveItem(),
    parsed_cmd: [
      { type: "read", cmd: "sed -n '1,20p' a.js", name: "a.js", path: "a.js" },
      { type: "read", cmd: "sed -n '1,20p' b.js", name: "b.js", path: "b.js" }
    ]
  });
  assert.equal(got.input.command, "sed -n '1,20p' a.js; sed -n '1,20p' b.js");
  // The first one is what the card offers to open.
  assert.equal(got.input.path, "a.js");
});

test("no parsed_cmd anywhere: the raw argv is the fallback, wrapper and all", () => {
  const got = start(liveItem());
  assert.equal(got.name, "command");
  assert.equal(got.input.command, "/bin/bash -lc 'cat a.txt'");
  assert.equal(got.input.path, undefined, "no path to offer, so no editor button");
});

// The rollout is written by the CLI while the turn runs, so the adapter's read can come
// back empty — a brand-new thread, or an id the file has not reached yet. Either way the
// row must still open; a throw here would take the whole turn's events with it.
test("a rollout that is not there yet answers empty, and the row still opens", () => {
  assert.equal(readCodexParsedCommands("/tmp/proj-never-written", "01a0ffff-1111-2222-3333-444455556666"), null);
  assert.equal(readCodexParsedCommands("", ""), null);

  const known = writeRollout("/tmp/proj-c", []);
  assert.deepEqual(readCodexParsedCommands("/tmp/proj-c", known), {}, "a rollout with no commands has nothing to add");
  // An id the file never mentions — the same "not yet" the adapter has to survive.
  assert.equal(readCodexParsedCommands("/tmp/proj-c", known)["call_missing"], undefined);
});

test("parsed_cmd is looked up by id, so two calls in one thread cannot swap", () => {
  const cwd = "/tmp/proj-d";
  const id = writeRollout(cwd, [
    { id: "call_a", type: "CommandExecution", parsed_cmd: [{ type: "read", cmd: "cat a", path: "a" }] },
    { id: "call_b", type: "CommandExecution", parsed_cmd: [{ type: "search", cmd: "rg b", query: "b" }] }
  ]);
  const parsed = readCodexParsedCommands(cwd, id);
  assert.equal(parsed["call_a"][0].type, "read");
  assert.equal(parsed["call_b"][0].type, "search");
});

// ── thinking ──
//
// What codex DOES send, pinned so a later change to streaming is a deliberate one.
// Claude streams a thought in `thinking_delta` chunks; `codex exec --json` does not —
// the binary has reasoning deltas but this mode never emits them. It sends ONE
// `item.completed reasoning`, and it sends it AFTER the answer.
test("codex sends one whole reasoning item, after the message it explains", () => {
  const events = [];
  const adapter = new CodexAdapter({ cwd: "/tmp", onEvent: (e, d) => events.push([e, d]) });
  // The real order recorded from `codex exec --json`.
  adapter.handleEvent({ type: "item.completed", item: { id: "i2", type: "agent_message", text: "391" } });
  adapter.handleEvent({ type: "item.completed", item: { id: "i3", type: "reasoning", text: "17*23 = 340+51" } });

  assert.deepEqual(events.map(([e]) => e), ["delta", "thinking"]);
  assert.deepEqual(events.map(([, d]) => d.text), ["391", "17*23 = 340+51"]);
  // `item.started` must not double it: only the completed record carries the text.
  const more = [];
  const a2 = new CodexAdapter({ cwd: "/tmp", onEvent: (e, d) => more.push([e, d]) });
  a2.handleEvent({ type: "item.started", item: { id: "i4", type: "reasoning", status: "in_progress" } });
  assert.deepEqual(more, [], "a reasoning item is announced with no text, so there is nothing to send yet");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
