// TDD for the CLIENT-side screen parser.
//
// Why client: the browser already owns the real terminal — xterm's buffer is an exact,
// colour-preserving grid. Parsing here drops the hand-written terminal emulator, keeps
// colour as a signal (glyphs change between CLI builds; roles are colour-coded), and
// sees full scrollback instead of an 8KB tail.
//
// Architecture (config-driven, class-based, one pattern per line — no overlaps):
//   XtermScreenReader   — reads term.buffer.active into ScreenLine[] {text, fgRuns}
//   CliProfile (base)   — declares `detect` hints + ordered `rules`; subclasses fill data
//   ClaudeProfile       — Claude Code's glyphs, colours, chrome
//   detectCli           — tries profiles in priority order, first to hit its hint quota wins
//   ScreenEventExtractor— runs a profile's rules over the lines → JSON events
//
// Everything is testable without xterm: the reader takes any object shaped like
// term.buffer.active, and profiles are pure data + pure functions.
// Run: node web/test/agentChatClientParse.test.mjs
import assert from "node:assert/strict";

const { XtermScreenReader } = await import("../features/agentChat/lib/screen/screenReader.js");
const { CliProfile } = await import("../features/agentChat/lib/screen/CliProfile.js");
const { ClaudeProfile } = await import("../features/agentChat/lib/screen/profiles/claude.js");
const { GenericProfile } = await import("../features/agentChat/lib/screen/profiles/generic.js");
const { detectCli } = await import("../features/agentChat/lib/screen/detector.js");
const { ScreenEventExtractor } = await import("../features/agentChat/lib/screen/extractor.js");

let pass = 0, fail = 0;
const test = (name, fn) =>
  Promise.resolve().then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });

/* ── harness: a buffer shaped like xterm's ─────────────────────────────── */

// rows: array of arrays of cells; cell = string | {ch, fg}
function fakeTerm(rows, { cols = 80 } = {}) {
  return {
    buffer: {
      active: {
        length: rows.length,
        getLine: (y) => {
          if (y < 0 || y >= rows.length) return undefined;
          const cells = rows[y].map((c) => (typeof c === "string" ? { ch: c, fg: null } : c));
          return {
            isWrapped: false,
            translateToString: (trimRight) => {
              const s = cells.map((c) => c.ch).join("");
              return trimRight ? s.replace(/\s+$/, "") : s;
            },
            getCell: (x) => (x < cells.length ? cells[x] : { ch: "", fg: null, getChars: () => cells[x]?.ch || "" }),
            _cells: cells,
          };
        },
      },
    },
    cols,
  };
}
const row = (text, fg = null) => text.split("").map((ch) => ({ ch, fg }));
// A Claude block row exactly as captured live: the marker painted grey.
const block = (text) => text.split("").map((ch) => ({ ch, fg: ch === "⏺" ? CLAUDE_GREY : null }));
const CLAUDE_GREY = 102;      // the grey Claude paints its markers with (observed live)
const CLAUDE_WARM = 215;      // spinner verb colour

/* ══ 1. the reader ══════════════════════════════════════════════════════ */

await test("reads plain lines of text", () => {
  const term = fakeTerm([row("hello"), row("world")]);
  const lines = new XtermScreenReader(term).readLines();
  assert.deepEqual(lines.map((l) => l.text), ["hello", "world"]);
});

await test("trims trailing whitespace per line", () => {
  const term = fakeTerm([row("kept   ")]);
  const lines = new XtermScreenReader(term).readLines();
  assert.equal(lines[0].text, "kept");
});

await test("captures colour runs — a marker's colour is a role signal", () => {
  const term = fakeTerm([[{ ch: "⏺", fg: CLAUDE_GREY }, { ch: " ", fg: null }, ...row("Bash(ls)", CLAUDE_GREY)]]);
  const lines = new XtermScreenReader(term).readLines();
  assert.deepEqual(lines[0].fgRuns, [
    { fg: CLAUDE_GREY, text: "⏺" },
    { fg: null, text: " " },
    { fg: CLAUDE_GREY, text: "Bash(ls)" },
  ]);
});

await test("a uniform colour collapses to one run", () => {
  const term = fakeTerm([row("everything grey", CLAUDE_GREY)]);
  assert.deepEqual(new XtermScreenReader(term).readLines()[0].fgRuns, [{ fg: CLAUDE_GREY, text: "everything grey" }]);
});

await test("blank lines read as empty text", () => {
  const term = fakeTerm([row(""), row(""), row("x")]);
  const lines = new XtermScreenReader(term).readLines();
  assert.deepEqual(lines.map((l) => l.text), ["", "", "x"]);
});

await test("a dead terminal or empty buffer reads as nothing", () => {
  assert.deepEqual(new XtermScreenReader(null).readLines(), []);
  assert.deepEqual(new XtermScreenReader({ buffer: { active: { length: 0, getLine: () => undefined } } }).readLines(), []);
});

await test("reading is bounded — a runaway scrollback cannot pin the tab", () => {
  const many = Array.from({ length: 5000 }, (_, i) => row(`line ${i}`));
  const term = fakeTerm(many);
  const lines = new XtermScreenReader(term, { maxLines: 400 }).readLines();
  assert.ok(lines.length <= 400);
  assert.match(lines[lines.length - 1].text, /line 4999/, "the newest lines are the ones kept");
});

await test("out-of-range rows are skipped, not fatal", () => {
  const term = fakeTerm([row("a")]);
  term.buffer.active.getLine = (y) => (y === 0 ? { isWrapped: false, translateToString: () => "a", getCell: () => ({ ch: "a", fg: null }) } : undefined);
  assert.doesNotThrow(() => new XtermScreenReader(term).readLines());
});

/* ══ 2. profiles: config, not code ══════════════════════════════════════ */

await test("ClaudeProfile is a CliProfile carrying ordered rules", () => {
  const p = new ClaudeProfile();
  assert.ok(p instanceof CliProfile);
  assert.ok(Array.isArray(p.rules) && p.rules.length > 0, "rules come from config");
  assert.ok(p.rules.every((r) => r.name && typeof r.match === "function" && typeof r.run === "function"));
});

await test("GenericProfile has no rules — it claims nothing", () => {
  const p = new GenericProfile();
  assert.equal(p.rules.length, 0);
});

/* ══ 3. detection: which CLI owns this screen ═══════════════════════════ */

const CLAUDE_SCREEN = [
  row(""),
  row("  ⏺ Bash(git status)", CLAUDE_GREY),
  row("  ⎿  clean", CLAUDE_GREY),
  row("✻ Baking… (45s · 300 tokens)", CLAUDE_WARM),
  row("❯ make something"),
  row("  ⏵⏵ bypass permissions on (shift+tab to cycle)"),
];
const SHELL_SCREEN = [
  row("$ ls"),
  row("file.txt  src"),
  row("$ "),
];
const VIM_SCREEN = [
  row("~"),
  row("~"),
  row("agentChat.js", CLAUDE_GREY),
  row("-- INSERT --"),
];

await test("a Claude screen is detected as claude", () => {
  assert.equal(detectCli(new XtermScreenReader(fakeTerm(CLAUDE_SCREEN)).readLines())?.id, "claude");
});

await test("a plain shell is not detected as claude", () => {
  const found = detectCli(new XtermScreenReader(fakeTerm(SHELL_SCREEN)).readLines());
  assert.equal(found, null);
});

await test("vim is not detected as claude despite a grey line", () => {
  // Detection needs SEVERAL distinct hints — one coincidence must not claim the screen.
  assert.equal(detectCli(new XtermScreenReader(fakeTerm(VIM_SCREEN)).readLines()), null);
});

await test("an empty screen detects nothing", () => {
  assert.equal(detectCli([])?.id ?? detectCli([]), null);
});

await test("colour boosts detection when glyphs alone are ambiguous", () => {
  // The marker painted Claude-grey is worth more than the same glyph in default colour.
  const greyMarker = [[{ ch: "⏺", fg: CLAUDE_GREY }, ...row(" text")], ...VIM_SCREEN.slice(1)];
  assert.equal(detectCli(new XtermScreenReader(fakeTerm(greyMarker)).readLines())?.id, "claude");
});

/* ══ 4. extraction: one pattern per line, no overlaps ═══════════════════ */

// Event-shape tests run the Claude profile directly — single-line screens would never
// reach the detection quota, which the detection tests cover on their own.
const extract = (rows) => {
  const lines = new XtermScreenReader(fakeTerm(rows)).readLines();
  return new ScreenEventExtractor(new ClaudeProfile()).extract(lines);
};

await test("a tool call line becomes a tool event with name and summary", () => {
  const ev = extract([block("  ⏺ Bash(git status --short)")]);
  assert.equal(ev[0].kind, "tool");
  assert.equal(ev[0].tool, "Bash");
  assert.match(ev[0].summary, /git status/);
});

await test("a result line attaches to its tool, not a new event", () => {
  const ev = extract([
    block("  ⏺ Bash(ls)"),
    row("  ⎿  file.txt"),
  ]);
  assert.equal(ev.length, 1);
  assert.match(ev[0].output, /file\.txt/);
});

await test("assistant prose is a separate kind from tool calls", () => {
  const ev = extract([
    block("  ⏺ Đã commit xong việc cần làm."),
    block("  ⏺ Bash(ls)"),
  ]);
  assert.deepEqual(ev.map((e) => e.kind), ["assistant", "tool"]);
  assert.match(ev[0].text, /Đã commit/);
});

await test("the spinner line is the working indicator", () => {
  const ev = extract([row("✻ Baking… (45s · 300 tokens)", CLAUDE_WARM)]);
  assert.equal(ev[0].kind, "working");
  assert.equal(ev[0].verb, "Baking");
});

await test("the input line is an input event", () => {
  const ev = extract([row("❯ làm phần thanh trạng thái")]);
  assert.equal(ev[0].kind, "input");
  assert.match(ev[0].text, /làm phần/);
});

await test("the status bar produces no event at all", () => {
  const ev = extract([
    row("  ⏵⏵ bypass permissions on (shift+tab to cycle)"),
    row("  ✘ Auto-update failed · Run claude doctor"),
  ]);
  assert.equal(ev.length, 0);
});

await test("a permission menu becomes a prompt event with options", () => {
  const ev = extract([
    row("Do you want to proceed?"),
    row("  1. Yes"),
    row("  2. No"),
    row("Enter to select · Esc to cancel"),
  ]);
  assert.equal(ev[0].kind, "prompt");
  assert.deepEqual(ev[0].options.map((o) => o.label), ["Yes", "No"]);
  assert.equal(ev[0].question, "Do you want to proceed?");
});

await test("consecutive unknown lines merge into one text block", () => {
  const ev = extract([
    row("Switched to a new branch 'feat/age"),
    row("nt-chat-gui'"),
  ]);
  assert.equal(ev.length, 1);
  assert.match(ev[0].text, /feat\/age\nnt-chat-gui/);
});

await test("a diff body becomes a diff event", () => {
  const ev = extract([
    row("@@ -10,3 +10,4 @@"),
    row("-removed"),
    row("+added"),
    row(" context"),
  ]);
  assert.equal(ev[0].kind, "diff");
  assert.match(ev[0].text, /-removed/);
  assert.match(ev[0].text, /\+added/);
});

await test("an unknown CLI extracts nothing — generic claims no patterns", () => {
  const lines = new XtermScreenReader(fakeTerm(SHELL_SCREEN)).readLines();
  const ev = new ScreenEventExtractor(new GenericProfile()).extract(lines);
  // The generic profile has no rules, so only its fallback shape applies — and it is
  // configured to claim nothing rather than guess at unknown CLIs.
  assert.deepEqual(ev, []);
});

await test("events preserve screen order", () => {
  const ev = extract([
    block("  ⏺ first"),
    block("  ⏺ Bash(two)"),
    block("  ⏺ third"),
  ]);
  assert.deepEqual(ev.map((e) => e.kind), ["assistant", "tool", "assistant"]);
});

await test("empty input yields no events", () => {
  assert.deepEqual(extract([]), []);
  assert.deepEqual(extract([row(""), row("")]), []);
});

/* ══ 5. pattern discipline: no two rules claim the same line ════════════ */

await test("each rule matches a distinct shape — patterns do not overlap", () => {
  const p = new ClaudeProfile();
  // Feed each rule its canonical sample plus every other rule's sample: a sample that
  // two different rules both match is an overlap and will break extraction ordering.
  const samples = {
    spinner: [row("✻ Baking… (45s)", CLAUDE_WARM)],
    result: [block("  ⏺ Bash(ls)"), row("  ⎿  out")],
    assistantTool: [block("  ⏺ Bash(git st)")],
    assistantProse: [block("  ⏺ prose here")],
    input: [row("❯ typed")],
    statusBar: [row("  ⏵⏵ bypass permissions on")],
    menuOption: [row("Do you want?"), row("  1. Yes")],
  };
  const ctxFor = (rows) => {
    const extractor = new ScreenEventExtractor(p);
    const lines = new XtermScreenReader(fakeTerm(rows)).readLines();
    return { extractor, lines };
  };
  for (const [owner, rows] of Object.entries(samples)) {
    const { extractor, lines } = ctxFor(rows);
    for (const line of lines) {
      const hits = p.rules.filter((r) => {
        try { return r.match({ line, text: line.text, state: extractor.newState() }) !== false; } catch { return false; }
      });
      const owners = hits.map((r) => r.name);
      // fallback legitimately matches everything; a non-fallback rule must own its line alone
      const nonFallback = owners.filter((n) => n !== "fallback");
      assert.ok(
        nonFallback.length <= 1,
        `line "${line.text.slice(0, 40)}" claimed by ${JSON.stringify(nonFallback)} (expected ≤1, sample owner: ${owner})`
      );
    }
  }
});

await test("a rule may consult colour, not just glyphs", () => {
  // Same glyph, different colour → different event. Colour is the stable signal.
  const grey = extract([[{ ch: "⏺", fg: CLAUDE_GREY }, ...row(" Bash(x)", CLAUDE_GREY )]]);
  const plain = extract([[{ ch: "⏺", fg: null }, ...row(" Bash(x)")]]);
  assert.equal(grey[0]?.kind, "tool");
  // A grey-painted marker is a Claude block; the same glyph unpainted is ordinary text.
  assert.notEqual(plain[0]?.kind, "tool");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
