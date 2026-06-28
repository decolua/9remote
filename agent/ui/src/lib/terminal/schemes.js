// Terminal color schemes + gradient backgrounds (WezTerm-inspired).
// Each scheme: { colors (xterm), gradient (css), image? }
// Shared by web (import) and agent (copied to agent/ui/src/lib/terminal/schemes.js).

export const TERMINAL_SCHEMES = {
  dracula: {
    name: "Dracula",
    colors: {
      background: "#282a36",
      foreground: "#f8f8f2",
      cursor: "#ff79c6",
      cursorAccent: "#282a36",
      selectionBackground: "#44475a",
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
    gradient: { colors: ["#282a36", "#44475a"], angle: 135 },
  },
  catppuccin: {
    name: "Catppuccin Mocha",
    colors: {
      background: "#1e1e2e",
      foreground: "#cdd6f4",
      cursor: "#f5e0dc",
      cursorAccent: "#1e1e2e",
      selectionBackground: "#585b70",
      black: "#45475a",
      red: "#f38ba8",
      green: "#a6e3a1",
      yellow: "#f9e2af",
      blue: "#89b4fa",
      magenta: "#f5c2e7",
      cyan: "#94e2d5",
      white: "#bac2de",
      brightBlack: "#585b70",
      brightRed: "#f38ba8",
      brightGreen: "#a6e3a1",
      brightYellow: "#f9e2af",
      brightBlue: "#89b4fa",
      brightMagenta: "#f5c2e7",
      brightCyan: "#94e2d5",
      brightWhite: "#a6adc8",
    },
    gradient: { colors: ["#1e1e2e", "#313244", "#11111b"], angle: 135 },
  },
  tokyoNight: {
    name: "Tokyo Night",
    colors: {
      background: "#1a1b26",
      foreground: "#a9b1d6",
      cursor: "#c0caf5",
      cursorAccent: "#1a1b26",
      selectionBackground: "#33467c",
      black: "#32344a",
      red: "#f7768e",
      green: "#9ece6a",
      yellow: "#e0af68",
      blue: "#7aa2f7",
      magenta: "#ad8ee6",
      cyan: "#449dab",
      white: "#787c99",
      brightBlack: "#444b6a",
      brightRed: "#ff7a93",
      brightGreen: "#b9f27c",
      brightYellow: "#ff9e64",
      brightBlue: "#7da6ff",
      brightMagenta: "#bb9af7",
      brightCyan: "#0db9d7",
      brightWhite: "#acb0d0",
    },
    gradient: { colors: ["#1a1b26", "#24283b", "#16161e"], angle: 160 },
  },
  gruvbox: {
    name: "Gruvbox Dark",
    colors: {
      background: "#282828",
      foreground: "#ebdbb2",
      cursor: "#ebdbb2",
      cursorAccent: "#282828",
      selectionBackground: "#504945",
      black: "#282828",
      red: "#cc241d",
      green: "#98971a",
      yellow: "#d79921",
      blue: "#458588",
      magenta: "#b16286",
      cyan: "#689d6a",
      white: "#a89984",
      brightBlack: "#928374",
      brightRed: "#fb4934",
      brightGreen: "#b8bb26",
      brightYellow: "#fabd2f",
      brightBlue: "#83a598",
      brightMagenta: "#d3869b",
      brightCyan: "#8ec07c",
      brightWhite: "#ebdbb2",
    },
    gradient: { colors: ["#282828", "#3c3836", "#1d2021"], angle: 135 },
  },
  nord: {
    name: "Nord",
    colors: {
      background: "#2e3440",
      foreground: "#d8dee9",
      cursor: "#d8dee9",
      cursorAccent: "#2e3440",
      selectionBackground: "#434c5e",
      black: "#3b4252",
      red: "#bf616a",
      green: "#a3be8c",
      yellow: "#ebcb8b",
      blue: "#81a1c1",
      magenta: "#b48ead",
      cyan: "#88c0d0",
      white: "#e5e9f0",
      brightBlack: "#4c566a",
      brightRed: "#bf616a",
      brightGreen: "#a3be8c",
      brightYellow: "#ebcb8b",
      brightBlue: "#81a1c1",
      brightMagenta: "#b48ead",
      brightCyan: "#8fbcbb",
      brightWhite: "#eceff4",
    },
    gradient: { colors: ["#2e3440", "#3b4252", "#434c5e"], angle: 135 },
  },
  solarizedDark: {
    name: "Solarized Dark",
    colors: {
      background: "#002b36",
      foreground: "#839496",
      cursor: "#93a1a1",
      cursorAccent: "#002b36",
      selectionBackground: "#073642",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
      brightBlack: "#002b36",
      brightRed: "#cb4b16",
      brightGreen: "#586e75",
      brightYellow: "#657b83",
      brightBlue: "#839496",
      brightMagenta: "#6c71c4",
      brightCyan: "#93a1a1",
      brightWhite: "#fdf6e3",
    },
    gradient: { colors: ["#002b36", "#073642", "#001e26"], angle: 135 },
  },
  oneDark: {
    name: "One Dark",
    colors: {
      background: "#282c34",
      foreground: "#abb2bf",
      cursor: "#528bff",
      cursorAccent: "#282c34",
      selectionBackground: "#3e4451",
      black: "#282c34",
      red: "#e06c75",
      green: "#98c379",
      yellow: "#e5c07b",
      blue: "#61afef",
      magenta: "#c678dd",
      cyan: "#56b6c2",
      white: "#abb2bf",
      brightBlack: "#5c6370",
      brightRed: "#e06c75",
      brightGreen: "#98c379",
      brightYellow: "#e5c07b",
      brightBlue: "#61afef",
      brightMagenta: "#c678dd",
      brightCyan: "#56b6c2",
      brightWhite: "#ffffff",
    },
    gradient: { colors: ["#282c34", "#21252b", "#1b1f23"], angle: 135 },
  },
  ayuDark: {
    name: "Ayu Dark",
    colors: {
      background: "#0a0e14",
      foreground: "#b3b1ad",
      cursor: "#e6b450",
      cursorAccent: "#0a0e14",
      selectionBackground: "#1c2128",
      black: "#01060e",
      red: "#ea6c73",
      green: "#91b362",
      yellow: "#f9af4f",
      blue: "#53bfa9",
      magenta: "#fae994",
      cyan: "#90e1c6",
      white: "#c7c7c7",
      brightBlack: "#686868",
      brightRed: "#f07178",
      brightGreen: "#c2d94c",
      brightYellow: "#ffb454",
      brightBlue: "#59c2ff",
      brightMagenta: "#ffee99",
      brightCyan: "#95e6cb",
      brightWhite: "#ffffff",
    },
    gradient: { colors: ["#0a0e14", "#1c2128", "#070a0f"], angle: 135 },
  },
  // WezTerm gradient presets applied to default palette
  inferno: {
    name: "Inferno",
    colors: {
      background: "#1a0500",
      foreground: "#fde68a",
      cursor: "#fc9b00",
      cursorAccent: "#1a0500",
      selectionBackground: "#3a1500",
      black: "#1a0500",
      red: "#fc4b00",
      green: "#b8740a",
      yellow: "#fc9b00",
      blue: "#a01000",
      magenta: "#fc6b00",
      cyan: "#e88040",
      white: "#fde68a",
      brightBlack: "#5a2000",
      brightRed: "#ff6b1a",
      brightGreen: "#d68f1f",
      brightYellow: "#fdbb2c",
      brightBlue: "#c41e1a",
      brightMagenta: "#ff8a1f",
      brightCyan: "#ffa050",
      brightWhite: "#fff4d6",
    },
    gradient: { colors: ["#000004", "#420a68", "#932667", "#dd513a", "#fca50a", "#fcffa4"], angle: 135 },
  },
  ocean: {
    name: "Ocean",
    colors: {
      background: "#0d1b2a",
      foreground: "#e0e1dd",
      cursor: "#48cae4",
      cursorAccent: "#0d1b2a",
      selectionBackground: "#1b263b",
      black: "#0d1b2a",
      red: "#e63946",
      green: "#52b788",
      yellow: "#ffd166",
      blue: "#48cae4",
      magenta: "#b5179e",
      cyan: "#00b4d8",
      white: "#e0e1dd",
      brightBlack: "#415a77",
      brightRed: "#ff6b6b",
      brightGreen: "#80ed99",
      brightYellow: "#ffe066",
      brightBlue: "#90e0ef",
      brightMagenta: "#f72585",
      brightCyan: "#48cae4",
      brightWhite: "#ffffff",
    },
    gradient: { colors: ["#03045e", "#0077b6", "#00b4d8", "#90e0ef", "#caf0f8"], angle: 135 },
  },
};

export const DEFAULT_TERMINAL_SCHEME = "dracula";

// WezTerm-style background image presets (optional, layered over gradient)
export const TERMINAL_BACKGROUNDS = {
  none: { name: "None", url: null },
  aurora: {
    name: "Aurora",
    url: "https://images.unsplash.com/photo-1531306760863-7fb02a41db12?w=1920&q=80",
    opacity: 0.15,
  },
  mountains: {
    name: "Mountains",
    url: "https://images.unsplash.com/photo-1518770660439-4636190af475?w=1920&q=80",
    opacity: 0.12,
  },
  nebula: {
    name: "Nebula",
    url: "https://images.unsplash.com/photo-1462331940025-496dfbfc7564?w=1920&q=80",
    opacity: 0.18,
  },
};

export const DEFAULT_TERMINAL_BACKGROUND = "none";

export const TERMINAL_SCHEME_KEYS = Object.keys(TERMINAL_SCHEMES);

const STORAGE_SCHEME = "9remote-term-scheme";
const STORAGE_BG = "9remote-term-bg";

export function loadStoredTerminalScheme() {
  if (typeof window === "undefined") return DEFAULT_TERMINAL_SCHEME;
  return localStorage.getItem(STORAGE_SCHEME) || DEFAULT_TERMINAL_SCHEME;
}

export function storeTerminalScheme(name) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_SCHEME, name);
}

export function loadStoredTerminalBackground() {
  if (typeof window === "undefined") return DEFAULT_TERMINAL_BACKGROUND;
  return localStorage.getItem(STORAGE_BG) || DEFAULT_TERMINAL_BACKGROUND;
}

export function storeTerminalBackground(name) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_BG, name);
}

// Resolve scheme by name (fallback → default)
export function resolveTerminalScheme(name) {
  return TERMINAL_SCHEMES[name] || TERMINAL_SCHEMES[DEFAULT_TERMINAL_SCHEME];
}

// Build CSS gradient string from scheme
export function buildSchemeGradient(name) {
  const scheme = resolveTerminalScheme(name);
  const g = scheme.gradient;
  const stops = g.colors.map((c, i) => `${c} ${Math.round((i / (g.colors.length - 1)) * 100)}%`).join(", ");
  return `linear-gradient(${g.angle}deg, ${stops})`;
}

// Build full background CSS (gradient + optional image overlay)
export function buildTerminalBackground(schemeName, bgName) {
  const gradient = buildSchemeGradient(schemeName);
  const bg = TERMINAL_BACKGROUNDS[bgName] || TERMINAL_BACKGROUNDS.none;
  if (!bg.url) return gradient;
  return `linear-gradient(rgba(0,0,0,${1 - bg.opacity}), rgba(0,0,0,${1 - bg.opacity})), url("${bg.url}"), ${gradient}`;
}
