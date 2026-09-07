// Global shortcuts for the workspace shell (desktop browsers only).
// Mod+Shift is the one namespace the browser mostly leaves free and the terminal never
// claims. Mod+Shift+T/N/W are reserved by every browser (preventDefault cannot stop them)
// so they stay out of this table.

// `code` matches the physical key (layout-independent); `key` is for named keys.
export const SHORTCUTS = [
  { id: "sessionPrev", key: "ArrowLeft", label: "Previous terminal", mac: "Opt ←", pc: "Ctrl+Shift+←" },
  { id: "sessionNext", key: "ArrowRight", label: "Next terminal", mac: "Opt →", pc: "Ctrl+Shift+→" },
  { id: "palette", code: "KeyP", label: "Search files", mac: "⌘⇧P", pc: "Ctrl+Shift+P" },
  { id: "newTerminal", key: "Enter", label: "New terminal", mac: "⌘⇧↵", pc: "Ctrl+Shift+Enter" },
  { id: "toggleSidebar", code: "KeyB", label: "Toggle sidebar", mac: "⌘⇧B", pc: "Ctrl+Shift+B" },
  { id: "help", code: "Slash", label: "Keyboard shortcuts", mac: "⌘⇧/", pc: "Ctrl+Shift+/" }
];

// Mod+Shift+1..9 jumps to the Nth terminal of the active workspace.
export const SESSION_INDEX_SHORTCUT = {
  id: "sessionIndex",
  label: "Go to terminal 1–9",
  mac: "Opt 1…9",
  pc: "Ctrl+Shift+1…9"
};

// Display order: session index sits after the prev/next pair — the three are one group.
export const SHORTCUT_ROWS = [
  SHORTCUTS[0], SHORTCUTS[1], SESSION_INDEX_SHORTCUT, ...SHORTCUTS.slice(2)
];

const DIGIT_CODE = /^Digit([1-9])$/;

// Which modifier the VIEWING device's keyboard actually has — this is a browser-level
// chord, so it follows the machine in front of the user, never the agent's platform.
// iPadOS Safari reports platform "MacIntel" but its keyboards carry Ctrl, not Cmd, so
// userAgentData (which says "iOS"/"Windows"/…) wins wherever it exists.
let macCache = null;

export const isMac = () => {
  if (macCache !== null) return macCache;
  if (typeof navigator === "undefined") return false; // SSR: don't cache a guess
  const modern = navigator.userAgentData?.platform;
  macCache = modern
    ? modern === "macOS"
    : /Mac/.test(navigator.platform || "") && navigator.maxTouchPoints <= 1;
  return macCache;
};

export const shortcutLabel = (entry) => (isMac() ? entry.mac : entry.pc);

// Keycap style shared by the shortcuts modal and the settings pane.
export const SHORTCUT_KEY_CLS = "inline-flex h-6 min-w-6 items-center justify-center px-1.5 font-mono text-xs font-medium text-text leading-none select-none bg-surface-2 border border-border border-b-2 rounded-md shadow-[inset_0_-1px_0_rgba(0,0,0,0.08)] whitespace-nowrap";

const MAC_MODIFIERS = new Set(["⌘", "⌥", "⇧", "⌃"]);

// "⌘⇧P" → ["⌘","⇧","P"]; "Opt ←" → ["Opt","←"]; "Ctrl+Shift+P" → ["Ctrl","Shift","P"] — one keycap each.
export function shortcutKeys(entry) {
  const label = shortcutLabel(entry);
  if (label.includes("+")) return label.split("+");
  const keys = [];
  let rest = label;
  if (rest.startsWith("Opt ")) { keys.push("Opt"); rest = rest.slice(4); }
  let i = 0;
  while (i < rest.length && MAC_MODIFIERS.has(rest[i])) { keys.push(rest[i]); i++; }
  if (i < rest.length) keys.push(rest.slice(i));
  return keys;
}

// Editable target — but xterm's hidden helper textarea is the terminal itself, not a form field.
const isEditableTarget = (target) => {
  if (!target || typeof target.closest !== "function") return false;
  if (target.closest(".xterm")) return false;
  return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA";
};

// Returns { id, index? } for a Mod+Shift chord (or Option chord on macOS), or null.
export function matchShortcut(event) {
  const mac = isMac();

  // On macOS, terminal tab switching uses Option (⌥1..9, ⌥←, ⌥→)
  if (mac && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
    const digit = DIGIT_CODE.exec(event.code) || (/^[1-9]$/.test(event.key) ? [null, event.key] : null);
    if (digit) return { id: SESSION_INDEX_SHORTCUT.id, index: Number(digit[1]) - 1 };
    if (event.key === "ArrowLeft") return { id: "sessionPrev" };
    if (event.key === "ArrowRight") return { id: "sessionNext" };
    return null;
  }

  if (!event.shiftKey || !(event.metaKey || event.ctrlKey) || event.altKey) return null;
  // On macOS Cmd is the modifier; elsewhere Ctrl — never both.
  if (mac ? !event.metaKey : !event.ctrlKey) return null;

  // On PC, digit chord is Ctrl+Shift+1..9
  if (!mac) {
    const digit = DIGIT_CODE.exec(event.code);
    if (digit) return { id: SESSION_INDEX_SHORTCUT.id, index: Number(digit[1]) - 1 };
  }

  const editable = isEditableTarget(event.target);
  for (const entry of SHORTCUTS) {
    if (mac && (entry.id === "sessionPrev" || entry.id === "sessionNext")) continue;
    const hit = entry.code ? event.code === entry.code : event.key === entry.key;
    if (!hit) continue;
    if (entry.skipInInput && editable) return null;
    return { id: entry.id };
  }
  return null;
}

// "New terminal · ⌘⇧↵" for a button tooltip. Falls back to the bare label when the
// action has no chord, so callers never have to branch.
export function withHint(label, shortcutId) {
  const entry = SHORTCUTS.find((s) => s.id === shortcutId);
  if (!entry) return label;
  return `${label} · ${shortcutLabel(entry)}`;
}

// Tooltip hint for the Nth terminal tab (0-based). Only 1-9 are reachable by chord.
export function tabIndexHint(index) {
  if (index < 0 || index > 8) return null;
  return isMac() ? `Opt ${index + 1}` : `Ctrl+Shift+${index + 1}`;
}
