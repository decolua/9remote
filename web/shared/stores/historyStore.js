"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

const MAX_HISTORY = 50;

// Auto-suggest a short alias from a command: first letter of each word.
// "npm run dev" -> "nrd", "git status" -> "gs". Dedup against existing aliases.
const suggestAlias = (cmd, taken = []) => {
  const words = cmd.trim().split(/\s+/).filter(Boolean);
  let base = words.map((w) => w[0]).join("").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!base) return "";
  let alias = base;
  let n = 2;
  while (taken.includes(alias)) alias = `${base}${n++}`;
  return alias;
};

// Command-history store factory, persisted to localStorage (survives tab close).
// Newest-first, dedups the most recent entry so repeated sends don't stack.
// Pinned commands (snippets) are user-kept objects {cmd, alias}, shown in a separate top section.
// One store per scope (terminal / remote) so their histories stay independent.
const createHistoryStore = (storageName) => create(
  persist(
    (set, get) => ({
      history: [],
      pinned: [],

      addCommand: (cmd) => set((state) => {
        const text = cmd.trim();
        if (!text || state.history[0] === text) return state;
        return { history: [text, ...state.history.filter((c) => c !== text)].slice(0, MAX_HISTORY) };
      }),

      removeCommand: (cmd) => set((state) => ({
        history: state.history.filter((c) => c !== cmd),
        pinned: state.pinned.filter((s) => s.cmd !== cmd)
      })),

      togglePin: (cmd) => set((state) => {
        const text = cmd.trim();
        if (!text) return state;
        const isPinned = state.pinned.some((s) => s.cmd === text);
        if (isPinned) return { pinned: state.pinned.filter((s) => s.cmd !== text) };
        const alias = suggestAlias(text, state.pinned.map((s) => s.alias));
        return { pinned: [{ cmd: text, alias }, ...state.pinned] };
      }),

      // Update an existing snippet's cmd and/or alias, keeping its position.
      setSnippet: (oldCmd, next) => set((state) => ({
        pinned: state.pinned.map((s) =>
          s.cmd === oldCmd ? { cmd: (next.cmd ?? s.cmd).trim(), alias: (next.alias ?? s.alias).trim() } : s
        )
      })),

      // Expand a bare alias to its command. Only when the whole input equals an alias.
      resolveAlias: (text) => {
        const trimmed = text.trim();
        const hit = get().pinned.find((s) => s.alias && s.alias === trimmed);
        return hit ? hit.cmd : text;
      },

      clearHistory: () => set({ history: [] })
    }),
    {
      name: storageName,
      version: 1,
      migrate: (state, version) => {
        if (version < 1 && state?.pinned) {
          const taken = [];
          state.pinned = state.pinned.map((cmd) => {
            const alias = suggestAlias(cmd, taken);
            taken.push(alias);
            return { cmd, alias };
          });
        }
        return state;
      },
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

// Terminal keeps the legacy storage key so existing history/snippets survive.
export const useHistoryStore = createHistoryStore("terminal-command-history");
export const useTerminalHistoryStore = useHistoryStore;
// Remote desktop input has its own independent history.
export const useRemoteHistoryStore = createHistoryStore("remote-input-history");
