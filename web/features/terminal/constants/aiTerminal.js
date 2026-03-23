/**
 * AITerminal Constants
 */

export const AI_TERMINAL_CONFIG = {
  maxHistory: 30,
  storageKey: "9remote_ai_terminal_history",
  placeholder: "Describe what you want to do...",
  systemPrompt: "You are a terminal command assistant. Given a user's request, respond ONLY with the exact terminal command(s) needed. No explanations, no markdown, just the raw command(s). If multiple commands are needed, separate them with && or newlines."
};
