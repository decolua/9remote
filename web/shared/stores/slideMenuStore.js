"use client";

import { create } from "zustand";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { DESKTOP_BREAKPOINT } from "@/features/terminal/constants/terminalConfig";

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

  // Settings is a ROUTE (/workspace/settings) and, on a phone, one of the dock's
  // tabs. The store carries the context/callbacks the screen reads; the view stack
  // carries where it sits.
  open: (panel = "menu") => {
    set({ isOpen: true, activePanel: panel });
    // Phone: settings is a dock TAB, a sibling of the session list — switching to it
    // replaces the root instead of stacking a screen on top. Desktop keeps the
    // two-pane dialog over the current view: it is a tool, not a place.
    if (typeof window !== "undefined" && window.innerWidth >= DESKTOP_BREAKPOINT) return;
    useTerminalStore.getState().selectTab({ type: "settings" });
  },
  close: () => {
    set({ isOpen: false, activePanel: "menu" });
    const { viewStack, selectTab } = useTerminalStore.getState();
    if (viewStack[viewStack.length - 1]?.type === "settings") selectTab({ type: "list" });
  },
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

  openPwa: () => get().open("pwa"),
  openMenu: () => get().open("menu"),
}));

// The phone's settings screen IS a tab route, so the flag must follow the route and
// not only the paths that call open()/close(). The dock can switch tabs by itself
// (Sessions), and the browser Back can move the root too — either way the screen has
// to close. One subscription keeps both in step; desktop never moves the root, so
// its dialog flag is left alone.
useTerminalStore.subscribe((state, prev) => {
  const topOf = (stack) => stack[stack.length - 1]?.type === "settings";
  const now = topOf(state.viewStack);
  const was = topOf(prev.viewStack);
  if (now === was) return;
  useSlideMenuStore.setState(now ? { isOpen: true } : { isOpen: false, activePanel: "menu" });
});
