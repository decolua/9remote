"use client";

import { create } from "zustand";

// SlideMenu state store - manages global slide menu state
export const useSlideMenuStore = create((set, get) => ({
  // Menu state
  isOpen: false,
  activePanel: "menu", // 'menu' | 'pwa' | 'sites' | 'codespace'
  
  // Context data (set by page that opens menu)
  context: {
    connected: false,
    remoteAvailable: false,
    codespaceInfo: null,
    showTheme: false,
    theme: "default",
    socketRef: null,
  },
  
  // Callbacks (set by page)
  callbacks: {
    onRemote: null,
    onFiles: null,
    onSites: null,
    onSelectSite: null,
    onRefreshSites: null,
    onCodespace: null,
    onLogout: null,
    onThemeChange: null,
    onStopCodespace: null,
  },
  
  // Sites data
  sites: [],
  loadingSites: false,
  
  // Actions
  open: (panel = "menu") => set({ isOpen: true, activePanel: panel }),
  close: () => set({ isOpen: false, activePanel: "menu" }),
  setActivePanel: (panel) => set({ activePanel: panel }),
  
  // Set context for current page (replace entirely to avoid stale data)
  setContext: (context) => set({
    context: {
      connected: false,
      remoteAvailable: false,
      codespaceInfo: null,
      showTheme: false,
      theme: "default",
      socketRef: null,
      ...context
    }
  }),
  
  // Set callbacks for current page (replace entirely)
  setCallbacks: (callbacks) => set({
    callbacks: {
      onRemote: null,
      onFiles: null,
      onSites: null,
      onSelectSite: null,
      onRefreshSites: null,
      onCodespace: null,
      onLogout: null,
      onThemeChange: null,
      onStopCodespace: null,
      ...callbacks
    }
  }),
  
  // Sites actions
  setSites: (sites) => set({ sites }),
  setLoadingSites: (loading) => set({ loadingSites: loading }),
  
  // Helper to open specific panel
  openPwa: () => set({ isOpen: true, activePanel: "pwa" }),
  openSites: () => set({ isOpen: true, activePanel: "sites" }),
  openCodespace: () => set({ isOpen: true, activePanel: "codespace" }),
  openMenu: () => set({ isOpen: true, activePanel: "menu" }),
}));
