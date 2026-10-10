"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

// Remote browser state, keyed by WORKSPACE — exactly like terminal tabs:
// each workspace owns ONE Chrome window of its browsing profile, and the strip
// renders only that window's tabs. Two workspaces on the same profile each
// get their own window (one Chrome per profile stays true host-side).
// - tabsByWorkspace/activeByWorkspace: live tab lists, refilled from the host.
// - workspaceProfiles/workspaceWindows: which profile each workspace browses
//   with and which Chrome window of it is theirs. Only these persist.
export const useBrowserStore = create(persist((set, get) => ({
  tabsByWorkspace: {},
  activeByWorkspace: {},
  // Engine-driven (own-mode) tabs across ALL profiles — agent group of the strip,
  // pushed by the host, never persisted.
  agentTabs: [],
  setAgentTabs: (tabs) => set({ agentTabs: Array.isArray(tabs) ? tabs : [] }),
  workspaceProfiles: {},
  workspaceWindows: {},
  setTabs: (wsId, tabs) => set((s) => ({
    tabsByWorkspace: { ...s.tabsByWorkspace, [wsId]: Array.isArray(tabs) ? tabs : [] }
  })),
  setActive: (wsId, targetId) => set((s) => ({
    activeByWorkspace: { ...s.activeByWorkspace, [wsId]: targetId }
  })),
  setProfileFor: (wsId, profile) => set((s) => ({
    workspaceProfiles: { ...s.workspaceProfiles, [wsId || "default"]: profile || "default" },
    // A different profile means a different Chrome — the old window id and its tabs are dead.
    workspaceWindows: { ...s.workspaceWindows, [wsId || "default"]: null },
    tabsByWorkspace: { ...s.tabsByWorkspace, [wsId || "default"]: [] },
    activeByWorkspace: { ...s.activeByWorkspace, [wsId || "default"]: null }
  })),
  setWindowFor: (wsId, windowId) => set((s) => ({
    workspaceWindows: { ...s.workspaceWindows, [wsId || "default"]: windowId || null }
  })),
  profileFor: (wsId) => get().workspaceProfiles[wsId || "default"] || "default",
  windowFor: (wsId) => get().workspaceWindows[wsId || "default"] || null
}), {
  name: "browser-ui-state",
  partialize: (state) => ({
    workspaceProfiles: state.workspaceProfiles,
    workspaceWindows: state.workspaceWindows
  }),
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
