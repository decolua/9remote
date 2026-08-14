// Differential + characterization tests for the key-combination encoder extracted
// from MobileKeyboard. These bytes go straight to the PTY: a wrong branch means
// Ctrl+C stops killing the process, or arrows start inserting garbage.
// Run: node --import ./test/loader-alias.mjs web/test/keyCombination.test.mjs
import assert from "node:assert/strict";
import { SPECIAL_KEYS, CTRL_ARROW_KEYS } from "../features/terminal/constants/keyMappings.js";
import { generateCombination } from "../features/terminal/lib/keyCombination.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

// Original implementation, transcribed verbatim from git HEAD (MobileKeyboard).
function original(key, { ctrl = false, alt = false, shift = false } = {}) {
  let data = "";
  if (ctrl && key.length === 1) {
    const upperKey = key.toUpperCase();
    const charCode = upperKey.charCodeAt(0);
    if (charCode >= 65 && charCode <= 90) {
      data = String.fromCharCode(charCode - 64);
    }
    else if (key === "[") data = "\x1b";
    else if (key === "]") data = "\x1d";
    else if (key === "\\") data = "\x1c";
    else if (key === "@") data = "\x00";
    else if (key === "?") data = "\x7f";
    else data = key;
  }
  else if (alt) {
    if (SPECIAL_KEYS[key]) data = "\x1b" + SPECIAL_KEYS[key];
    else if (key.length === 1) data = "\x1b" + key;
    else data = SPECIAL_KEYS[key] || key;
  }
  else if (ctrl && SPECIAL_KEYS[key]) {
    if (key.startsWith("Arrow")) data = CTRL_ARROW_KEYS[key] || SPECIAL_KEYS[key];
    else if (key === "Home") data = "\x1b[1;5H";
    else if (key === "End") data = "\x1b[1;5F";
    else data = SPECIAL_KEYS[key];
  }
  else if (shift && SPECIAL_KEYS[key]) {
    if (key === "Tab") data = "\x1b[Z";
    else if (key.startsWith("Arrow")) {
      const arrowMap = {
        "ArrowUp": "\x1b[1;2A",
        "ArrowDown": "\x1b[1;2B",
        "ArrowRight": "\x1b[1;2C",
        "ArrowLeft": "\x1b[1;2D"
      };
      data = arrowMap[key] || SPECIAL_KEYS[key];
    } else data = SPECIAL_KEYS[key];
  }
  else if (shift && key.length === 1) data = key.toUpperCase();
  else data = SPECIAL_KEYS[key] || key;
  return data;
}

test("differential: every key × every modifier combo matches the original", () => {
  const keys = [
    ...Object.keys(SPECIAL_KEYS),
    ..."abcdefghijklmnopqrstuvwxyz".split(""),
    ..."ABCXYZ0189".split(""),
    "[", "]", "\\", "@", "?", "-", "/", " ", "é", "字", "", "unknownKey"
  ];
  let checked = 0, mismatches = [];
  for (const key of keys) {
    for (const ctrl of [false, true]) for (const alt of [false, true]) for (const shift of [false, true]) {
      const mods = { ctrl, alt, shift };
      const a = original(key, mods), b = generateCombination(key, mods);
      checked++;
      if (a !== b) mismatches.push(`${JSON.stringify(key)} ${JSON.stringify(mods)}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    }
  }
  assert.deepEqual(mismatches, [], `mismatches:\n${mismatches.slice(0, 5).join("\n")}`);
  assert.ok(checked > 200, `expected a wide sweep, ran ${checked}`);
  console.log(`      (${checked} combinations compared)`);
});

test("Ctrl+letter produces the control code, case-insensitively", () => {
  assert.equal(generateCombination("c", { ctrl: true }), "\x03", "Ctrl+C must be ETX or nothing gets killed");
  assert.equal(generateCombination("C", { ctrl: true }), "\x03");
  assert.equal(generateCombination("a", { ctrl: true }), "\x01");
  assert.equal(generateCombination("z", { ctrl: true }), "\x1a");
  assert.equal(generateCombination("d", { ctrl: true }), "\x04", "Ctrl+D = EOF");
});

test("Ctrl+punctuation maps to its legacy control code", () => {
  assert.equal(generateCombination("[", { ctrl: true }), "\x1b");
  assert.equal(generateCombination("]", { ctrl: true }), "\x1d");
  assert.equal(generateCombination("\\", { ctrl: true }), "\x1c");
  assert.equal(generateCombination("@", { ctrl: true }), "\x00");
  assert.equal(generateCombination("?", { ctrl: true }), "\x7f");
  assert.equal(generateCombination("-", { ctrl: true }), "-", "unmapped punctuation passes through");
});

test("Alt prefixes ESC (meta) for both chars and special keys", () => {
  assert.equal(generateCombination("b", { alt: true }), "\x1bb", "Alt+B = word-back in readline");
  assert.equal(generateCombination("Enter", { alt: true }), "\x1b" + SPECIAL_KEYS.Enter);
});

test("Alt wins over Ctrl when both are held (branch order is load-bearing)", () => {
  // The original checks `ctrl && single char` FIRST, so Ctrl+Alt+C is a control code.
  assert.equal(generateCombination("c", { ctrl: true, alt: true }), "\x03");
  // …but for a special key, Alt is checked before the Ctrl+SPECIAL branch.
  assert.equal(generateCombination("Enter", { ctrl: true, alt: true }), "\x1b" + SPECIAL_KEYS.Enter);
});

test("Ctrl+Arrow / Home / End use their CSI modifier forms", () => {
  assert.equal(generateCombination("ArrowLeft", { ctrl: true }), CTRL_ARROW_KEYS.ArrowLeft);
  assert.equal(generateCombination("Home", { ctrl: true }), "\x1b[1;5H");
  assert.equal(generateCombination("End", { ctrl: true }), "\x1b[1;5F");
});

test("Shift+Tab is back-tab; Shift+Arrow is the CSI 1;2 form", () => {
  assert.equal(generateCombination("Tab", { shift: true }), "\x1b[Z");
  assert.equal(generateCombination("ArrowUp", { shift: true }), "\x1b[1;2A");
  assert.equal(generateCombination("ArrowLeft", { shift: true }), "\x1b[1;2D");
});

test("Shift on a plain char upper-cases it; no modifier passes through", () => {
  assert.equal(generateCombination("a", { shift: true }), "A");
  assert.equal(generateCombination("a"), "a");
  assert.equal(generateCombination("Enter"), SPECIAL_KEYS.Enter);
  assert.equal(generateCombination("unknown"), "unknown");
});

test("no modifiers argument at all is safe", () => {
  assert.equal(generateCombination("a"), "a");
  assert.equal(generateCombination("ArrowUp"), SPECIAL_KEYS.ArrowUp);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
