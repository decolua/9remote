// TDD for the terminal-screen parser: raw PTY bytes → structured JSON events.
//
// Three extraction strategies were measured against a real 131KB Claude session capture:
//   A) strip ANSI, keep lines — loses all spacing (terminal positions with column jumps)
//   B) 1-D column grid per line — keeps spacing, misses vertical overwrites
//   C) full 2-D grid — what the screen actually shows; older frames are overwritten
// The parser uses C (that is the truth of "what is on screen"), and the design keeps the
// strategy swappable per CLI.
//
// The shape is provider-neutral so other CLIs plug in by supplying markers, not by
// rewriting the pipeline: { kind, tool, summary, output?, status? }.
// Run: node agent/test/terminalScreenParse.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseScreen, applyScreenStream } from "../features/agentChat/screenParser.js";
import { CLAUDE_PROFILE } from "../features/agentChat/cliProfiles.js";

let pass = 0, fail = 0;
const test = (name, fn) =>
  Promise.resolve().then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "claude-session.raw");
const fixture = fs.existsSync(FIXTURE) ? fs.readFileSync(FIXTURE, "utf8") : "";

/* ================= the grid: correctness of the screen reconstruction ================= */

await test("plain text passes through", () => {
  assert.equal(parseScreen("hello", CLAUDE_PROFILE), "hello");
});

await test("colour codes vanish but the text survives", () => {
  assert.equal(parseScreen("\x1b[31mred\x1b[0m text", CLAUDE_PROFILE), "red text");
});

await test("a newline becomes a real line break", () => {
  assert.equal(parseScreen("one\ntwo", CLAUDE_PROFILE), "one\ntwo");
});

await test("carriage return rewinds the line, not a new one", () => {
  // Spinners and progress lines rewrite themselves with \r.
  assert.equal(parseScreen("abc\rX", CLAUDE_PROFILE), "Xbc");
});

await test("column jump (CUF) pads with spaces", () => {
  // Claude positions text: ESC[15G means "write at column 15".
  assert.equal(parseScreen("⏺\x1b[15Gx", CLAUDE_PROFILE), "⏺             x");
});

await test("column jump back (CUB) overwrites what is there", () => {
  assert.equal(parseScreen("abcdef\x1b[3DXY", CLAUDE_PROFILE), "abcXYf");
});

await test("absolute column (CHA) positions precisely", () => {
  assert.equal(parseScreen("aaaa\x1b[2Gb", CLAUDE_PROFILE), "abaa");
});

await test("cursor down then up lands where it started", () => {
  assert.equal(parseScreen("one\n\x1b[1A!", CLAUDE_PROFILE), "!ne");
});

await test("row moves reach the right line", () => {
  assert.equal(parseScreen("aa\nbb\ncc\x1b[2AX", CLAUDE_PROFILE), "aaX\nbb\ncc");
});

await test("home (ESC[H) restarts the grid", () => {
  assert.equal(parseScreen("one\ntwo\x1b[H*", CLAUDE_PROFILE), "*ne\ntwo");
});

await test("CUP (ESC[r;cH) addresses any cell", () => {
  assert.equal(parseScreen("xxxx\nyyyy\x1b[2;3HZ", CLAUDE_PROFILE), "xxxx\nyyZy");
});

await test("erase to end of line drops the tail", () => {
  assert.equal(parseScreen("hello world\x1b[6G\x1b[K!", CLAUDE_PROFILE), "hello!");
});

await test("erase whole line empties it", () => {
  assert.equal(parseScreen("keep\nwipe me\x1b[2G\x1b[2Kx", CLAUDE_PROFILE), "keep\n x");
});

await test("erase to start of line blanks the head", () => {
  assert.equal(parseScreen("abcdef\x1b[4G\x1b[1K", CLAUDE_PROFILE), "    ef");
});

await test("erase below the cursor clears those rows", () => {
  assert.equal(parseScreen("a\nb\nc\x1b[1;1H\x1b[0J", CLAUDE_PROFILE), "");
});

await test("erase-display (2J) empties everything", () => {
  assert.equal(parseScreen("old\x1b[2J\x1b[Hnew", CLAUDE_PROFILE), "new");
});

await test("erase-display keeps the cursor position", () => {
  // xterm: ED does not move the cursor. "ab", clear, "c" writes over position 2.
  assert.equal(parseScreen("ab\x1b[2Jc", CLAUDE_PROFILE), "  c");
});

await test("scroll region (DECSTBM) is accepted without corrupting output", () => {
  // Claude's status line uses scroll regions; we only require that parsing continues.
  const out = parseScreen("a\x1b[10;20rb", CLAUDE_PROFILE);
  assert.match(out, /a/);
  assert.match(out, /b/);
});

await test("OSC titles (BEL- and ST-terminated) are dropped", () => {
  assert.equal(parseScreen("\x1b]0;my title\x07visible", CLAUDE_PROFILE), "visible");
  assert.equal(parseScreen("\x1b]0;t\x1b\\visible", CLAUDE_PROFILE), "visible");
});

await test("cursor show/hide produces no text", () => {
  assert.equal(parseScreen("a\x1b[?25lb\x1b[?25h", CLAUDE_PROFILE), "ab");
});

await test("wide CJK characters count as one cell, not skipped", () => {
  // Vietnamese and CJK are common in this product; a byte-wise parser garbles them.
  assert.equal(parseScreen(" tiếng Việt ", CLAUDE_PROFILE), " tiếng Việt");
});

await test("an emoji does not corrupt the following cells", () => {
  assert.ok(parseScreen("a🔧b", CLAUDE_PROFILE).includes("a") && parseScreen("a🔧b", CLAUDE_PROFILE).includes("b"));
});

/* ================= the alternate screen ================= */

await test("entering the alt screen starts a blank grid", () => {
  assert.equal(parseScreen("shell\x1b[?1049hTUI content", CLAUDE_PROFILE), "TUI content");
});

await test("leaving the alt screen restores nothing of it", () => {
  // What a full-screen TUI drew is gone once it exits — that is the truth of the screen.
  assert.equal(parseScreen("\x1b[?1049hmenu\x1b[?1049l$ ", CLAUDE_PROFILE), "$");
});

await test("the alt screen ignores erase-display as a content reset", () => {
  // A TUI redraws constantly; treating its 2J as "conversation changed" would be wrong.
  const out = parseScreen("\x1b[?1049hlist\x1b[2J\x1b[Hlist2", CLAUDE_PROFILE);
  assert.equal(out, "list2");
});

/* ================= extraction: provider-neutral events ================= */

await test("an assistant turn line is extracted with its text", () => {
  const ev = applyScreenStream("⏺ Đã commit xong việc cần làm\n", CLAUDE_PROFILE);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, "assistant");
  assert.match(ev[0].text, /Đã commit/);
});

await test("a tool call line yields name and summary", () => {
  const ev = applyScreenStream("⏺ Bash(git status --short)\n", CLAUDE_PROFILE);
  assert.equal(ev[0].kind, "tool");
  assert.equal(ev[0].tool, "Bash");
  assert.match(ev[0].summary, /git status/);
});

await test("a tool result line attaches to the previous call", () => {
  const ev = applyScreenStream("⏺ Bash(ls)\n  ⎿  file.txt\n", CLAUDE_PROFILE);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].output, "file.txt");
});

await test("a result marked as an error keeps that status", () => {
  const ev = applyScreenStream("⏺ Bash(false)\n  ⎿  exit 1 (199ms) ✗\n", CLAUDE_PROFILE);
  assert.equal(ev[0].status, "error");
});

await test("a running tool shows as running", () => {
  const ev = applyScreenStream("⏺ Bash(npm test)\n  ⎿  Waiting…\n", CLAUDE_PROFILE);
  assert.equal(ev[0].status, "running");
});

await test("a plain prompt line is the input indicator", () => {
  const ev = applyScreenStream("❯ type here", CLAUDE_PROFILE);
  assert.equal(ev[0].kind, "input");
});

await test("the spinner glyph and its verb are the working indicator", () => {
  const ev = applyScreenStream("✻ Thinking… (12s · 300 tokens)", CLAUDE_PROFILE);
  assert.equal(ev[0].kind, "working");
  assert.equal(ev[0].verb, "Thinking");
});

await test("consecutive result lines join into one output block", () => {
  const ev = applyScreenStream("⏺ Bash(ls)\n  ⎿  a\n  ⎿  b\n", CLAUDE_PROFILE);
  assert.equal(ev[0].output, "a\nb");
});

await test("a permission menu is a prompt event with its options", () => {
  const ev = applyScreenStream(
    "Do you want to proceed?\n  1. Yes\n  2. Yes, and don't ask again\n  3. No\n",
    CLAUDE_PROFILE
  );
  assert.equal(ev[0].kind, "prompt");
  assert.equal(ev[0].options.length, 3);
});

await test("the selector footer identifies a prompt even in another language", () => {
  const ev = applyScreenStream(
    "File a.txt vừa tạo — xử sao?❯ 1. Giữ\n2. Xóa\n3. Đổi nội dung\nEnter to select · Esc to cancel\n",
    CLAUDE_PROFILE
  );
  assert.equal(ev[0].kind, "prompt");
  assert.equal(ev[0].options.length, 3);
});

await test("numbered ls output is NOT a prompt", () => {
  const ev = applyScreenStream("1. package.json\n2. README.md\n$ ", CLAUDE_PROFILE);
  assert.equal(ev.filter((e) => e.kind === "prompt").length, 0);
});

await test("a tool line with no parenthesis still parses", () => {
  const ev = applyScreenStream("⏺ Read\n  ⎿  30 lines\n", CLAUDE_PROFILE);
  assert.equal(ev[0].tool, "Read");
});

await test("events come out in screen order", () => {
  const ev = applyScreenStream("⏺ one\n⏺ two\n", CLAUDE_PROFILE);
  assert.deepEqual(ev.map((e) => e.text || e.tool), ["one", "two"]);
});

await test("empty input produces no events", () => {
  assert.deepEqual(applyScreenStream("", CLAUDE_PROFILE), []);
  assert.deepEqual(applyScreenStream("   \n\n", CLAUDE_PROFILE), []);
});

/* ================= unknown future marker: degrade, never crash ================= */

await test("an unknown marker line still yields an event", () => {
  // CLI updates add glyphs; dropping lines hides conversation.
  const ev = applyScreenStream("◈ some new thing\n", CLAUDE_PROFILE);
  assert.equal(ev[0].kind, "text");
});

await test("garbage bytes never throw", () => {
  for (const junk of ["\x1b", "\x1b[", "\x1b[999999999999", "\udc80\udc00", "\x00\x01"]) {
    assert.doesNotThrow(() => parseScreen(junk, CLAUDE_PROFILE));
    assert.doesNotThrow(() => applyScreenStream(junk, CLAUDE_PROFILE));
  }
});

await test("a profile with no markers extracts nothing, silently", () => {
  // Another CLI's terminal must not accidentally match Claude's glyphs.
  const bare = { markers: {} };
  const ev = applyScreenStream("⏺ Đã commit\n  ⎿  ok\n", bare);
  assert.equal(ev.length, 0);
});

/* ================= noise discipline: the parser must be readable, not just correct ================= */

await test("consecutive unknown lines merge into one text block", () => {
  // Terminal wrapping splits one sentence across rows; one-event-per-line buried the
  // conversation under dozens of fragments on the real capture.
  const ev = applyScreenStream("Switched to a new branch 'feat/age\nnt-chat-gui'\n", CLAUDE_PROFILE);
  assert.equal(ev.length, 1);
  assert.match(ev[0].text, /Switched to a new branch 'feat\/age\nnt-chat-gui'/);
});

await test("a marker line closes the running text block", () => {
  const ev = applyScreenStream("plain line\n⏺ Bash(ls)\n", CLAUDE_PROFILE);
  assert.deepEqual(ev.map((e) => e.kind), ["text", "tool"]);
  assert.equal(ev[0].text, "plain line");
});

await test("the status bar is dropped entirely", () => {
  // Fixed chrome: mode indicator, update notice, footer hints. Never conversation.
  const chrome = [
    "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
    "  ✘ Auto-update failed · Run claude doctor",
  ];
  const ev = applyScreenStream(chrome.join("\n") + "\nreal text\n", CLAUDE_PROFILE);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].text, "real text");
});

await test("a collapse indicator marks the preceding block as truncated", () => {
  const ev = applyScreenStream("some output\n… +43 lines (ctrl+o to expand)\n", CLAUDE_PROFILE);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].truncated, 43);
});

await test("a diff block is recognised as a diff, not prose", () => {
  const ev = applyScreenStream("⏺ Edit(screenParser.js)\n  ⎿  Updated\n@@ -1,3 +1,4 @@\n context\n-removed\n+added\n", CLAUDE_PROFILE);
  const diff = ev.find((e) => e.kind === "diff");
  assert.ok(diff, "diff lines read as prose make file changes invisible");
  assert.match(diff.text, /-removed/);
  assert.match(diff.text, /\+added/);
});

await test("a diff with no open tool is still a diff block", () => {
  const ev = applyScreenStream("--- a/file.js\n+++ b/file.js\n@@ -10,3 +10,4 @@\n-new\n+newer\n", CLAUDE_PROFILE);
  assert.equal(ev.find((e) => e.kind === "diff") != null, true);
});

await test("a result line continues the tool it belongs to, not a new block", () => {
  const ev = applyScreenStream("⏺ Bash(ls)\n  ⎿  file1\nfile2 continues\n", CLAUDE_PROFILE);
  const tool = ev.find((e) => e.kind === "tool");
  assert.match(tool.output, /file1/);
  assert.match(tool.output, /file2 continues/);
});

/* ================= against the real capture ================= */

if (fixture) {
  await test("real capture: reconstructs a readable screen", () => {
    const screen = parseScreen(fixture, CLAUDE_PROFILE);
    assert.ok(screen.length > 500, `screen too small: ${screen.length}`);
    // The capture contains a git commit; the screen must show it happened.
    assert.match(screen, /feat\(terminal\): chat GUI|76fe1ff|feat\/agent-chat-gui/);
  });

  await test("real capture: the final frame's tool calls are extracted", () => {
    // The grid holds the CURRENT screen only — scrolled-off turns are gone by design.
    // This capture's final frame still shows the git-commit call and its result.
    const ev = applyScreenStream(parseScreen(fixture, CLAUDE_PROFILE), CLAUDE_PROFILE);
    const tools = ev.filter((e) => e.kind === "tool");
    assert.ok(tools.length >= 2, `expected the visible tool calls, got ${tools.length}`);
    assert.ok(tools.some((e) => e.tool === "Bash"));
    const bash = tools.find((e) => e.tool === "Bash");
    assert.match(bash.summary, /git/, "the summary must carry the command");
  });

  await test("real capture: spacing survives (the 1-word smear bug)", () => {
    // Strip-only parsing smears words together; the grid must keep the spaces. The
    // input line still on screen carries Vietnamese with real word spacing.
    const screen = parseScreen(fixture);
    assert.match(screen, /làm phần thanh trạng thái đi/, "word spacing was lost — the grid is not positioning text correctly");
    const ev = applyScreenStream(screen, CLAUDE_PROFILE);
    // The capture holds several earlier input lines; the Vietnamese one is the latest.
    const input = ev.filter((e) => e.kind === "input").at(-1);
    assert.match(input?.text || "", /làm phần thanh trạng thái đi/);
  });

  await test("real capture: no leftover escape sequences in the screen", () => {
    const screen = parseScreen(fixture, CLAUDE_PROFILE);
    assert.equal(screen.split("\x1b").length - 1, 0, "ESC bytes leaked through the grid");
  });

  await test("real capture: the permission question is not missed when present", () => {
    // The capture has no menu right now; when one IS on screen the parser must see it.
    const withMenu = fixture + "\nDo you want to proceed?\n  1. Yes\n  2. No\nEnter to select · Esc to cancel\n";
    const ev = applyScreenStream(withMenu, CLAUDE_PROFILE);
    assert.ok(ev.some((e) => e.kind === "prompt"), "a live permission menu went unnoticed");
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
