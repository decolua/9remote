// Theme tokens resolve via CSS vars (semantic theme aware)
export const THEME = {
  bg: "var(--color-bg)",
  bgElevated: "var(--color-surface)",
  bgPanel: "var(--color-surface-2)",
  border: "var(--color-border)",
  borderStrong: "var(--color-border)",
  borderAccent: "color-mix(in srgb, var(--color-accent) 35%, transparent)",
  text: "var(--color-text)",
  textDim: "var(--color-text-muted)",
  textMuted: "var(--color-text-subtle)",
  accent: "var(--color-accent)",
  accentGlow: "color-mix(in srgb, var(--color-accent) 40%, transparent)",
  accentSoft: "color-mix(in srgb, var(--color-accent) 12%, transparent)",
  success: "var(--color-success)",
  warn: "#F59E0B",
  err: "var(--color-danger)"
};

// Desktop installers — version-less GitHub asset names so links survive releases
const RELEASES = "https://github.com/decolua/9remote/releases/latest/download";

// Hero download row. Web first (nothing to install), then native builds.
export const DOWNLOADS = [
  {
    label: "Open in Browser",
    href: "/login",
    primary: true,
    icon: "M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"
  },
  {
    label: "macOS",
    href: `${RELEASES}/9Remote-macos-universal.dmg`,
    note: "Intel + Apple Silicon · notarized",
    icon: "M12 3v12m0 0l-4-4m4 4l4-4M4 21h16"
  },
  {
    label: "Windows",
    href: `${RELEASES}/9Remote-windows-x64-setup.exe`,
    note: "Windows 10/11 · x64",
    icon: "M12 3v12m0 0l-4-4m4 4l4-4M4 21h16"
  }
];

// Store links land here once the mobile apps ship
export const MOBILE = { label: "iOS & Android", note: "coming soon" };

// The two halves of the product — the agent holds your code, the client is where you sit
export const HALVES = [
  {
    role: "Agent",
    tagline: "Runs on the machine with your code",
    points: [
      "One command — npx 9remote",
      "macOS · Windows · Linux",
      "Bundled inside the desktop app"
    ]
  },
  {
    role: "Client",
    tagline: "Wherever you happen to be",
    points: [
      "Browser — nothing to install",
      "Desktop app — macOS · Windows",
      "iOS & Android — coming soon"
    ]
  }
];

// Pre-rendered terminal history (shown instantly on load)
export const CLAUDE_CODE_PRELOAD = [
  { type: "user", text: "> Refactor auth module to use JWT" },
  { type: "assistant", text: "● Scanning auth files and dependencies..." },
  { type: "tool", text: "⏺ Read(src/auth/session.js)" },
  { type: "tool", text: "⏺ Grep(pattern: \"sessionId\", 8 matches)" },
  { type: "diff-add", text: "+ import jwt from 'jsonwebtoken'" },
  { type: "diff-add", text: "+ const TOKEN_TTL = '7d'" },
  { type: "success", text: "  ✓ Migrated 8 endpoints" }
];

// Claude Code terminal demo sequence (typing animation)
export const CLAUDE_CODE_SEQUENCE = [
  { type: "user", text: "> Build a login form with validation" },
  { type: "assistant", text: "● I'll create a React login form with Zod validation." },
  { type: "tool", text: "⏺ Edit(src/LoginForm.jsx)" },
  { type: "diff-add", text: "+ import { z } from 'zod'" },
  { type: "diff-add", text: "+ const schema = z.object({" },
  { type: "diff-add", text: "+   email: z.string().email()," },
  { type: "diff-add", text: "+   password: z.string().min(8)" },
  { type: "diff-add", text: "+ })" },
  { type: "tool", text: "⏺ Bash(npm run test)" },
  { type: "success", text: "  ✓ 12 tests passed" },
  { type: "assistant", text: "● Done. Login form ready with full validation." }
];

// Pre-rendered phone chat history (shown instantly on load)
export const PHONE_CHAT_PRELOAD = [
  { role: "user", text: "Fix the broken checkout button" },
  { role: "ai", text: "Found null ref in handleSubmit. Patched ✓" }
];

// Mobile phone chat demo (user prompting AI from phone)
export const PHONE_CHAT_SEQUENCE = [
  { role: "user", text: "Add dark mode toggle" },
  { role: "ai", text: "Creating ThemeContext..." },
  { role: "user", text: "Ship it to prod" },
  { role: "ai", text: "Deployed ✓" }
];

// Animation timing (ms)
export const TIMING = {
  typeSpeed: 28,
  lineDelay: 280,
  loopReset: 3500,
  floatDuration: 6000,
  beamDuration: 2400,
  pulseDuration: 2000
};
