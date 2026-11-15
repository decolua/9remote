import { useAiHistoryStore } from "@/shared/stores/historyStore";

// Resend and auto-resend bypass the composer — the only place history was written.
// A prompt must stay reusable even when its send is swallowed.
export function rememberPrompt(text, store = useAiHistoryStore) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed || trimmed.startsWith("!")) return;
  store.getState().addCommand(trimmed);
}
