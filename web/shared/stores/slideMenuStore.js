"use client";

import { create } from "zustand";

const isShallowEqual = (a, b) => {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (a[k] !== b[k]) return false;
  }
  return true;
};

export const useSlideMenuStore = create((set, get) => ({
  isOpen: false,
  activePanel: "menu",

  context: {
    connected: false,
    remoteAvailable: false,
    showTheme: false,
    theme: "default",
    busRef: null,
    tunnelUrl: null,
    apiKey: null,
    hideActions: [],
    connectionMode: "tunnel",
    hostVersion: null,
    agentVersion: null,
    transport: "ws"
  },

  callbacks: {
    onRemote: null,
    onFiles: null,
    onLogout: null,
    onThemeChange: null,
    onUpdate: null,
    onRestart: null,
  },

  cachedSites: [],
  currentSites: [],
  loadingSites: false,

  open: (panel = "menu") => set({ isOpen: true, activePanel: panel }),
  close: () => set({ isOpen: false, activePanel: "menu" }),
  setActivePanel: (panel) => set({ activePanel: panel }),

  setContext: (context) => set((state) => {
    const nextContext = { ...state.context, ...context };
    let changed = false;
    for (const key of Object.keys(nextContext)) {
      if (!isShallowEqual(state.context[key], nextContext[key])) {
        changed = true;
        break;
      }
    }
    if (!changed) return state;
    return { context: nextContext };
  }),

  setCallbacks: (callbacks) => {
    const curr = get().callbacks;
    let presenceChanged = false;
    for (const key of Object.keys(callbacks)) {
      if (Boolean(curr[key]) !== Boolean(callbacks[key])) {
        presenceChanged = true;
      }
      curr[key] = callbacks[key];
    }
    if (presenceChanged) {
      set({ callbacks: { ...curr } });
    }
  },

  setCachedSites: (sites) => set({ cachedSites: sites }),
  setCurrentSites: (sites) => set({ currentSites: sites }),
  setLoadingSites: (loading) => set({ loadingSites: loading }),

  openPwa: () => set({ isOpen: true, activePanel: "pwa" }),
  openMenu: () => set({ isOpen: true, activePanel: "menu" }),
}));
