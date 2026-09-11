// effectiveFontSize drives both the xterm pane and the AI pane — they must agree.
// Run: node web/test/terminalFontSize.test.mjs
import assert from "node:assert/strict";
import { effectiveFontSize, TERMINAL_OPTIONS, MOBILE_FONT_BREAKPOINT } from "../features/terminal/constants/terminalConfig.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

test("explicit setting wins on any viewport", () => {
  assert.equal(effectiveFontSize(16), 16);
  assert.equal(effectiveFontSize(10), 10);
});

// Node has no `window` — the helper must fall back rather than throw.
test("no setting and no window falls back to the desktop default", () => {
  assert.equal(effectiveFontSize(null), TERMINAL_OPTIONS.fontSize);
});

test("no setting follows the viewport breakpoint", () => {
  global.window = { innerWidth: MOBILE_FONT_BREAKPOINT - 1 };
  assert.equal(effectiveFontSize(null), TERMINAL_OPTIONS.fontSizeMobile);
  global.window = { innerWidth: MOBILE_FONT_BREAKPOINT };
  assert.equal(effectiveFontSize(null), TERMINAL_OPTIONS.fontSize);
  delete global.window;
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
