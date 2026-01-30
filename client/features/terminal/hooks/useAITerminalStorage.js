import { useCallback } from "react";
import { AI_TERMINAL_CONFIG } from "@/features/terminal/constants/aiTerminal";

const { storageKey, maxHistory } = AI_TERMINAL_CONFIG;

/**
 * Hook to manage AITerminal chat history in localStorage
 * Max 30 messages, auto-trim oldest when exceeded
 */
export function useAITerminalStorage() {
  const isBrowser = typeof window !== "undefined";

  // Load chat history
  const loadHistory = useCallback(() => {
    if (!isBrowser) return [];
    try {
      const data = localStorage.getItem(storageKey);
      return data ? JSON.parse(data) : [];
    } catch (err) {
      console.error("Failed to load AI terminal history:", err);
      return [];
    }
  }, [isBrowser]);

  // Add message to history (auto-trim to maxHistory)
  const addMessage = useCallback((message) => {
    if (!isBrowser || !message) return;
    try {
      const history = loadHistory();
      const newMessage = {
        id: Date.now().toString(),
        ...message,
        timestamp: new Date().toISOString()
      };
      const updated = [...history, newMessage].slice(-maxHistory);
      localStorage.setItem(storageKey, JSON.stringify(updated));
      return updated;
    } catch (err) {
      console.error("Failed to add AI terminal message:", err);
      return loadHistory();
    }
  }, [isBrowser, loadHistory]);

  // Clear all history
  const clearHistory = useCallback(() => {
    if (!isBrowser) return;
    try {
      localStorage.removeItem(storageKey);
    } catch (err) {
      console.error("Failed to clear AI terminal history:", err);
    }
  }, [isBrowser]);

  return {
    loadHistory,
    addMessage,
    clearHistory
  };
}
