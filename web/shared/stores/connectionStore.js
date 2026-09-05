"use client";

import { create } from "zustand";

export const useConnectionStore = create((set) => ({
  bus: null,
  busRef: { current: null },
  protocolRef: { current: null },
  connected: false,
  connectionMode: "tunnel",
  carrier: "ws",
  retryStatus: { isRetrying: false, attempt: 0, maxAttempts: 10, failed: false },

  setConnection: (patch) => set((prev) => ({ ...prev, ...patch })),
  setConnected: (connected) => set({ connected }),
  setCarrier: (carrier) => set({ carrier }),
  setConnectionMode: (connectionMode) => set({ connectionMode }),
  setRetryStatus: (retryStatus) => set({ retryStatus }),
  reset: () => set({
    bus: null,
    connected: false,
    connectionMode: "tunnel",
    carrier: "ws",
    retryStatus: { isRetrying: false, attempt: 0, maxAttempts: 10, failed: false }
  })
}));
