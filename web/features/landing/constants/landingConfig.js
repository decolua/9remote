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
