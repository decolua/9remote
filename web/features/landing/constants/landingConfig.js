// Centralized config for landing page theme + animations
export const THEME = {
  bg: "#0A0A0A",
  bgElevated: "#121212",
  bgPanel: "#1A1A1A",
  border: "rgba(255,255,255,0.08)",
  borderStrong: "rgba(255,255,255,0.14)",
  borderAccent: "rgba(255,87,10,0.35)",
  text: "#FFFFFF",
  textDim: "#A0A0A0",
  textMuted: "#666666",
  accent: "#FF570A",
  accentGlow: "rgba(255,87,10,0.4)",
  accentSoft: "rgba(255,87,10,0.12)",
  success: "#10B981",
  warn: "#F59E0B",
  err: "#EF4444"
};

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
