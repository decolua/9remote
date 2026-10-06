"use client";

import { create } from "zustand";

// Remote browser pane state: client-side tabs (host-proxy browsing — each tab
// names a public host or a localhost port) plus which tab the pane is viewing.
// Open/close lives in the view stack (currentView.type === "browser") — one
// source of truth for the pane.
export const useBrowserStore = create((set) => ({
  tabs: [],
  activeTargetId: null,
  setTabs: (tabs) => set({ tabs: Array.isArray(tabs) ? tabs : [] }),
  setActive: (targetId) => set({ activeTargetId: targetId })
}));

// Engine stamps the working tab "🚀 [N] Title" in real-browser modes — the strip
// shows the clean title (the stamp is host-side state, not user information).
export function cleanTabTitle(title) {
  return String(title || "").replace(/^🚀\s*\[\d+\]\s*/, "").trim();
}
