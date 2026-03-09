"use client";

import { create } from "zustand";

export const useSlideMenuStore = create((set) => ({
  isOpen: false,
  activePanel: "menu",

  context: {
    connected: false,
    remoteAvailable: false,
    codespaceInfo: null,
    showTheme: false,
    theme: "default",
    socketRef: null,
    tunnelUrl: null,
    apiKey: null,
    hideActions: [],
    connectionMode: "tunnel"
  },

  callbacks: {
    onRemote: null,
    onFiles: null,
    onSites: null,
    onCodespace: null,
    onLogout: null,
    onThemeChange: null,
    onStopCodespace: null,
  },

  cachedSites: [],
  currentSites: [],
  loadingSites: false,

  open: (panel = "menu") => set({ isOpen: true, activePanel: panel }),
  close: () => set({ isOpen: false, activePanel: "menu" }),
  setActivePanel: (panel) => set({ activePanel: panel }),

  setContext: (context) => set({
    context: {
      connected: false,
      remoteAvailable: false,
      codespaceInfo: null,
      showTheme: false,
      theme: "default",
      socketRef: null,
      tunnelUrl: null,
      apiKey: null,
      hideActions: [],
      connectionMode: "tunnel",
      ...context
    }
  }),

  setCallbacks: (callbacks) => set({
    callbacks: {
      onRemote: null,
      onFiles: null,
      onSites: null,
      onCodespace: null,
      onLogout: null,
      onThemeChange: null,
      onStopCodespace: null,
      ...callbacks
    }
  }),

  setCachedSites: (sites) => set({ cachedSites: sites }),
  setCurrentSites: (sites) => set({ currentSites: sites }),
  setLoadingSites: (loading) => set({ loadingSites: loading }),

  openPwa: () => set({ isOpen: true, activePanel: "pwa" }),
  openCodespace: () => set({ isOpen: true, activePanel: "codespace" }),
  openMenu: () => set({ isOpen: true, activePanel: "menu" }),
}));
