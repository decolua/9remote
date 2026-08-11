// Single source of truth for theme palette (used by JS - xterm, canvas, etc.)
// CSS components should use semantic tokens from globals.css instead.

export const THEME_KEYS = ["dark", "light"];
export const DEFAULT_THEME = "dark";
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
  everforestDark: {
    bg: "#2D353B", surface0: "#343F44", surface1: "#3D484D", surfaceDim: "#232A2E",
    overlay0: "#7A8478", text: "#D3C6AA", subtext0: "#9DA9A0",
    red: "#E67E80", green: "#A7C080", yellow: "#DBBC7F", blue: "#7FBBB3",
    mauve: "#D699B6", teal: "#83C092", peach: "#E69875", accent: "#A7C080",
  },
  everforestLight: {
    bg: "#FDF6E3", surface0: "#F4F0D9", surface1: "#EFEBD4", surfaceDim: "#E6E2CC",
    overlay0: "#9DA9A0", text: "#5C6A72", subtext0: "#7A8478",
    red: "#F85552", green: "#8DA101", yellow: "#DFA000", blue: "#3A94C5",
    mauve: "#DF69BA", teal: "#35A77C", peach: "#F57D3A", accent: "#8DA101",
  },
  monokaiPro: {
    bg: "#2D2A2E", surface0: "#353034", surface1: "#3D383C", surfaceDim: "#221F22",
    overlay0: "#72696A", text: "#FFF1F3", subtext0: "#C8C5C8",
    red: "#FD6883", green: "#ADDA78", yellow: "#F9CC6C", blue: "#F38D70",
    mauve: "#A8A9EB", teal: "#85DACC", peach: "#F38D70", accent: "#A8A9EB",
  },
  poimandres: {
    bg: "#1B1E28", surface0: "#303340", surface1: "#3A4050", surfaceDim: "#14161F",
    overlay0: "#506477", text: "#E4F0FB", subtext0: "#A6ACCD",
    red: "#D0679D", green: "#5DE4C7", yellow: "#FFFAC2", blue: "#ADD7FF",
    mauve: "#F087BD", teal: "#5DE4C7", peach: "#F087BD", accent: "#5DE4C7",
  },
  ayuMirage: {
    bg: "#1F2430", surface0: "#212733", surface1: "#272D3A", surfaceDim: "#161B26",
    overlay0: "#686868", text: "#CBCCC6", subtext0: "#9A9B95",
    red: "#F08778", green: "#53BF97", yellow: "#FDCC60", blue: "#60B8D6",
    mauve: "#EC7171", teal: "#98E6CA", peach: "#FFA759", accent: "#FFCC66",
  },
  dracula: {
    bg: "#282A36", surface0: "#44475A", surface1: "#6272A4", surfaceDim: "#282A36",
    overlay0: "#6272A4", text: "#F8F8F2", subtext0: "#D2D2DC",
    red: "#FF5555", green: "#50FA7B", yellow: "#F1FA8C", blue: "#8BE9FD",
    mauve: "#FF79C6", teal: "#8BE9FD", peach: "#FFB86C", accent: "#BD93F9",
  },
  linearDark: {
    bg: "#08090A", surface0: "#0F1011", surface1: "#141516", surfaceDim: "#010102",
    overlay0: "#3E3E44", text: "#F7F8F8", subtext0: "#B4B4B8",
    red: "#F34E52", green: "#27A644", yellow: "#E4F222", blue: "#8FA6FF",
    mauve: "#8B5CF6", teal: "#02B8CC", peach: "#F7BF8B", accent: "#5E6AD2",
  },
  synthwave: {
    bg: "#262335", surface0: "#241B2F", surface1: "#34294F", surfaceDim: "#171520",
    overlay0: "#9D8BCA", text: "#FFFFFF", subtext0: "#FFFFFF99",
    red: "#FE4450", green: "#72F1B8", yellow: "#FEDE5D", blue: "#03EDF9",
    mauve: "#FF7EDB", teal: "#03EDF9", peach: "#F97E72", accent: "#FF7EDB",
  },
  gruvboxMaterialDark: {
    bg: "#282828", surface0: "#3C3836", surface1: "#504945", surfaceDim: "#1D2021",
    overlay0: "#928374", text: "#D4BE98", subtext0: "#A89984",
    red: "#EA6962", green: "#A9B665", yellow: "#D8A657", blue: "#7DAEA3",
    mauve: "#D3869B", teal: "#89B482", peach: "#E78A4E", accent: "#E78A4E",
  },
  githubDarkDimmed: {
    bg: "#22272E", surface0: "#2D333B", surface1: "#373E47", surfaceDim: "#1C2128",
    overlay0: "#545D68", text: "#CDD9E5", subtext0: "#909DAB",
    red: "#F47067", green: "#57AB5A", yellow: "#C69026", blue: "#539BF5",
    mauve: "#B083F0", teal: "#39C5CF", peach: "#DAAA3F", accent: "#539BF5",
  },
  palenight: {
    bg: "#292D3E", surface0: "#313553", surface1: "#3A3F5F", surfaceDim: "#1F2233",
    overlay0: "#676E95", text: "#D0D0D0", subtext0: "#A0A0C0",
    red: "#F07178", green: "#C3E88D", yellow: "#FFCB6B", blue: "#82AAFF",
    mauve: "#C792EA", teal: "#89DDFF", peach: "#FFCB6B", accent: "#82AAFF",
  },
  nordDark: {
    bg: "#2E3440", surface0: "#3B4252", surface1: "#434C5E", surfaceDim: "#232831",
    overlay0: "#4C566A", text: "#ECEFF4", subtext0: "#D8DEE9",
    red: "#BF616A", green: "#A3BE8C", yellow: "#EBCB8B", blue: "#81A1C1",
    mauve: "#B48EAD", teal: "#88C0D0", peach: "#D08770", accent: "#88C0D0",
  },
  horizon: {
    bg: "#1C1E26", surface0: "#232530", surface1: "#2E303E", surfaceDim: "#16161C",
    overlay0: "#6B6F8A", text: "#E0E0E0", subtext0: "#C5C8DA",
    red: "#E95678", green: "#29D398", yellow: "#FAB795", blue: "#26BBD9",
    mauve: "#EE64AC", teal: "#59E1E3", peach: "#FAB795", accent: "#EE64AC",
  },
  kanagawaDragon: {
    bg: "#181616", surface0: "#1D1C1C", surface1: "#252424", surfaceDim: "#0D0C0C",
    overlay0: "#7A6F7A", text: "#C5C9C5", subtext0: "#A6A69C",
    red: "#C4746E", green: "#87A987", yellow: "#E6C384", blue: "#8BA4B0",
    mauve: "#938AA9", teal: "#7AA89F", peach: "#FFA066", accent: "#8BA4B0",
  },
  githubLight: {
    bg: "#FFFFFF", surface0: "#F6F8FA", surface1: "#EAEEF2", surfaceDim: "#EFF2F5",
    overlay0: "#8C959F", text: "#24292F", subtext0: "#57606A",
    red: "#CF222E", green: "#1A7F37", yellow: "#9A6700", blue: "#0969DA",
    mauve: "#8250DF", teal: "#1B7C83", peach: "#BC4C00", accent: "#0969DA",
  },
  ayuLight: {
    bg: "#FCFCFC", surface0: "#F3F3F3", surface1: "#E8E8E8", surfaceDim: "#F7F7F7",
    overlay0: "#C1C1C1", text: "#5C6166", subtext0: "#8A8F94",
    red: "#E7666A", green: "#80AB24", yellow: "#EBA54D", blue: "#4196DF",
    mauve: "#9870C3", teal: "#51B891", peach: "#E78F4D", accent: "#FF8552",
  },
  gruvboxLight: {
    bg: "#FBF1C7", surface0: "#EBDBB2", surface1: "#D5C4A1", surfaceDim: "#F2E5BC",
    overlay0: "#928374", text: "#3C3836", subtext0: "#504945",
    red: "#9D0006", green: "#79740E", yellow: "#B57614", blue: "#076678",
    mauve: "#8F3F71", teal: "#427B58", peach: "#AF3A03", accent: "#B57614",
  },
  tokyoDay: {
    bg: "#D6D8DF", surface0: "#C8CBD4", surface1: "#B5B8C5", surfaceDim: "#E1E3EA",
    overlay0: "#9699AE", text: "#343B58", subtext0: "#565C70",
    red: "#C24242", green: "#41A6B5", yellow: "#8F5E15", blue: "#2959AA",
    mauve: "#7B43BA", teal: "#006C86", peach: "#D68910", accent: "#2959AA",
  },
  roseDawn: {
    bg: "#FAF4ED", surface0: "#F2E9E1", surface1: "#E9DDD2", surfaceDim: "#F5EBE0",
    overlay0: "#9893A5", text: "#576279", subtext0: "#797593",
    red: "#B4637A", green: "#618774", yellow: "#EA9D34", blue: "#286983",
    mauve: "#907AA9", teal: "#56949F", peach: "#D7827E", accent: "#D7827E",
  },
  lavenderMist: {
    bg: "#F6F3FB", surface0: "#EAE5F5", surface1: "#DDD6EE", surfaceDim: "#F0ECF8",
    overlay0: "#9B95B8", text: "#4A4467", subtext0: "#6B6491",
    red: "#C95D77", green: "#5FA17A", yellow: "#D9A441", blue: "#5B7FBE",
    mauve: "#8B7AB8", teal: "#5FA6A8", peach: "#D08A66", accent: "#8B7AB8",
  },
  mintCream: {
    bg: "#ECF6F0", surface0: "#DCEEE3", surface1: "#C9E3D2", surfaceDim: "#E2F1E9",
    overlay0: "#7FA396", text: "#2F4A40", subtext0: "#4E6B5F",
    red: "#C76B6B", green: "#3FA17A", yellow: "#C9A93E", blue: "#4A8DB8",
    mauve: "#9B6FA8", teal: "#3FA17A", peach: "#D58560", accent: "#3FA17A",
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
  catppuccinMocha:     toXterm(TERMINAL_TOKENS.catppuccinDark),
  monokaiPro:          toXterm(TERMINAL_TOKENS.monokaiPro),
  gruvboxMaterial:     toXterm(TERMINAL_TOKENS.gruvboxMaterialDark),
  dracula:             toXterm(TERMINAL_TOKENS.dracula),
  everforest:          toXterm(TERMINAL_TOKENS.everforestDark),
  linear:              toXterm(TERMINAL_TOKENS.linearDark),
  synthwave:           toXterm(TERMINAL_TOKENS.synthwave),
  poimandres:          toXterm(TERMINAL_TOKENS.poimandres),
  ayuMirage:           toXterm(TERMINAL_TOKENS.ayuMirage),
  githubDarkDimmed:    toXterm(TERMINAL_TOKENS.githubDarkDimmed),
  palenight:           toXterm(TERMINAL_TOKENS.palenight),
  nordDark:            toXterm(TERMINAL_TOKENS.nordDark),
  horizon:             toXterm(TERMINAL_TOKENS.horizon),
  kanagawaDragon:      toXterm(TERMINAL_TOKENS.kanagawaDragon),
  catppuccinLatte:     toXterm(TERMINAL_TOKENS.catppuccinLight),
  gruvboxLight:        toXterm(TERMINAL_TOKENS.gruvboxLight),
  githubLight:         toXterm(TERMINAL_TOKENS.githubLight),
  everforestLight:     toXterm(TERMINAL_TOKENS.everforestLight),
  ayuLight:            toXterm(TERMINAL_TOKENS.ayuLight),
  tokyoDay:            toXterm(TERMINAL_TOKENS.tokyoDay),
  roseDawn:            toXterm(TERMINAL_TOKENS.roseDawn),
  lavenderMist:        toXterm(TERMINAL_TOKENS.lavenderMist),
  mintCream:           toXterm(TERMINAL_TOKENS.mintCream),
};

// Menu options — each entry is one mode only. The menu renders the "Default"
// (Vesper) entry unconditionally, then filters these by the current app mode.
export const TERMINAL_THEME_OPTIONS = [
  { key: "catppuccinMocha", label: "Catppuccin Mocha", mode: "dark" },
  { key: "monokaiPro",      label: "Monokai Pro",      mode: "dark" },
  { key: "dracula",         label: "Dracula",          mode: "dark" },
  { key: "everforest",      label: "Everforest",       mode: "dark" },
  { key: "gruvboxMaterial", label: "Gruvbox Material", mode: "dark" },
  { key: "linear",          label: "Linear",           mode: "dark" },
  { key: "synthwave",       label: "Synthwave '84",    mode: "dark" },
  { key: "poimandres",      label: "Poimandres",       mode: "dark" },
  { key: "ayuMirage",       label: "Ayu Mirage",       mode: "dark" },
  { key: "githubDarkDimmed", label: "GitHub Dimmed",   mode: "dark" },
  { key: "palenight",       label: "Palenight",        mode: "dark" },
  { key: "nordDark",        label: "Nord",             mode: "dark" },
  { key: "horizon",         label: "Horizon",          mode: "dark" },
  { key: "kanagawaDragon",  label: "Kanagawa Dragon",  mode: "dark" },
  { key: "catppuccinLatte", label: "Catppuccin Latte", mode: "light" },
  { key: "gruvboxLight",    label: "Gruvbox Light",    mode: "light" },
  { key: "githubLight",     label: "GitHub Light",     mode: "light" },
  { key: "everforestLight", label: "Everforest Light", mode: "light" },
  { key: "ayuLight",        label: "Ayu Light",        mode: "light" },
  { key: "tokyoDay",        label: "Tokyo Day",        mode: "light" },
  { key: "roseDawn",        label: "Rose Dawn",        mode: "light" },
  { key: "lavenderMist",    label: "Lavender Mist",    mode: "light" },
  { key: "mintCream",       label: "Mint Cream",       mode: "light" },
];

// Resolve the concrete xterm palette for (app mode, sub-theme).
// "default" (no sub-theme picked) → mode default: Palenight for dark, Everforest Light for light.
export function resolveTerminalTheme(mode, subTheme) {
  const modeDefault = mode === "light" ? TERMINAL_PALETTES.everforestLight : TERMINAL_PALETTES.palenight;
  if (!subTheme || subTheme === "default") return modeDefault;
  const opt = TERMINAL_THEME_OPTIONS.find((o) => o.key === subTheme && o.mode === mode);
  if (!opt) return modeDefault;
  return TERMINAL_PALETTES[subTheme] || modeDefault;
}
