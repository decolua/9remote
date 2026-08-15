// Unit tests for the responder: turning a GUI decision into TUI keystrokes, and the
// strict screen-buffer gate that must pass before any key is sent.
// Injecting a key is a ONE-WAY operation — these tests encode "refuse when unsure".
// Run: node agent/test/agentChatResponder.test.mjs
import assert from "node:assert/strict";

const {
  planKeystrokes, stripAnsi, screenMatchesPrompt, countVisibleOptions, promptStillPresent,
} = await import("../features/agentChat/responder.js");
const { PROMPT_KINDS, KEYS } = await import("../features/agentChat/constants.js");

let pass = 0, fail = 0;
const test = (name, fn) =>
  Promise.resolve().then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });

/* ---- ANSI stripping: the screen tail is raw PTY bytes ---- */

await test("strips SGR colour codes", () => {
  assert.equal(stripAnsi("\x1b[31mDo you want\x1b[0m to proceed?"), "Do you want to proceed?");
});

await test("strips cursor movement and erase sequences", () => {
  assert.equal(stripAnsi("\x1b[2J\x1b[H\x1b[Khello\x1b[1;5H"), "hello");
});

await test("strips OSC title sequences terminated by BEL or ST", () => {
  assert.equal(stripAnsi("\x1b]0;title\x07body"), "body");
  assert.equal(stripAnsi("\x1b]0;title\x1b\\body"), "body");
});

await test("leaves plain text untouched", () => {
  assert.equal(stripAnsi("1. Yes\n2. No"), "1. Yes\n2. No");
});

/* ---- keystroke planning ---- */

await test("permission allow sends a single '1'", () => {
  assert.deepEqual(planKeystrokes({ kind: PROMPT_KINDS.PERMISSION, choice: { action: "allow" } }), ["1"]);
});

await test("permission deny sends ESC", () => {
  assert.deepEqual(planKeystrokes({ kind: PROMPT_KINDS.PERMISSION, choice: { action: "deny" } }), [KEYS.ESCAPE]);
});

await test("permission allow honours an explicit option number", () => {
  assert.deepEqual(planKeystrokes({ kind: PROMPT_KINDS.PERMISSION, choice: { action: "allow", optionIndex: 2 } }), ["2"]);
});

await test("plan requires an explicit option index — never a blind '1'", () => {
  // Orca's bug: Allow always sent "1" while the plan menu really has 3 options.
  assert.equal(planKeystrokes({ kind: PROMPT_KINDS.PLAN, choice: { action: "allow" } }), null);
  assert.deepEqual(planKeystrokes({ kind: PROMPT_KINDS.PLAN, choice: { optionIndex: 2 } }), ["2"]);
});

await test("plan deny sends ESC", () => {
  assert.deepEqual(planKeystrokes({ kind: PROMPT_KINDS.PLAN, choice: { action: "deny" } }), [KEYS.ESCAPE]);
});

await test("single question: number then Enter, as separate keys", () => {
  const keys = planKeystrokes({
    kind: PROMPT_KINDS.QUESTION,
    choice: { answers: [{ optionIndex: 2 }] },
    toolInput: { questions: [{ question: "q1", options: [{ label: "A" }, { label: "B" }] }] },
  });
  assert.deepEqual(keys, ["2", KEYS.ENTER]);
});

await test("multi question: picking an option auto-advances, so no navigation key is sent", () => {
  // The selector moves to the next question the moment a number is pressed. Sending Tab
  // as well would skip a question and land the following answer on the wrong one.
  const keys = planKeystrokes({
    kind: PROMPT_KINDS.QUESTION,
    choice: { answers: [{ optionIndex: 1 }, { optionIndex: 3 }] },
    toolInput: { questions: [
      { question: "q1", options: [{ label: "A" }, { label: "B" }] },
      { question: "q2", options: [{ label: "X" }, { label: "Y" }, { label: "Z" }] },
    ] },
  });
  assert.deepEqual(keys, ["1", "3", KEYS.ENTER]);
});

await test("three questions: three number keys, nothing between them", () => {
  const keys = planKeystrokes({
    kind: PROMPT_KINDS.QUESTION,
    choice: { answers: [{ optionIndex: 1 }, { optionIndex: 2 }, { optionIndex: 1 }] },
    toolInput: { questions: [
      { question: "a", options: [{ label: "1" }, { label: "2" }] },
      { question: "b", options: [{ label: "1" }, { label: "2" }] },
      { question: "c", options: [{ label: "1" }, { label: "2" }] },
    ] },
  });
  assert.deepEqual(keys, ["1", "2", "1", KEYS.ENTER]);
});

await test("question skip sends ESC", () => {
  assert.deepEqual(planKeystrokes({ kind: PROMPT_KINDS.QUESTION, choice: { action: "skip" } }), [KEYS.ESCAPE]);
});

await test("an option index beyond what number keys can reach is refused", () => {
  assert.equal(planKeystrokes({ kind: PROMPT_KINDS.PERMISSION, choice: { action: "allow", optionIndex: 10 } }), null);
});

await test("a zero or negative option index is refused", () => {
  assert.equal(planKeystrokes({ kind: PROMPT_KINDS.PERMISSION, choice: { action: "allow", optionIndex: 0 } }), null);
  assert.equal(planKeystrokes({ kind: PROMPT_KINDS.QUESTION, choice: { answers: [{ optionIndex: -1 }] } }), null);
});

await test("multi-select is refused — the TUI mapping is unproven", () => {
  const keys = planKeystrokes({
    kind: PROMPT_KINDS.QUESTION,
    choice: { answers: [{ optionIndexes: [1, 2] }] },
    toolInput: { questions: [{ question: "q", multiSelect: true, options: [{ label: "A" }, { label: "B" }] }] },
  });
  assert.equal(keys, null);
});

await test("a multi-select question answered with ONE option is allowed", () => {
  // Picking a single option is the same keystroke whether or not the question would also
  // accept several — refusing it locked out every multi-question set containing one.
  const keys = planKeystrokes({
    kind: PROMPT_KINDS.QUESTION,
    choice: { answers: [{ optionIndex: 2 }] },
    toolInput: { questions: [{ question: "q", multiSelect: true, options: [{ label: "A" }, { label: "B" }] }] },
  });
  assert.deepEqual(keys, ["2", KEYS.ENTER]);
});

await test("a mixed set — single-select then multi-select — is answerable", () => {
  const keys = planKeystrokes({
    kind: PROMPT_KINDS.QUESTION,
    choice: { answers: [{ optionIndex: 1 }, { optionIndex: 3 }] },
    toolInput: { questions: [
      { question: "q1", options: [{ label: "A" }, { label: "B" }, { label: "C" }] },
      { question: "q2", multiSelect: true, options: [{ label: "X" }, { label: "Y" }, { label: "Z" }] },
    ] },
  });
  assert.deepEqual(keys, ["1", "3", KEYS.ENTER]);
});

await test("no navigation key is inserted between answers", () => {
  // Picking an option moves the selector on by itself. The trailing Enter presses the
  // "✔ Submit" tab that the cursor lands on after the last answer.
  const keys = planKeystrokes({
    kind: PROMPT_KINDS.QUESTION,
    choice: { answers: [{ optionIndex: 1 }, { optionIndex: 1 }, { optionIndex: 2 }] },
    toolInput: { questions: [
      { question: "a", options: [{ label: "1" }, { label: "2" }] },
      { question: "b", options: [{ label: "1" }, { label: "2" }] },
      { question: "c", options: [{ label: "1" }, { label: "2" }] },
    ] },
  });
  assert.deepEqual(keys, ["1", "1", "2", KEYS.ENTER]);
});

/* ---- free text: the selector's own "Type something." entry ---- */

await test("a typed answer picks the Type-something entry, then types and commits", () => {
  // The selector's second-to-last row is "Type something." — choosing it opens an inline
  // input on the spot. optionCount tells us which number that row carries; it moves as the
  // model offers more or fewer choices, so it can never be hardcoded.
  const keys = planKeystrokes({
    kind: PROMPT_KINDS.QUESTION,
    choice: { answers: [{ text: "my own answer" }] },
    toolInput: { questions: [{ question: "q", options: [{ label: "A" }, { label: "B" }, { label: "C" }] }] },
    optionCount: 5,   // 3 model options + "Type something." + "Chat about this"
  });
  assert.deepEqual(keys, ["4", "my own answer", KEYS.ENTER]);
});

await test("a typed answer is refused when the screen was never read", () => {
  // Without a verified count we cannot know which number opens the input — guessing would
  // pick one of the model's own options instead.
  assert.equal(planKeystrokes({
    kind: PROMPT_KINDS.QUESTION,
    choice: { answers: [{ text: "custom" }] },
    toolInput: { questions: [{ question: "q", options: [{ label: "A" }] }] },
  }), null);
});

await test("a typed answer is refused when the menu has no room for the extra entries", () => {
  // optionCount must exceed the model's own options, or the row we would press is a
  // real answer rather than the input.
  assert.equal(planKeystrokes({
    kind: PROMPT_KINDS.QUESTION,
    choice: { answers: [{ text: "custom" }] },
    toolInput: { questions: [{ question: "q", options: [{ label: "A" }, { label: "B" }] }] },
    optionCount: 2,
  }), null);
});

await test("empty or whitespace typed text is refused", () => {
  const base = {
    kind: PROMPT_KINDS.QUESTION,
    toolInput: { questions: [{ question: "q", options: [{ label: "A" }] }] },
    optionCount: 3,
  };
  assert.equal(planKeystrokes({ ...base, choice: { answers: [{ text: "   " }] } }), null);
  assert.equal(planKeystrokes({ ...base, choice: { answers: [{ text: "" }] } }), null);
});

await test("typed text containing a newline is refused — it would submit early", () => {
  assert.equal(planKeystrokes({
    kind: PROMPT_KINDS.QUESTION,
    choice: { answers: [{ text: "line one\nrm -rf /" }] },
    toolInput: { questions: [{ question: "q", options: [{ label: "A" }] }] },
    optionCount: 3,
  }), null);
});

await test("typed text is only offered for the LAST question", () => {
  // Mid-set the selector auto-advances on selection; typing there has not been verified.
  assert.equal(planKeystrokes({
    kind: PROMPT_KINDS.QUESTION,
    choice: { answers: [{ text: "custom" }, { optionIndex: 1 }] },
    toolInput: { questions: [
      { question: "a", options: [{ label: "A" }] },
      { question: "b", options: [{ label: "B" }] },
    ] },
    optionCount: 3,
  }), null);
});

await test("a set ending in a typed answer works", () => {
  const keys = planKeystrokes({
    kind: PROMPT_KINDS.QUESTION,
    choice: { answers: [{ optionIndex: 2 }, { text: "something else" }] },
    toolInput: { questions: [
      { question: "a", options: [{ label: "A" }, { label: "B" }] },
      { question: "b", options: [{ label: "X" }, { label: "Y" }] },
    ] },
    optionCount: 4,   // 2 model options + the two selector entries
  });
  assert.deepEqual(keys, ["2", "3", "something else", KEYS.ENTER]);
});

await test("an unknown kind or empty choice is refused", () => {
  assert.equal(planKeystrokes({ kind: "wat", choice: { action: "allow" } }), null);
  assert.equal(planKeystrokes({ kind: PROMPT_KINDS.PERMISSION, choice: {} }), null);
  assert.equal(planKeystrokes({}), null);
});

/* ---- option counting: never hardcode how many buttons the menu has ---- */

await test("counts numbered options on the visible screen", () => {
  const screen = "Would you like to proceed?\n  1. Yes\n  2. Yes, and don't ask again\n  3. No, tell Claude what to do\n";
  assert.equal(countVisibleOptions(screen), 3);
});

await test("counts options written with a paren instead of a dot", () => {
  assert.equal(countVisibleOptions("1) Allow\n2) Deny\n"), 2);
});

await test("stops at the first gap — a stray '5.' further up is not an option", () => {
  assert.equal(countVisibleOptions("Read 5. something\n\n1. Yes\n2. No\n"), 2);
});

await test("returns 0 when nothing numbered is on screen", () => {
  assert.equal(countVisibleOptions("just some output\n"), 0);
});

await test("counts options when the terminal dropped the space after the number", () => {
  // Real capture from a Claude selector: xterm's line layout can leave no whitespace
  // between "2." and its label. Requiring a space here undercounted a 5-option menu as
  // 1, and every choice past the first was refused as "not on screen".
  const screen = [
    "1.Tiếp agentChat",
    "2.Dọn git status",
    "3.Hỏi đáp thôi",
    "4.Type something.",
    "5.Chat about this",
    "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
  ].join("\n");
  assert.equal(countVisibleOptions(screen), 5);
});

await test("counts options rendered with a selection caret", () => {
  assert.equal(countVisibleOptions("❯ 1. Yes\n  2. No\n"), 2);
  assert.equal(countVisibleOptions("❯1.Yes\n 2.No\n"), 2);
});

await test("a bare number with no label is not an option", () => {
  assert.equal(countVisibleOptions("1.\n2.\n"), 0, "an empty row is a rendering artifact, not a choice");
});

await test("a number inside prose still does not count", () => {
  assert.equal(countVisibleOptions("Step 1.Do the thing first\n\n1.Yes\n2.No\n"), 2);
});

await test("counts the first option when the terminal merged it onto the question's row", () => {
  // Real capture: xterm reflow put the box border, the question, the selection caret and
  // option 1 all on one row. Requiring the number to open its line counted zero options,
  // so the gate reported "screen is not showing a prompt" and refused every choice.
  const screen = [
    "──────── ☐ a.txt File a.txt vừa tạo ở Desktop — xử sao?❯ 1. Giữ   Để nguyên trên Desktop",
    "2.Xóa",
    "Xoáluôn,khôngcầnnữa",
    "3.Đổinộidung",
    "4.Typesomething.",
    "5.Chataboutthis",
    "Entertoselect·↑/↓tonavigate·Esctocancel",
  ].join("\n");
  assert.equal(countVisibleOptions(screen), 5);
});

await test("a caret mid-line marks an option even without a line break", () => {
  assert.equal(countVisibleOptions("Question here?❯ 1. Yes\n2. No\n"), 2);
});

await test("prose containing a number is still not promoted by the mid-line rule", () => {
  // "version 2.0" must not read as option 2 just because a caret appeared earlier.
  assert.equal(countVisibleOptions("Upgrade to version 2.0 now\n"), 0);
});

await test("a wrapped option label does not break the run", () => {
  const screen = "1.Keep going\n   with a wrapped second line\n2.Stop here\n";
  assert.equal(countVisibleOptions(screen), 2);
});

/* ---- the strict gate ---- */

const permScreen = "\x1b[1mBash command\x1b[0m\n  ls -la\n\nDo you want to proceed?\n  1. Yes\n  2. No, and tell Claude what to do differently\n";

await test("a real permission screen passes for a permission prompt", () => {
  const r = screenMatchesPrompt(permScreen, { kind: PROMPT_KINDS.PERMISSION }, { optionIndex: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.optionCount, 2);
});

await test("an ordinary shell prompt does NOT pass — the wait is already over", () => {
  const r = screenMatchesPrompt("$ ls\nfile.txt\n$ ", { kind: PROMPT_KINDS.PERMISSION }, { optionIndex: 1 });
  assert.equal(r.ok, false);
});

await test("an empty or missing screen never passes", () => {
  assert.equal(screenMatchesPrompt("", { kind: PROMPT_KINDS.PERMISSION }, { optionIndex: 1 }).ok, false);
  assert.equal(screenMatchesPrompt(null, { kind: PROMPT_KINDS.PERMISSION }, { optionIndex: 1 }).ok, false);
});

await test("choosing option 3 on a 2-option menu is refused", () => {
  const r = screenMatchesPrompt(permScreen, { kind: PROMPT_KINDS.PERMISSION }, { optionIndex: 3 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /option/i);
});

await test("deny needs no option bounds check — ESC always exists", () => {
  assert.equal(screenMatchesPrompt(permScreen, { kind: PROMPT_KINDS.PERMISSION }, { action: "deny" }).ok, true);
});

await test("a plan screen reports its real option count instead of assuming 3", () => {
  const planScreen = "Ready to code?\n  1. Yes, and auto-accept edits\n  2. Yes, and manually approve edits\n  3. No, keep planning\n";
  const r = screenMatchesPrompt(planScreen, { kind: PROMPT_KINDS.PLAN }, { optionIndex: 3 });
  assert.equal(r.ok, true);
  assert.equal(r.optionCount, 3);
});

await test("a plan menu that shrank to 2 options refuses the old option 3", () => {
  const shrunk = "Ready to code?\n  1. Yes\n  2. No, keep planning\n";
  assert.equal(screenMatchesPrompt(shrunk, { kind: PROMPT_KINDS.PLAN }, { optionIndex: 3 }).ok, false);
});

await test("a question screen passes when its options are on screen", () => {
  const qScreen = "Which database?\n  1. Postgres\n  2. MySQL\n  3. SQLite\n";
  assert.equal(screenMatchesPrompt(qScreen, { kind: PROMPT_KINDS.QUESTION }, { optionIndex: 2 }).ok, true);
});

await test("a question choice is read from `answers`, the shape the GUI actually sends", () => {
  const qScreen = "Which database?\n  1. Postgres\n  2. MySQL\n  3. SQLite\n";
  const r = screenMatchesPrompt(qScreen, { kind: PROMPT_KINDS.QUESTION }, { answers: [{ optionIndex: 2 }] });
  assert.equal(r.ok, true, "reading only optionIndex would reject every real question");
});

await test("a first answer beyond the visible options is refused", () => {
  const qScreen = "Which database?\n  1. Postgres\n  2. MySQL\n";
  assert.equal(screenMatchesPrompt(qScreen, { kind: PROMPT_KINDS.QUESTION }, { answers: [{ optionIndex: 5 }] }).ok, false);
});

await test("later steps are not bounds-checked — their options are not on screen yet", () => {
  const qScreen = "Which database?\n  1. Postgres\n  2. MySQL\n";
  const r = screenMatchesPrompt(qScreen, { kind: PROMPT_KINDS.QUESTION }, { answers: [{ optionIndex: 1 }, { optionIndex: 7 }] });
  assert.equal(r.ok, true);
});

await test("a selector in another language is still recognised as a wait", () => {
  // The question is the model's own words — it can be in any language. What identifies a
  // selector is its own chrome: numbered rows plus the navigation footer.
  const screen = [
    "File a.txt vừa tạo ở Desktop — xử sao?❯ 1. Giữ",
    "2.Xóa",
    "3.Đổinộidung",
    "Enter to select · ↑/↓ to navigate · Esc to cancel",
  ].join("\n");
  const r = screenMatchesPrompt(screen, { kind: PROMPT_KINDS.QUESTION }, { answers: [{ optionIndex: 2 }] });
  assert.equal(r.ok, true, "matching only English phrasing locks out every non-English prompt");
});

await test("a permission screen in another language is recognised by its footer", () => {
  const screen = "Bạn có muốn tiếp tục?\n 1. Có\n 2. Không\nEnter to select · Esc to cancel\n";
  assert.equal(screenMatchesPrompt(screen, { kind: PROMPT_KINDS.PERMISSION }, { action: "allow" }).ok, true);
});

await test("numbered output with no selector chrome is still not a prompt", () => {
  // `ls -1 | cat -n` style output must never look like a menu.
  const screen = "1. package.json\n2. README.md\n3. src\n$ ";
  assert.equal(screenMatchesPrompt(screen, { kind: PROMPT_KINDS.QUESTION }, { answers: [{ optionIndex: 1 }] }).ok, false);
});

await test("a real AskUserQuestion screen accepts a later option", () => {
  // Captured from a live session. The gate refused option 2 here because the counter
  // only saw one option — the user could read five on screen and none of them worked.
  const real = [
    "Giờ bạn muốn làm gì trên repo này?",
    "1.Tiếp agentChat",
    "2.Dọn git status",
    "3.Hỏi đáp thôi",
    "4.Type something.",
    "5.Chat about this",
    "",
    "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
  ].join("\n");
  const r = screenMatchesPrompt(real, { kind: PROMPT_KINDS.QUESTION }, { answers: [{ optionIndex: 2 }] });
  assert.equal(r.optionCount, 5);
  assert.equal(r.ok, true);
});

await test("verification runs on raw bytes — ANSI must not defeat the match", () => {
  const raw = "\x1b[2J\x1b[H\x1b[33mDo you want to proceed?\x1b[0m\r\n\x1b[36m 1. Yes\x1b[0m\r\n\x1b[36m 2. No\x1b[0m\r\n";
  assert.equal(screenMatchesPrompt(raw, { kind: PROMPT_KINDS.PERMISSION }, { optionIndex: 1 }).ok, true);
});

/* ---- post-send confirmation ---- */

await test("prompt gone from the screen → the keys landed", () => {
  assert.equal(promptStillPresent("$ ls\nfile.txt\n$ ", { kind: PROMPT_KINDS.PERMISSION }), false);
});

await test("prompt still on the screen → the keys did not land", () => {
  assert.equal(promptStillPresent(permScreen, { kind: PROMPT_KINDS.PERMISSION }), true);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
