"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

// SlideMenu state store - manages global slide menu state
export const useSlideMenuStore = create(
  persist(
    (set, get) => ({
      // Menu state
      isOpen: false,
      activePanel: "menu", // 'menu' | 'pwa' | 'codespace'
      
      // Context data (set by page that opens menu)
      context: {
        connected: false,
        remoteAvailable: false,
        codespaceInfo: null,
        showTheme: false,
        theme: "default",
        socketRef: null,
        tunnelUrl: null,
        apiKey: null,
        hideActions: []
      },
      
      // Callbacks (set by page)
      callbacks: {
        onRemote: null,
        onFiles: null,
        onSites: null,
        onCodespace: null,
        onLogout: null,
        onThemeChange: null,
        onStopCodespace: null,
      },
      
      // Cached sites (persistent)
      cachedSites: [],
      
      // Current sites (runtime, shared across all instances)
      currentSites: [],
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
          tunnelUrl: null,
          apiKey: null,
          hideActions: [],
          ...context
        }
      }),
      
      // Set callbacks for current page (replace entirely)
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
      
      // Cache sites
      setCachedSites: (sites) => set({ cachedSites: sites }),
      
      // Set current sites
      setCurrentSites: (sites) => set({ currentSites: sites }),
      setLoadingSites: (loading) => set({ loadingSites: loading }),
      
      // Helper to open specific panel
      openPwa: () => set({ isOpen: true, activePanel: "pwa" }),
      openCodespace: () => set({ isOpen: true, activePanel: "codespace" }),
      openMenu: () => set({ isOpen: true, activePanel: "menu" }),
    }),
    {
      name: "slide-menu-storage",
      partialize: (state) => ({ cachedSites: state.cachedSites }) // Only persist cachedSites
    }
  )
);
