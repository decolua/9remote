// Global shortcuts for the workspace shell (desktop browsers only).
// Mac: Option (⌥) for tabs/navigation, Option+Shift (⌥⇧) for shell actions, Ctrl+` for focus.
// PC: Ctrl+Shift for tabs/navigation/shell, Alt+W for close terminal, Ctrl+` for focus.

// `code` matches the physical key (layout-independent); `key` is for named keys.
export const SHORTCUTS = [
  { id: "sessionPrev", key: "ArrowLeft", label: "Previous terminal", mac: "⌥←", pc: "Ctrl+Shift+←" },
  { id: "sessionNext", key: "ArrowRight", label: "Next terminal", mac: "⌥→", pc: "Ctrl+Shift+→" },
  { id: "workspacePrev", key: "ArrowUp", label: "Previous workspace", mac: "⌥↑", pc: "Ctrl+Shift+↑" },
  { id: "workspaceNext", key: "ArrowDown", label: "Next workspace", mac: "⌥↓", pc: "Ctrl+Shift+↓" },
  { id: "closeTerminal", code: "KeyW", label: "Close terminal", mac: "⌥W", pc: "Alt+W" },
  { id: "fitPanes", key: "=", code: "Equal", label: "Auto-fit panes", mac: "⌥=", pc: "Ctrl+Shift+=" },
  { id: "toggleFocus", code: "Backquote", label: "Toggle terminal / input focus", mac: "⌃`", pc: "Ctrl+`" },
  { id: "newTerminal", key: "Enter", label: "New terminal", mac: "⌥⇧↵", pc: "Ctrl+Shift+Enter" },
  { id: "palette", code: "KeyP", label: "Search files", mac: "⌥⇧P", pc: "Ctrl+Shift+P" },
  { id: "toggleSidebar", code: "KeyB", label: "Toggle sidebar", mac: "⌥⇧B", pc: "Ctrl+Shift+B" },
  { id: "toggleRightPanel", code: "KeyJ", label: "Toggle side panel", mac: "⌥⇧J", pc: "Ctrl+Shift+J" },
  { id: "help", code: "Slash", label: "Keyboard shortcuts", mac: "⌥⇧/", pc: "Ctrl+Shift+/" }
];

// 1..9 jumps to the Nth terminal of the active workspace.
export const SESSION_INDEX_SHORTCUT = {
  id: "sessionIndex",
  label: "Go to terminal 1–9",
  mac: "⌥1…9",
  pc: "Ctrl+Shift+1…9"
};

// 1 row per distinct action: clear, readable, no visual clutter
export const SHORTCUT_ROWS = [
  { id: "switchTerminal", label: "Switch terminal", mac: "⌥← / →", pc: "Ctrl+Shift+← / →" },
  SESSION_INDEX_SHORTCUT,
  { id: "switchWorkspace", label: "Switch workspace", mac: "⌥↑ / ↓", pc: "Ctrl+Shift+↑ / ↓" },
  SHORTCUTS.find((s) => s.id === "newTerminal"),
  SHORTCUTS.find((s) => s.id === "closeTerminal"),
  SHORTCUTS.find((s) => s.id === "fitPanes"),
  SHORTCUTS.find((s) => s.id === "toggleFocus"),
  SHORTCUTS.find((s) => s.id === "toggleSidebar"),
  SHORTCUTS.find((s) => s.id === "toggleRightPanel"),
  SHORTCUTS.find((s) => s.id === "palette"),
  SHORTCUTS.find((s) => s.id === "help")
].filter(Boolean);

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

// Checks if target is inside a modal dialog (so typing in dialog fields does not trigger global shortcuts)
const isModalInput = (target) => {
  if (!target || typeof target.closest !== "function") return false;
  return Boolean(target.closest("[role=dialog]") || target.closest(".modal-overlay") || target.closest(".card-elev"));
};

// Editable target — but xterm's hidden helper textarea is the terminal itself, not a form field.
const isEditableTarget = (target) => {
  if (!target || typeof target.closest !== "function") return false;
  if (target.closest(".xterm")) return false;
  return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA";
};

// Returns { id, index? } for a shortcut event, or null.
export function matchShortcut(event) {
  const mac = isMac();

  // On macOS:
  // 1. Single Option: tabs, navigation, panes (⌥1..9, ⌥←, ⌥→, ⌥↑, ⌥↓, ⌥W, ⌥=, ⌥`)
  // Note: Option+W produces "∑" and Option+= produces "≠" on macOS keyboard layout
  if (mac && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
    const digit = DIGIT_CODE.exec(event.code) || (/^[1-9]$/.test(event.key) ? [null, event.key] : null);
    if (digit) return { id: SESSION_INDEX_SHORTCUT.id, index: Number(digit[1]) - 1 };
    if (event.key === "ArrowLeft") return { id: "sessionPrev" };
    if (event.key === "ArrowRight") return { id: "sessionNext" };
    if (event.key === "ArrowUp") return { id: "workspacePrev" };
    if (event.key === "ArrowDown") return { id: "workspaceNext" };
    if (isModalInput(event.target)) return null;
    if (event.code === "Backquote" || event.key === "`") {
      return { id: "toggleFocus" };
    }
    if (event.code === "Equal" || event.key === "=" || event.key === "≠" || event.key === "+") {
      return { id: "fitPanes" };
    }
    if (event.code === "KeyW" || event.key === "∑" || event.key?.toLowerCase() === "w") {
      return { id: "closeTerminal" };
    }
    return null;
  }

  // 2. Option+Shift on macOS: shell actions (⌥⇧↵ new terminal, ⌥⇧P palette, ⌥⇧B sidebar, ⌥⇧J side panel, ⌥⇧/ help)
  // Note: Option+Shift produces special characters (∏, ı, Ô, ¿) on macOS, so check both code and characters
  if (mac && event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey) {
    if (isModalInput(event.target)) return null;
    const editable = isEditableTarget(event.target);
    if (event.key === "Enter" || event.code === "Enter") return { id: "newTerminal" };
    if (editable) return null;
    if (event.code === "KeyP" || event.key === "π" || event.key === "∏" || event.key?.toLowerCase() === "p") {
      return { id: "palette" };
    }
    if (event.code === "KeyB" || event.key === "ı" || event.key === "∫" || event.key?.toLowerCase() === "b") {
      return { id: "toggleSidebar" };
    }
    if (event.code === "KeyJ" || event.key === "Ô" || event.key === "∆" || event.key?.toLowerCase() === "j") {
      return { id: "toggleRightPanel" };
    }
    if (event.code === "Slash" || event.key === "?" || event.key === "¿" || event.key === "/") {
      return { id: "help" };
    }
    return null;
  }

  // Ctrl+` toggles focus between terminal and command input (cross-platform)
  if (event.ctrlKey && !event.shiftKey && !event.metaKey && !event.altKey) {
    if (event.code === "Backquote" || event.key === "`") {
      if (!isModalInput(event.target)) return { id: "toggleFocus" };
    }
  }

  // On PC, Alt chords (Alt+W closes terminal, Alt+= auto-fits panes)
  if (!mac && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
    if (isModalInput(event.target)) return null;
    if (event.code === "Equal" || event.key === "=" || event.key === "+") {
      return { id: "fitPanes" };
    }
    if (event.code === "KeyW" || event.key?.toLowerCase() === "w") {
      return { id: "closeTerminal" };
    }
  }

  // On PC, Ctrl+Shift chords for tabs, navigation, and shell actions
  if (!mac && event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey) {
    const digit = DIGIT_CODE.exec(event.code);
    if (digit) return { id: SESSION_INDEX_SHORTCUT.id, index: Number(digit[1]) - 1 };
    if (event.key === "ArrowLeft") return { id: "sessionPrev" };
    if (event.key === "ArrowRight") return { id: "sessionNext" };
    if (event.key === "ArrowUp") return { id: "workspacePrev" };
    if (event.key === "ArrowDown") return { id: "workspaceNext" };
    if (event.code === "Equal" || event.key === "=" || event.key === "+") return { id: "fitPanes" };

    const editable = isEditableTarget(event.target);
    if (event.key === "Enter" || event.code === "Enter") return { id: "newTerminal" };
    if (editable) return null;
    if (event.code === "KeyP" || event.key?.toLowerCase() === "p") return { id: "palette" };
    if (event.code === "KeyB" || event.key?.toLowerCase() === "b") return { id: "toggleSidebar" };
    if (event.code === "KeyJ" || event.key?.toLowerCase() === "j") return { id: "toggleRightPanel" };
    if (event.code === "Slash" || event.key === "/" || event.key === "?") return { id: "help" };
  }

  return null;
}

// "New terminal · ⌥⇧↵" for a button tooltip. Falls back to the bare label when the
// action has no chord, so callers never have to branch.
export function withHint(label, shortcutId) {
  const entry = SHORTCUTS.find((s) => s.id === shortcutId);
  if (!entry) return label;
  return `${label} · ${shortcutLabel(entry)}`;
}

// Tooltip hint for the Nth terminal tab (0-based). Only 1-9 are reachable by chord.
export function tabIndexHint(index) {
  if (index < 0 || index > 8) return null;
  return isMac() ? `⌥${index + 1}` : `Ctrl+Shift+${index + 1}`;
}
