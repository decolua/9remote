"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

const MAX_HISTORY = 50;

// Global terminal command history, persisted to localStorage (survives tab close).
// Newest-first, dedups the most recent entry so repeated sends don't stack.
// Pinned commands (snippets) are user-kept, shown in a separate top section.
export const useHistoryStore = create(
  persist(
    (set) => ({
      history: [],
      pinned: [],

      addCommand: (cmd) => set((state) => {
        const text = cmd.trim();
        if (!text || state.history[0] === text) return state;
        return { history: [text, ...state.history.filter((c) => c !== text)].slice(0, MAX_HISTORY) };
      }),

      removeCommand: (cmd) => set((state) => ({
        history: state.history.filter((c) => c !== cmd),
        pinned: state.pinned.filter((c) => c !== cmd)
      })),

      togglePin: (cmd) => set((state) => {
        const text = cmd.trim();
        if (!text) return state;
        const isPinned = state.pinned.includes(text);
        return { pinned: isPinned ? state.pinned.filter((c) => c !== text) : [text, ...state.pinned] };
      }),

      clearHistory: () => set({ history: [] })
    }),
    {
      name: "terminal-command-history",
      storage: {
        getItem: (name) => {
          if (typeof window === "undefined") return null;
          const value = localStorage.getItem(name);
          return value ? JSON.parse(value) : null;
        },
        setItem: (name, value) => {
          if (typeof window === "undefined") return;
          localStorage.setItem(name, JSON.stringify(value));
        },
        removeItem: (name) => {
          if (typeof window === "undefined") return;
          localStorage.removeItem(name);
        }
      }
    }
  )
);
