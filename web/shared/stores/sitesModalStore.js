"use client";

import { create } from "zustand";

// Standalone store so the header and the mobile pane strip can both raise the
// sites sheet — the header owns the modal itself, several levels away from a pane.
export const useSitesModalStore = create((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false })
}));
