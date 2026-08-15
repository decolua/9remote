// Turns a GUI decision into TUI keystrokes, gated by what is actually on screen.
//
// Injecting a key into a waiting CLI is a ONE-WAY operation: a wrong key can grant a
// permission or pick a plan branch that cannot be taken back. Every helper here fails
// closed — when the screen does not clearly show the prompt we expect, we send nothing.
import { PROMPT_KINDS, KEYS, MAX_NUMBERED_OPTIONS } from "./constants.js";

// CSI / OSC / single-char escapes. The screen tail is raw PTY bytes.
const ANSI_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[[\]()#;?]*[0-9;]*[A-Za-z]|\x1b./g;

export function stripAnsi(text) {
  if (!text) return "";
  return String(text).replace(ANSI_RE, "");
}

// Wording every Claude-family selector shows while it waits for a choice.
const WAIT_MARKERS = [
  "do you want", "would you like", "ready to code", "select", "choose",
  "proceed", "permission", "approve", "allow",
];

// The selector's own chrome — the navigation footer it prints regardless of what language
// the model's question is in. This is what keeps non-English prompts answerable.
const SELECTOR_CHROME = [
  /enter\s*to\s*select/i,
  /esc\s*to\s*cancel/i,
  /to\s*navigate/i,
];

/**
 * How many numbered options the screen currently offers, counted from "1." upward.
 *
 * The separator after the number is optional: a terminal re-flowing a selector can leave
 * "2.Label" with no space. Requiring one undercounted real menus, and every choice past
 * the first was then refused as "not on screen".
 */
export function countVisibleOptions(screen) {
  const text = stripAnsi(screen);
  if (!text) return 0;
  let count = 0;
  for (let n = 1; n <= MAX_NUMBERED_OPTIONS; n++) {
    // Normally the number opens its line, so prose like "Step 1.Do the thing" is not a
    // menu entry. But xterm reflow can merge the question, the box border and option 1
    // onto a single row — there the selection caret is what marks the option, mid-line.
    const atLineStart = new RegExp(`^[^\\S\\n]*(?:❯|>|\\*|•)?[^\\S\\n]*${n}[.)][^\\S\\n]*\\S`, "m");
    const afterCaret = new RegExp(`[❯▶►][^\\S\\n]*${n}[.)][^\\S\\n]*\\S`);
    if (!atLineStart.test(text) && !afterCaret.test(text)) break;
    count = n;
  }
  return count;
}

const wantsDeny = (choice) => choice?.action === "deny" || choice?.action === "skip";

const numberKey = (index) => {
  if (!Number.isInteger(index) || index < 1 || index > MAX_NUMBERED_OPTIONS) return null;
  return String(index);
};

function planQuestion(choice, toolInput, optionCount) {
  if (wantsDeny(choice)) return [KEYS.ESCAPE];
  const answers = choice?.answers;
  if (!Array.isArray(answers) || answers.length === 0) return null;

  const questions = toolInput?.questions;
  const questionCount = questions?.length;
  if (questionCount && answers.length !== questionCount) return null;

  const keys = [];
  for (let i = 0; i < answers.length; i++) {
    const a = answers[i] || {};
    const isLast = i === answers.length - 1;

    if (a.text != null) {
      // "Type something." sits below the model's own options, so its number depends on how
      // many the screen currently shows. Without a verified count we would be guessing at
      // a row that is somebody's real answer.
      if (!isLast) return null;
      const text = String(a.text).trim();
      if (!text) return null;
      // A newline would commit the input early and drop the rest into the next prompt.
      if (/[\r\n]/.test(text)) return null;
      const ownOptions = questions?.[i]?.options?.length || 0;
      if (!Number.isInteger(optionCount) || optionCount <= ownOptions) return null;
      const typeKey = numberKey(ownOptions + 1);
      if (!typeKey) return null;
      keys.push(typeKey, text);
      break;
    }

    // Toggling several rows in one question needs a key sequence we have not verified.
    if (a.optionIndexes) return null;
    const key = numberKey(a.optionIndex);
    if (!key) return null;
    keys.push(key);
    // No navigation key between answers: choosing an option advances the selector by
    // itself, so a Tab here would skip a question and misplace the following answer.
  }

  // After the last answer the cursor sits on the "✔ Submit" tab — Enter presses it.
  keys.push(KEYS.ENTER);
  return keys;
}

/**
 * Ordered keystrokes for a decision, or null when we refuse to guess.
 * `optionCount` is how many rows the screen really shows — required for a typed answer,
 * whose row number depends on it.
 */
export function planKeystrokes({ kind, choice, toolInput, optionCount } = {}) {
  if (!kind || !choice) return null;

  if (kind === PROMPT_KINDS.QUESTION) return planQuestion(choice, toolInput, optionCount);

  if (wantsDeny(choice)) return [KEYS.ESCAPE];

  if (kind === PROMPT_KINDS.PLAN) {
    // The plan menu's option count and order vary between Claude builds — an implicit
    // "allow" would pick whatever happens to be first. Require an explicit index.
    const key = numberKey(choice.optionIndex);
    return key ? [key] : null;
  }

  if (kind === PROMPT_KINDS.PERMISSION) {
    if (choice.optionIndex != null) {
      const key = numberKey(choice.optionIndex);
      return key ? [key] : null;
    }
    return choice.action === "allow" ? ["1"] : null;
  }

  return null;
}

/**
 * Does the screen still show a selector waiting for input?
 *
 * A numbered list alone is not enough — `ls | cat -n` would qualify. What proves a wait is
 * the selector's own chrome: its navigation footer, or the fixed wording of a permission
 * or plan menu. The model's question itself can be in any language, so it is never what we
 * match on; doing so locked non-English prompts out entirely.
 */
function looksLikeWait(screen, kind) {
  const clean = stripAnsi(screen);
  const text = clean.toLowerCase();
  if (!text) return false;
  if (countVisibleOptions(screen) < 1) return false;
  if (SELECTOR_CHROME.some((re) => re.test(clean))) return true;
  if (WAIT_MARKERS.some((m) => text.includes(m))) return true;
  return kind === PROMPT_KINDS.QUESTION && text.includes("?");
}

/**
 * Strict gate: may we send this choice right now?
 * Returns { ok, optionCount, reason }. Anything unclear resolves to ok:false.
 */
export function screenMatchesPrompt(screen, prompt, choice) {
  if (!screen || !prompt?.kind) return { ok: false, optionCount: 0, reason: "no screen" };
  if (!looksLikeWait(screen, prompt.kind)) return { ok: false, optionCount: 0, reason: "screen is not showing a prompt" };

  const optionCount = countVisibleOptions(screen);
  // ESC works whatever the menu looks like, so a deny needs no bounds check.
  if (wantsDeny(choice)) return { ok: true, optionCount, reason: null };

  // A typed answer targets the selector's own "Type something." row, whose number is
  // derived from optionCount at plan time — there is no user-chosen index to bound here.
  const firstAnswer = Array.isArray(choice?.answers) ? choice.answers[0] : null;
  if (firstAnswer?.text != null) return { ok: true, optionCount, reason: null };

  // Only the FIRST question's options are on screen right now; later steps appear after
  // we advance, so they cannot be bounds-checked here.
  const indexes = Array.isArray(choice?.answers)
    ? choice.answers.slice(0, 1).map((a) => a?.optionIndex)
    : [choice?.optionIndex ?? (prompt.kind === PROMPT_KINDS.PERMISSION && choice?.action === "allow" ? 1 : null)];

  if (!indexes.length || indexes.some((i) => i == null)) {
    return { ok: false, optionCount, reason: "no option selected" };
  }
  for (const index of indexes) {
    if (index < 1 || index > optionCount) {
      return { ok: false, optionCount, reason: `option ${index} is not on screen (${optionCount} available)` };
    }
  }
  return { ok: true, optionCount, reason: null };
}

/** After sending: is the prompt still up? true means the keys did not take effect. */
export function promptStillPresent(screen, prompt) {
  if (!screen || !prompt?.kind) return false;
  return looksLikeWait(screen, prompt.kind);
}
