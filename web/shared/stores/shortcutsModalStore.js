"use client";

import { create } from "zustand";

// Standalone store so the settings menu and the global Mod+Shift+/ chord can both
// open the sheet without threading a callback through the workspace shell.
export const useShortcutsModalStore = create((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  toggle: () => set((state) => ({ isOpen: !state.isOpen }))
}));
