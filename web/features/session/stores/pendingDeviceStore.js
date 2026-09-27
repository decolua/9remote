"use client";

import { create } from "zustand";

// Pending device approval, shared between the global approval modal and the
// agent dashboard view (which force-opens its Clients section on it).
// `bump` ticks after every approve/reject so list holders know to refetch —
// the agent's approve/reject endpoints emit no refresh event of their own.
export const usePendingDeviceStore = create((set) => ({
  pendingDevice: null,
  setPendingDevice: (device) => set({ pendingDevice: device }),
  clearPendingDevice: () => set({ pendingDevice: null }),
  bump: 0,
  touchBump: () => set((s) => ({ bump: s.bump + 1 }))
}));
