"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DESKTOP_BREAKPOINT, PERSIST_DEBOUNCE_MS } from "@/features/terminal/constants/terminalConfig";
import { OVERLAY_VIEWS, WORKSPACE_BASE } from "@/features/terminal/constants/routeConfig";
import { createLayoutSlice } from "./terminalSlices/createLayoutSlice";
import { createThemeSlice } from "./terminalSlices/createThemeSlice";
import { createAgentSlice } from "./terminalSlices/createAgentSlice";
import { createNavigationSlice } from "./terminalSlices/createNavigationSlice";

// Coalesced localStorage writer
const pendingWrite = { name: null, value: null };
let writeTimer = null;

const flushWrite = () => {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  if (pendingWrite.name === null) return;
  const { name, value } = pendingWrite;
  pendingWrite.name = null;
  pendingWrite.value = null;
  try { localStorage.setItem(name, JSON.stringify(value)); } catch {}
};

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushWrite);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushWrite();
  });
}

// Terminal UI state store - persisted to sessionStorage
export const useTerminalStore = create(
  persist(
    (set, get, api) => ({
      ...createNavigationSlice(set, get, api),
      ...createLayoutSlice(set, get, api),
      ...createThemeSlice(set, get, api),
      ...createAgentSlice(set, get, api)
    }),
    {
      name: "terminal-ui-state",
      partialize: (state) => ({
        viewStack: state.viewStack,
        openedSessions: state.openedSessions,
        agentBySession: state.agentBySession,
        activeWorkspaceId: state.activeWorkspaceId,
        collapsedWorkspaces: state.collapsedWorkspaces,
        webglEnabled: state.webglEnabled,
        fontSize: state.fontSize,
        terminalTheme: state.terminalTheme,
        terminalBackgrounds: state.terminalBackgrounds,
        terminalBackgroundOpacity: state.terminalBackgroundOpacity,
        backgroundBySession: state.backgroundBySession,
        showFolderButton: state.showFolderButton,
        showNoteButton: state.showNoteButton,
        noteChips: state.noteChips,
        pinnedNotes: state.pinnedNotes,
        sidebarCollapsed: state.sidebarCollapsed,
        sidebarWidth: state.sidebarWidth,
        fullModes: state.fullModes || {},
        fullMode: state.fullMode,
        hiddenPaneSessionIds: state.hiddenPaneSessionIds || [],
        paneWidths: state.paneWidths,
        rightPanelOpen: state.rightPanelOpen,
        rightPanelTabs: state.rightPanelTabs,
        rightPanelWidth: state.rightPanelWidth,
        editorPanelWidth: state.editorPanelWidth,
        hiddenHeaderButtons: state.hiddenHeaderButtons,
        hiddenHeaderButtonsMigrated: state.hiddenHeaderButtonsMigrated,
        mobileLowPower: state.mobileLowPower,
        mobileMode: state.mobileMode,
        mobilePanelWidth: state.mobilePanelWidth,
        mobileFloatRect: state.mobileFloatRect,
        artifactsBySession: state.artifactsBySession
      }),
      storage: {
        getItem: (name) => {
          if (typeof window === "undefined") return null;
          try {
            const value = localStorage.getItem(name);
            if (!value) return null;
            const parsed = JSON.parse(value);
            if (parsed && !Array.isArray(parsed.viewStack)) parsed.viewStack = [{ type: "list" }];
            return parsed;
          } catch {
            return null;
          }
        },
        setItem: (name, value) => {
          if (typeof window === "undefined") return;
          pendingWrite.name = name;
          pendingWrite.value = value;
          if (writeTimer) return;
          writeTimer = setTimeout(flushWrite, PERSIST_DEBOUNCE_MS);
        },
        removeItem: (name) => {
          if (typeof window === "undefined") return;
          if (pendingWrite.name === name) { pendingWrite.name = null; pendingWrite.value = null; }
          localStorage.removeItem(name);
        }
      },
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        if (!Array.isArray(state.viewStack) || state.viewStack.length === 0) {
          state.viewStack = [{ type: "list" }];
        }
        // Root /workspace is the welcome home now. A persisted stack with a
        // terminal on top is restored before route-sync settles, and store→URL
        // would then rewrite the address bar to that terminal — coerce here,
        // before any effect runs. Deep links (…/workspace/terminal/x) keep the stack.
        if (typeof window !== "undefined"
          && window.location.pathname.replace(/\/+$/, "") === WORKSPACE_BASE) {
          state.viewStack = [{ type: "list" }];
        }
        state.viewStack = state.viewStack.filter((v) => !OVERLAY_VIEWS.includes(v?.type));
        if (state.viewStack.length === 0) state.viewStack = [{ type: "list" }];
        if (!Array.isArray(state.terminalBackgrounds)) state.terminalBackgrounds = [];
        if (state.terminalBackground && state.terminalBackground !== "none" && state.terminalBackgrounds.length === 0) {
          state.terminalBackgrounds = [state.terminalBackground];
        }
        if (!state.agentBySession || typeof state.agentBySession !== "object") {
          state.agentBySession = {};
        }
        if (window.innerWidth < DESKTOP_BREAKPOINT) state.rightPanelOpen = false;
        if (!state.hiddenHeaderButtonsMigrated) {
          state.hiddenHeaderButtonsMigrated = true;
          if (!Array.isArray(state.hiddenHeaderButtons)) {
            state.hiddenHeaderButtons = ["mobile"];
          } else if (!state.hiddenHeaderButtons.includes("mobile")) {
            state.hiddenHeaderButtons = [...state.hiddenHeaderButtons, "mobile"];
          }
        }
      }
    }
  )
);
