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
    accent: "#E56A4A",
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

// Terminal palettes — herdr-style token map per theme. RGB values mirror
// .source/herdr/src/app/state.rs so the agent UI stays visually consistent.
// Each token object is compiled to an xterm.js theme via toXterm().
const TERMINAL_TOKENS = {
  // Default = Vesper (minimal high-contrast monochrome, peach + mint accents)
  vesperDark: {
    bg: "#1A1A1A", surface0: "#232323", surface1: "#2A2A2A", surfaceDim: "#101010",
    overlay0: "#5C5C5C", text: "#FFFFFF", subtext0: "#A0A0A0",
    red: "#FF8080", green: "#99FFE4", yellow: "#FFC799", blue: "#B0B0B0",
    mauve: "#FFD1A8", teal: "#66DDCC", peach: "#FFC799", accent: "#FFC799",
  },
  vesperLight: {
    bg: "#F5F5F5", surface0: "#E8E8E8", surface1: "#DDDDDD", surfaceDim: "#EFEFEF",
    overlay0: "#999999", text: "#1A1A1A", subtext0: "#5A5A5A",
    red: "#D9534F", green: "#2A9D8F", yellow: "#E07A3C", blue: "#6B6B6B",
    mauve: "#C97B5A", teal: "#3A9B8E", peach: "#E07A3C", accent: "#E07A3C",
  },
  catppuccinDark: {
    bg: "#181825", surface0: "#31324A", surface1: "#45475A", surfaceDim: "#1E1E2E",
    overlay0: "#6C708E", text: "#CDD6F4", subtext0: "#A6ADC8",
    red: "#F38BA8", green: "#A6E3A1", yellow: "#F9E2AF", blue: "#89B4FA",
    mauve: "#CBA7F7", teal: "#94E2D5", peach: "#FAB387", accent: "#89B4FA",
  },
  catppuccinLight: {
    bg: "#EFF1F5", surface0: "#CCD0DA", surface1: "#BCC0CC", surfaceDim: "#E6E9EF",
    overlay0: "#9CA0B0", text: "#4C4F69", subtext0: "#6C6F85",
    red: "#D20F39", green: "#40A02B", yellow: "#DF8E1D", blue: "#1E66F5",
    mauve: "#8839EF", teal: "#179299", peach: "#FE640B", accent: "#1E66F5",
  },
  kanagawaDark: {
    bg: "#1F1F28", surface0: "#2A2A37", surface1: "#363646", surfaceDim: "#1F1F28",
    overlay0: "#727169", text: "#DCD7BA", subtext0: "#C8C3AC",
    red: "#C34043", green: "#76946A", yellow: "#C0A36E", blue: "#7E9CD8",
    mauve: "#957FB8", teal: "#6A9589", peach: "#FFA066", accent: "#7E9CD8",
  },
  kanagawaLight: {
    bg: "#F2ECBC", surface0: "#DCD5AC", surface1: "#C9CBD1", surfaceDim: "#D5CEA3",
    overlay0: "#A09CAC", text: "#545464", subtext0: "#43436C",
    red: "#C84053", green: "#6F894E", yellow: "#77713F", blue: "#4D699B",
    mauve: "#624C83", teal: "#4E8CA2", peach: "#CC6D00", accent: "#4D699B",
  },
  tokyoNightDark: {
    bg: "#1A1B26", surface0: "#24283B", surface1: "#414868", surfaceDim: "#1A1B26",
    overlay0: "#565F89", text: "#C0CAF5", subtext0: "#A9B1D6",
    red: "#F7768E", green: "#9ECE6A", yellow: "#E0AF68", blue: "#7AA2F7",
    mauve: "#BB9AF7", teal: "#7DCFFF", peach: "#FF9E64", accent: "#7AA2F7",
  },
  tokyoNightLight: {
    bg: "#E1E2E7", surface0: "#C4C8DA", surface1: "#A8AECB", surfaceDim: "#D2D3DA",
    overlay0: "#8990B3", text: "#3760CF", subtext0: "#6172B0",
    red: "#F52A85", green: "#587539", yellow: "#8C6C43", blue: "#2E7DE9",
    mauve: "#7847BD", teal: "#118C74", peach: "#B15C00", accent: "#2E7DE9",
  },
  gruvboxDark: {
    bg: "#282828", surface0: "#3C3836", surface1: "#504945", surfaceDim: "#282828",
    overlay0: "#928374", text: "#EBDBB2", subtext0: "#D5C4A1",
    red: "#FB4934", green: "#B8BB26", yellow: "#FABD2F", blue: "#83A598",
    mauve: "#D3869B", teal: "#8EC07C", peach: "#FE8019", accent: "#FABD2F",
  },
  gruvboxLight: {
    bg: "#FBF1C7", surface0: "#EBDBB2", surface1: "#D5C4A1", surfaceDim: "#F2E5BC",
    overlay0: "#928374", text: "#3C3836", subtext0: "#504945",
    red: "#9D0006", green: "#79740E", yellow: "#B57614", blue: "#076678",
    mauve: "#8F3F71", teal: "#427B58", peach: "#AF3A03", accent: "#B57614",
  },
  oneDark: {
    bg: "#282C34", surface0: "#2C313A", surface1: "#3E4451", surfaceDim: "#282C34",
    overlay0: "#5C6370", text: "#ABB2BF", subtext0: "#9698A8",
    red: "#E06C75", green: "#98C379", yellow: "#E5C07B", blue: "#61AFEF",
    mauve: "#C678DD", teal: "#56B6C2", peach: "#D19A66", accent: "#61AFEF",
  },
  oneLight: {
    bg: "#FAFAFA", surface0: "#F0F0F1", surface1: "#E5E5E6", surfaceDim: "#F5F5F6",
    overlay0: "#A0A1A7", text: "#383A42", subtext0: "#686B77",
    red: "#E45649", green: "#50A14F", yellow: "#C18401", blue: "#4078F2",
    mauve: "#A626A4", teal: "#0184BC", peach: "#986801", accent: "#4078F2",
  },
  dracula: {
    bg: "#282A36", surface0: "#44475A", surface1: "#6272A4", surfaceDim: "#282A36",
    overlay0: "#6272A4", text: "#F8F8F2", subtext0: "#D2D2DC",
    red: "#FF5555", green: "#50FA7B", yellow: "#F1FA8C", blue: "#8BE9FD",
    mauve: "#FF79C6", teal: "#8BE9FD", peach: "#FFB86C", accent: "#BD93F9",
  },
  nord: {
    bg: "#2E3440", surface0: "#3B4252", surface1: "#434C5E", surfaceDim: "#2E3440",
    overlay0: "#4C566A", text: "#ECEFF4", subtext0: "#D8DEE9",
    red: "#BF616A", green: "#A3BE8C", yellow: "#EBCB8B", blue: "#81A1C1",
    mauve: "#B48EAD", teal: "#8FBCBB", peach: "#D08770", accent: "#88C0D0",
  },
  rosePineDark: {
    bg: "#191724", surface0: "#1F1D2E", surface1: "#26233A", surfaceDim: "#191724",
    overlay0: "#6E6A86", text: "#E0DEF4", subtext0: "#C8C5DC",
    red: "#EB6F92", green: "#31748F", yellow: "#F6C777", blue: "#31748F",
    mauve: "#C4A7E7", teal: "#9CCFD8", peach: "#EA9A97", accent: "#C4A7E7",
  },
  rosePineLight: {
    bg: "#FAF4ED", surface0: "#F2E9E1", surface1: "#FFFAF3", surfaceDim: "#F2E9E1",
    overlay0: "#9893A5", text: "#575279", subtext0: "#797593",
    red: "#B4637A", green: "#286983", yellow: "#EA9D34", blue: "#286983",
    mauve: "#908AA9", teal: "#56949F", peach: "#D7827E", accent: "#908AA9",
  },
  solarizedDark: {
    bg: "#002B36", surface0: "#073642", surface1: "#586E75", surfaceDim: "#002B36",
    overlay0: "#586E75", text: "#93A1A1", subtext0: "#839496",
    red: "#DC322F", green: "#859900", yellow: "#B58900", blue: "#268BD2",
    mauve: "#D33682", teal: "#2AA198", peach: "#CB4B16", accent: "#268BD2",
  },
  solarizedLight: {
    bg: "#FDF6E3", surface0: "#EEE8D5", surface1: "#93A1A1", surfaceDim: "#EEE8D5",
    overlay0: "#93A1A1", text: "#657B83", subtext0: "#839496",
    red: "#DC322F", green: "#859900", yellow: "#B58900", blue: "#268BD2",
    mauve: "#D33682", teal: "#2AA198", peach: "#CB4B16", accent: "#268BD2",
  },
};

// Compile a token palette into the xterm.js theme schema (ANSI 16 + chrome).
function toXterm(p) {
  return {
    background: p.bg,
    foreground: p.text,
    cursor: p.accent || p.peach || p.blue,
    cursorAccent: p.bg,
    selectionBackground: p.surface1,
    black: p.surfaceDim || p.bg,
    red: p.red,
    green: p.green,
    yellow: p.yellow,
    blue: p.blue,
    magenta: p.mauve,
    cyan: p.teal,
    white: p.subtext0 || p.text,
    brightBlack: p.overlay0,
    brightRed: p.red,
    brightGreen: p.green,
    brightYellow: p.yellow,
    brightBlue: p.blue,
    brightMagenta: p.mauve,
    brightCyan: p.teal,
    brightWhite: p.text,
  };
}

// Default xterm theme — Vesper (gray monochrome). Neutral fallback for each mode.
export const TERMINAL_THEMES = {
  dark: toXterm(TERMINAL_TOKENS.vesperDark),
  light: toXterm(TERMINAL_TOKENS.vesperLight),
};

// Named palettes — each key is ONE concrete palette with a single inherent mode.
// No dark/light pairing: a theme is either dark or light, never both.
export const TERMINAL_PALETTES = {
  catppuccinMocha: toXterm(TERMINAL_TOKENS.catppuccinDark),
  kanagawa:        toXterm(TERMINAL_TOKENS.kanagawaDark),
  tokyoNight:      toXterm(TERMINAL_TOKENS.tokyoNightDark),
  gruvbox:         toXterm(TERMINAL_TOKENS.gruvboxDark),
  oneDark:         toXterm(TERMINAL_TOKENS.oneDark),
  dracula:         toXterm(TERMINAL_TOKENS.dracula),
  nord:            toXterm(TERMINAL_TOKENS.nord),
  rosePine:        toXterm(TERMINAL_TOKENS.rosePineDark),
  solarizedDark:   toXterm(TERMINAL_TOKENS.solarizedDark),
  catppuccinLatte: toXterm(TERMINAL_TOKENS.catppuccinLight),
  kanagawaLotus:   toXterm(TERMINAL_TOKENS.kanagawaLight),
  tokyoNightDay:   toXterm(TERMINAL_TOKENS.tokyoNightLight),
  gruvboxLight:    toXterm(TERMINAL_TOKENS.gruvboxLight),
  oneLight:        toXterm(TERMINAL_TOKENS.oneLight),
  rosePineDawn:    toXterm(TERMINAL_TOKENS.rosePineLight),
  solarizedLight:  toXterm(TERMINAL_TOKENS.solarizedLight),
};

// Menu options — each entry is one mode only. The menu renders the "Default"
// (Vesper) entry unconditionally, then filters these by the current app mode.
export const TERMINAL_THEME_OPTIONS = [
  { key: "catppuccinMocha", label: "Catppuccin Mocha", mode: "dark" },
  { key: "kanagawa",        label: "Kanagawa",         mode: "dark" },
  { key: "tokyoNight",      label: "Tokyo Night",      mode: "dark" },
  { key: "gruvbox",         label: "Gruvbox",          mode: "dark" },
  { key: "oneDark",         label: "One Dark",         mode: "dark" },
  { key: "dracula",         label: "Dracula",          mode: "dark" },
  { key: "nord",            label: "Nord",             mode: "dark" },
  { key: "rosePine",        label: "Rosé Pine",        mode: "dark" },
  { key: "solarizedDark",   label: "Solarized Dark",   mode: "dark" },
  { key: "catppuccinLatte", label: "Catppuccin Latte", mode: "light" },
  { key: "kanagawaLotus",   label: "Kanagawa Lotus",   mode: "light" },
  { key: "tokyoNightDay",   label: "Tokyo Day",        mode: "light" },
  { key: "gruvboxLight",    label: "Gruvbox Light",    mode: "light" },
  { key: "oneLight",        label: "One Light",        mode: "light" },
  { key: "rosePineDawn",    label: "Rosé Dawn",        mode: "light" },
  { key: "solarizedLight",  label: "Solarized Light",  mode: "light" },
];

// Resolve the concrete xterm palette for (app mode, sub-theme).
// "default" or a theme whose mode doesn't match → neutral Vesper fallback.
export function resolveTerminalTheme(mode, subTheme) {
  const fallback = TERMINAL_THEMES[mode] || TERMINAL_THEMES.dark;
  if (!subTheme || subTheme === "default") return fallback;
  const opt = TERMINAL_THEME_OPTIONS.find((o) => o.key === subTheme && o.mode === mode);
  if (!opt) return fallback;
  return TERMINAL_PALETTES[subTheme] || fallback;
}
