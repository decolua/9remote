// A re-attach must rebuild a log that is thinner than the CLI's own transcript, BEFORE
// the hydrate is answered. The ack's `fromSeq` is where the client's window begins, so a
// thin log does not just hide the missing turns — the pane never asks for them either.
// Run: node agent/test/aiThinLogRecovery.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (err) { fail++; console.error(`  ✗ ${name}\n    ${err.message}`); }
};

// A throwaway home so the real ~/.9remote/ai-sessions is never read or written.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "9remote-thin-"));
process.env.NREMOTE_HOME = home;
fs.mkdirSync(path.join(home, "ai-sessions"), { recursive: true });

const { AiSession } = await import("../features/ai/aiSession.js");

const cwd = path.join(os.tmpdir(), "9remote-thin-cwd");
const cliId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const projDir = path.join(os.homedir(), ".claude", "projects", cwd.replace(/[/\\:]/g, "-"));
const transcriptPath = path.join(projDir, `${cliId}.jsonl`);
const TURNS = 12;

console.log("Running thin-log recovery tests...");

fs.mkdirSync(projDir, { recursive: true });
fs.writeFileSync(transcriptPath, Array.from({ length: TURNS }, (_, i) => [
  JSON.stringify({ type: "user", message: { content: [{ type: "text", text: `turn ${i}` }] } }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `reply ${i}` }] } }),
]).flat().join("\n"));

// The state a cap or a legacy file leaves behind: only the last two turns.
const SNAP_TURNS = 2;
const snapshotFile = path.join(home, "ai-sessions", "claude-thin.json");
fs.writeFileSync(snapshotFile, JSON.stringify({
  engine: "claude", cwd, threadId: null, cliSessionId: cliId,
  events: Array.from({ length: SNAP_TURNS }, (_, i) => [
    { seq: i * 2 + 1, event: "user_message", data: { text: `turn ${TURNS - SNAP_TURNS + i}` } },
    { seq: i * 2 + 2, event: "delta", data: { text: `reply ${TURNS - SNAP_TURNS + i}` } },
  ]).flat()
}));

const open = () => new AiSession({ id: "thin", engine: "claude", cwd, options: { mock: true }, onEvent() {} });

test("a snapshot thinner than the transcript is rebuilt from it", () => {
  const s = open();
  // Opening is the first door: the constructor reads the CLI's store, so a chat whose log
  // was shed by the event cap comes back holding its prompts without anyone asking.
  assert.equal(s.history.filter((e) => e.event === "user_message").length, TURNS, "every turn is back");
  // The store was just read, so a hydrate right after has nothing new to add — but it
  // still reads it and still adopts the answer (no "is it thinner?" gate to disagree with).
  assert.equal(s.refreshFromStore(), true, "a reopen rebuilds from the store, always");
});

test("a rebuilt log is renumbered from 1, and the counter follows it", () => {
  const s = open();
  assert.ok(s.history.every((e, i) => e.seq === i + 1), "seqs are 1..N so scroll-up can walk them");
  assert.equal(s.seqCounter, s.history.length);
});

// The event cap sheds the HEAD of the log, and the head is where the prompts are — the
// log left behind is a tail of tool events with no `user_message` in it at all
// (measured: 65 events left of a live chat, none of them a prompt). Reopening must
// rebuild from the transcript, or the pane shows a column of cards with no bubbles above
// them and nothing to scroll to: the prompts are not in the log.
test("the log comes from the store alone — a snapshot cannot substitute for it", () => {
  // The snapshot no longer holds events, so a session whose store has nothing opens
  // EMPTY rather than falling back. That is the deliberate trade: the log lives in the
  // CLI's transcript, and a file that also carried it was thrown away on the next open
  // anyway (measured: 6.93 MB -> 253 bytes).
  fs.writeFileSync(path.join(home, "ai-sessions", "codex-none.json"), JSON.stringify({
    engine: "codex", cwd, threadId: "t-1", cliSessionId: null, model: "m"
  }));
  const s = new AiSession({ id: "none", engine: "codex", cwd, options: { mock: true }, onEvent() {} });
  assert.equal(s.history.length, 0, "no store, no log");
  assert.equal(s.model, "m", "but the state it does carry still loads");
});

test("a prompt shed from a live log is still there on the next open — the store is read every time", () => {
  // The log in memory can lose its head to AI_MAX_EVENTS; the transcript never does. So
  // opening rebuilds, and the prompts come back with it.
  const s = open();
  assert.equal(s.history.filter((e) => e.event === "user_message").length, TURNS, "every turn is back");
});

fs.rmSync(transcriptPath, { force: true });
fs.rmSync(home, { recursive: true, force: true });

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
