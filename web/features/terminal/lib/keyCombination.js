import { SPECIAL_KEYS, CTRL_ARROW_KEYS } from "@/features/terminal/constants/keyMappings";

// Shift+Arrow escape sequences (CSI 1;2 <dir>).
const SHIFT_ARROWS = {
  ArrowUp: "\x1b[1;2A",
  ArrowDown: "\x1b[1;2B",
  ArrowRight: "\x1b[1;2C",
  ArrowLeft: "\x1b[1;2D"
};

// Ctrl + punctuation control codes that don't follow the A-Z ⇒ code-64 rule.
const CTRL_PUNCT = {
  "[": "\x1b",
  "]": "\x1d",
  "\\": "\x1c",
  "@": "\x00",
  "?": "\x7f"
};

/**
 * Key + active modifiers → the exact bytes to write to the PTY.
 * Pure: the caller supplies the modifier state, nothing is read from React.
 * Extracted verbatim from MobileKeyboard.generateCombination — the branch order
 * is load-bearing (Ctrl+single-char is checked before Alt, and before the
 * Ctrl+SPECIAL_KEYS branch).
 */
export function generateCombination(key, { ctrl = false, alt = false, shift = false } = {}) {
  if (ctrl && key.length === 1) {
    const upperKey = key.toUpperCase();
    const charCode = upperKey.charCodeAt(0);
    // A-Z → control code (Ctrl+A = 0x01 … Ctrl+Z = 0x1a)
    if (charCode >= 65 && charCode <= 90) return String.fromCharCode(charCode - 64);
    return CTRL_PUNCT[key] ?? key;
  }

  if (alt) {
    if (SPECIAL_KEYS[key]) return "\x1b" + SPECIAL_KEYS[key];
    if (key.length === 1) return "\x1b" + key;
    return SPECIAL_KEYS[key] || key;
  }

  if (ctrl && SPECIAL_KEYS[key]) {
    if (key.startsWith("Arrow")) return CTRL_ARROW_KEYS[key] || SPECIAL_KEYS[key];
    if (key === "Home") return "\x1b[1;5H";
    if (key === "End") return "\x1b[1;5F";
    return SPECIAL_KEYS[key];
  }

  if (shift && SPECIAL_KEYS[key]) {
    if (key === "Tab") return "\x1b[Z";
    if (key.startsWith("Arrow")) return SHIFT_ARROWS[key] || SPECIAL_KEYS[key];
    return SPECIAL_KEYS[key];
  }

  if (shift && key.length === 1) return key.toUpperCase();

  return SPECIAL_KEYS[key] || key;
}
