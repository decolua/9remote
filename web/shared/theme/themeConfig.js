// Single source of truth for theme palette (used by JS - xterm, canvas, etc.)
// CSS components should use semantic tokens from globals.css instead.

export const THEME_KEYS = ["dark", "light"];
export const DEFAULT_THEME = "light";
export const STORAGE_KEY = "app_theme";

export const THEME_PALETTE = {
  dark: {
    bg: "#1a1a1a",
    surface: "#262626",
    surface2: "#303030",
    border: "#333333",
    text: "#ededed",
    textMuted: "#9ca3af",
    textSubtle: "#6b7280",
    accent: "#FF570A",
    danger: "#ef4444",
    success: "#22c55e",
  },
  light: {
    bg: "#FCFBF9",
    surface: "#F8FAFC",
    surface2: "#eef0f3",
    border: "#e5e7eb",
    text: "#000000",
    textMuted: "#6B7280",
    textSubtle: "#9CA3AF",
    accent: "#FF570A",
    danger: "#cf222e",
    success: "#10B981",
  },
};

// XTerm theme — map semantic palette to xterm.js theme schema
export const TERMINAL_THEMES = {
  dark: {
    background: THEME_PALETTE.dark.bg,
    foreground: THEME_PALETTE.dark.text,
    cursor: THEME_PALETTE.dark.accent,
    cursorAccent: THEME_PALETTE.dark.bg,
    selectionBackground: "#3a3a3a",
    black: "#21222c",
    red: "#ff5555",
    green: "#50fa7b",
    yellow: "#f1fa8c",
    blue: "#bd93f9",
    magenta: "#ff79c6",
    cyan: "#8be9fd",
    white: "#f8f8f2",
    brightBlack: "#6272a4",
    brightRed: "#ff6e6e",
    brightGreen: "#69ff94",
    brightYellow: "#ffffa5",
    brightBlue: "#d6acff",
    brightMagenta: "#ff92df",
    brightCyan: "#a4ffff",
    brightWhite: "#ffffff",
  },
  light: {
    background: THEME_PALETTE.light.bg,
    foreground: "#1a1a1a",
    cursor: THEME_PALETTE.light.accent,
    cursorAccent: THEME_PALETTE.light.bg,
    selectionBackground: "#fde2d6",
    black: "#24292f",
    red: "#cf222e",
    green: "#116329",
    yellow: "#4d2d00",
    blue: "#0969da",
    magenta: "#8250df",
    cyan: "#1b7c83",
    white: "#6e7781",
    brightBlack: "#57606a",
    brightRed: "#a40e26",
    brightGreen: "#1a7f37",
    brightYellow: "#633c01",
    brightBlue: "#218bff",
    brightMagenta: "#a475f9",
    brightCyan: "#3192aa",
    brightWhite: "#8c959f",
  },
};
