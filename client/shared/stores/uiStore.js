"use client";

import { create } from "zustand";

// UI state store - runtime only (no persistence)
export const useUIStore = create((set) => ({
  // Keyboard state
  isKeyboardOpen: false,
  setKeyboardOpen: (isOpen) => {
    set({ isKeyboardOpen: isOpen });
    // Toggle body class for CSS
    if (typeof document !== "undefined") {
      document.body.classList.toggle("keyboard-open", isOpen);
    }
  }
}));
