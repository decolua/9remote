"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

// Remote browser pane state: client-side tabs (host-proxy browsing — each tab
// names a public host or a localhost port) plus which tab the pane is viewing.
// Open/close lives in the view stack (currentView.type === "browser") — one
// source of truth for the pane. Only the picked tab persists: tabs themselves
// come back from the host's Chrome, but after a reload the pane should reattach
// to the tab the user was viewing, not the host's own active one.
export const useBrowserStore = create(persist((set) => ({
  tabs: [],
  activeTargetId: null,
  activeProfile: "default",
  setTabs: (tabs) => set({ tabs: Array.isArray(tabs) ? tabs : [] }),
  setActive: (targetId) => set({ activeTargetId: targetId }),
  setActiveProfile: (profile) => set({ activeProfile: profile || "default" })
}), {
  name: "browser-ui-state",
  partialize: (state) => ({ activeTargetId: state.activeTargetId, activeProfile: state.activeProfile || "default" }),
  // Same window-guarded storage pattern as terminalStore — no warnings under node/tests.
  storage: {
    getItem: (name) => {
      if (typeof window === "undefined") return null;
      try {
        const value = localStorage.getItem(name);
        return value ? JSON.parse(value) : null;
      } catch {
        return null;
      }
    },
    setItem: (name, value) => {
      if (typeof window === "undefined") return;
      try { localStorage.setItem(name, JSON.stringify(value)); } catch {}
    },
    removeItem: (name) => {
      if (typeof window === "undefined") return;
      try { localStorage.removeItem(name); } catch {}
    }
  }
}));

// Engine stamps the working tab "🚀 [N] Title" in real-browser modes — the strip
// shows the clean title (the stamp is host-side state, not user information).
export function cleanTabTitle(title) {
  return String(title || "").replace(/^🚀\s*\[\d+\]\s*/, "").trim();
}
