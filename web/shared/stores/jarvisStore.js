"use client";

import { create } from "zustand";
import { JARVIS_DEFAULT_SETTINGS, JARVIS_LS_KEY } from "@/shared/lib/jarvisConstants";

// Jarvis surface state: whether the coordinator view is open, and the per-device
// settings (harness engine, model, effort, voice behaviors). The session itself
// is an ordinary AI session under JARVIS_SESSION_ID — nothing else about it is
// special on this side of the wire.
const save = (settings) => {
  try { localStorage.setItem(JARVIS_LS_KEY, JSON.stringify(settings)); } catch {}
};

const read = () => {
  if (typeof window === "undefined") return {};
  try {
    const saved = JSON.parse(localStorage.getItem(JARVIS_LS_KEY));
    return saved && typeof saved === "object" ? saved : {};
  } catch { return {}; }
};

// One migration: before the LLM config was split, a single Google key served
// both — carry it into the chat side so nobody re-pastes it after an upgrade.
function hydrate() {
  const merged = { ...JARVIS_DEFAULT_SETTINGS, ...read() };
  if (!merged.llmKey && merged.liveKey) merged.llmKey = merged.liveKey;
  return merged;
}

export const useJarvisStore = create((set, get) => ({
  open: false,
  settings: { ...JARVIS_DEFAULT_SETTINGS },

  setOpen: (open) => set({ open: !!open }),
  toggle: () => set((s) => ({ open: !s.open })),

  hydrateSettings: () => set({ settings: hydrate() }),

  // A partial patch persists and merges; unknown keys fall through harmlessly.
  setSettings: (patch) => {
    const next = { ...get().settings, ...(patch && typeof patch === "object" ? patch : {}) };
    save(next);
    set({ settings: next });
  }
}));

// Hydrate once in the browser — every consumer is a client component.
if (typeof window !== "undefined") {
  useJarvisStore.getState().hydrateSettings();
}
