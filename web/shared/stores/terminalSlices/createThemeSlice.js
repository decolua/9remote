import {
  TERMINAL_BG_ALPHA, TERMINAL_BG_OPACITY
} from "@/features/terminal/constants/terminalConfig";

export const createThemeSlice = (set) => ({
  // WebGL renderer toggle
  webglEnabled: true,
  setWebglEnabled: (enabled) => set({ webglEnabled: !!enabled }),

  // Terminal font size
  fontSize: null,
  setFontSize: (size) => set({ fontSize: size ? Math.max(10, Math.min(18, Math.round(size))) : null }),

  // Terminal theme
  terminalTheme: "default",
  setTerminalTheme: (key) => set({ terminalTheme: key || "default" }),

  // Background pool & opacity
  terminalBackgrounds: ["art8"],
  setTerminalBackgrounds: (keys) => set({ terminalBackgrounds: Array.isArray(keys) ? keys.filter(Boolean) : [] }),

  terminalBackgroundOpacity: null,
  setTerminalBackgroundOpacity: (v) => set({
    terminalBackgroundOpacity: v == null
      ? TERMINAL_BG_ALPHA
      : Number((Math.max(TERMINAL_BG_OPACITY.min, Math.min(TERMINAL_BG_OPACITY.max, Math.round(v / TERMINAL_BG_OPACITY.step) * TERMINAL_BG_OPACITY.step)).toFixed(2)))
  }),

  customBackgrounds: [],
  setCustomBackgrounds: (items) => set({ customBackgrounds: Array.isArray(items) ? items.filter((it) => it?.id && it?.dataUrl) : [] }),

  // Quick action buttons
  showFolderButton: true,
  showNoteButton: false,
  setShowFolderButton: (v) => set({ showFolderButton: !!v }),
  setShowNoteButton: (v) => set({ showNoteButton: !!v }),

  // Note chips & pinned notes
  noteChips: [],
  addNoteChip: (text) => set((state) => ({ noteChips: [...state.noteChips, text] })),
  removeNoteChip: (text) => set((state) => ({ noteChips: state.noteChips.filter((c) => c !== text) })),

  pinnedNotes: {},
  setNotePinned: (sessionId, pinned) => set((state) => {
    const next = { ...state.pinnedNotes };
    if (pinned) next[sessionId] = true;
    else delete next[sessionId];
    return { pinnedNotes: next };
  })
});
