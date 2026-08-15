// Tests for the agent-side screen mirror: a small tail of recent PTY output, kept so the
// chat GUI can verify what is on screen WITHOUT asking the daemon (which would force a
// daemon protocol change and kill every running terminal on upgrade).
// Run: node agent/test/screenMirror.test.mjs
import assert from "node:assert/strict";

const {
  recordOutput, readScreen, forgetScreen, MIRROR_MAX_BYTES, _resetForTest,
} = await import("../features/terminal/screenMirror.js");

let pass = 0, fail = 0;
const test = (name, fn) =>
  Promise.resolve().then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });

const SID = "session-1";

await test("output written as a Buffer comes back as text", () => {
  _resetForTest();
  recordOutput(SID, Buffer.from("hello world", "utf8"));
  assert.equal(readScreen(SID), "hello world");
});

await test("output written as base64 is decoded", () => {
  _resetForTest();
  // The daemon marks its frames enc:"b64" and the agent forwards them untouched.
  recordOutput(SID, Buffer.from("Do you want to proceed?", "utf8").toString("base64"), "b64");
  assert.equal(readScreen(SID), "Do you want to proceed?");
});

await test("output written as a plain string is kept as-is", () => {
  _resetForTest();
  recordOutput(SID, "plain text");
  assert.equal(readScreen(SID), "plain text");
});

await test("successive writes concatenate in order", () => {
  _resetForTest();
  recordOutput(SID, "Do you want");
  recordOutput(SID, " to proceed?\n");
  recordOutput(SID, " 1. Yes\n 2. No\n");
  assert.match(readScreen(SID), /Do you want to proceed\?\n 1\. Yes\n 2\. No/);
});

await test("a prompt split across frames is still readable", () => {
  _resetForTest();
  // The real failure this guards: a selector arrives in several TCP frames, and a mirror
  // that kept only the newest one would see a fragment and refuse every choice.
  for (const chunk of ["Do you ", "want to pro", "ceed?\n 1. Y", "es\n 2. No\n"]) recordOutput(SID, chunk);
  assert.match(readScreen(SID), /Do you want to proceed\?/);
  assert.match(readScreen(SID), /2\. No/);
});

await test("an unknown session reads as empty, not undefined", () => {
  _resetForTest();
  assert.equal(readScreen("never-seen"), "");
});

await test("empty and missing writes are ignored", () => {
  _resetForTest();
  recordOutput(SID, "");
  recordOutput(SID, null);
  recordOutput(SID, undefined);
  assert.equal(readScreen(SID), "");
});

await test("a write with no session id is dropped", () => {
  _resetForTest();
  recordOutput("", "x");
  recordOutput(null, "x");
  assert.equal(readScreen(""), "");
});

/* ---- bounded: a busy terminal streams megabytes ---- */

await test("the mirror never grows past its cap", () => {
  _resetForTest();
  for (let i = 0; i < 200; i++) recordOutput(SID, "x".repeat(1000));
  assert.ok(readScreen(SID).length <= MIRROR_MAX_BYTES, `mirror grew to ${readScreen(SID).length}`);
});

await test("the newest output survives truncation", () => {
  _resetForTest();
  recordOutput(SID, "OLD".repeat(MIRROR_MAX_BYTES));
  recordOutput(SID, "\nDo you want to proceed?\n 1. Yes\n 2. No\n");
  const screen = readScreen(SID);
  assert.match(screen, /1\. Yes/, "the current prompt is the whole point of the mirror");
  assert.ok(!screen.startsWith("OLD"), "old output must be the part that is dropped");
});

await test("a single oversized write is itself truncated to the tail", () => {
  _resetForTest();
  recordOutput(SID, "A".repeat(MIRROR_MAX_BYTES * 3) + "TAIL-MARKER");
  const screen = readScreen(SID);
  assert.ok(screen.length <= MIRROR_MAX_BYTES);
  assert.match(screen, /TAIL-MARKER$/);
});

/* ---- isolation + cleanup ---- */

await test("sessions do not share a mirror", () => {
  _resetForTest();
  recordOutput("s1", "first pane");
  recordOutput("s2", "second pane");
  assert.equal(readScreen("s1"), "first pane");
  assert.equal(readScreen("s2"), "second pane");
});

await test("forgetting a session frees its mirror", () => {
  _resetForTest();
  recordOutput("s1", "x");
  recordOutput("s2", "y");
  forgetScreen("s1");
  assert.equal(readScreen("s1"), "");
  assert.equal(readScreen("s2"), "y");
});

await test("forgetting an unknown session is harmless", () => {
  _resetForTest();
  forgetScreen("nope");
  forgetScreen(undefined);
  assert.ok(true);
});

/* ---- a clear-screen must actually clear ---- */

await test("an erase-display sequence drops everything written before it", () => {
  _resetForTest();
  // Without this the mirror is an append-only log: an answered prompt stays in it forever,
  // so the post-answer check reports "still on screen" and the card never clears.
  recordOutput(SID, "Do you want to proceed?\n 1. Yes\n 2. No\nEnter to select · Esc to cancel\n");
  recordOutput(SID, "\x1b[2J\x1b[H$ ls\nfile.txt\n$ ");
  const screen = readScreen(SID);
  assert.ok(!screen.includes("Do you want"), "the old prompt survived a clear-screen");
  assert.match(screen, /file\.txt/);
});

await test("clear-to-end-of-screen also resets the mirror", () => {
  _resetForTest();
  recordOutput(SID, "old prompt here\n 1. Yes\n");
  recordOutput(SID, "\x1b[Jfresh output\n");
  assert.ok(!readScreen(SID).includes("old prompt"));
});

await test("leaving the alternate screen resets the mirror", () => {
  _resetForTest();
  // A full-screen TUI exits with ?1049l; whatever it drew is gone from the display.
  recordOutput(SID, "Do you want to proceed?\n 1. Yes\n");
  recordOutput(SID, "\x1b[?1049l$ ");
  assert.ok(!readScreen(SID).includes("Do you want"));
});

await test("a clear mid-frame keeps only what follows it", () => {
  _resetForTest();
  recordOutput(SID, "before\x1b[2Jafter");
  assert.equal(readScreen(SID), "after");
});

await test("the LAST clear in a frame wins", () => {
  _resetForTest();
  recordOutput(SID, "one\x1b[2Jtwo\x1b[2Jthree");
  assert.equal(readScreen(SID), "three");
});

await test("ordinary erase-line sequences do not wipe the mirror", () => {
  _resetForTest();
  // Redrawing a line is routine — a selector repaints constantly. Treating \x1b[K as a
  // clear would erase the very prompt we need to see.
  recordOutput(SID, "Do you want to proceed?\n 1. Yes\n 2. No\n");
  recordOutput(SID, "\x1b[K 2. No\n");
  assert.match(readScreen(SID), /Do you want to proceed\?/);
});

/* ---- what the gate actually needs ---- */

await test("ANSI bytes are preserved for the caller to strip", () => {
  _resetForTest();
  recordOutput(SID, "\x1b[31mDo you want to proceed?\x1b[0m\n 1. Yes\n 2. No\n");
  assert.ok(readScreen(SID).includes("\x1b[31m"), "the mirror stores raw bytes; stripping is the responder's job");
});

await test("a real selector survives a burst of unrelated output before it", () => {
  _resetForTest();
  for (let i = 0; i < 50; i++) recordOutput(SID, `build step ${i} done\n`);
  recordOutput(SID, "Do you want to proceed?\n 1. Yes\n 2. No\nEnter to select · Esc to cancel\n");
  const screen = readScreen(SID);
  assert.match(screen, /Do you want to proceed\?/);
  assert.match(screen, /Enter to select/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
