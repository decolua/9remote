"use client";

import { create } from "zustand";
import { APPROVAL_STATUS } from "@/shared/constants/transport";

export const useConnectionStore = create((set) => ({
  bus: null,
  busRef: { current: null },
  protocolRef: { current: null },
  connected: false,
  // The user dropped this connection on purpose ( Disconnect): the workspace
  // must not cover itself with the loading gate or the retry screen — the
  // host's row shows offline and its connect button is the way back.
  deliberate: false,
  connectionMode: "tunnel",
  carrier: "ws",
  // Device admission for the ACTIVE host's connection — store-owned (not hook
  // state) so a re-key resets them with the connection, not with a component.
  approvalStatus: null, // null | APPROVAL_STATUS
  admitted: false,      // sticky: carrier connection precedes TAIL proof
  // The host's apiKey HEAD the workspace connection serves. Reactive mirror of
  // sessionStorage — setAuthData bumps it and useBus re-keys in place, which is
  // what makes switching hosts possible without a page reload.
  authKey: null,
  // The WS endpoint actually in use (auth.tunnelUrl at connect time) — the
  // status bar shows it so "local vs tunnel" is verifiable, not guessed.
  endpoint: null,
  retryStatus: { isRetrying: false, attempt: 0, maxAttempts: 10, failed: false },

  setConnection: (patch) => set((prev) => ({ ...prev, ...patch })),
  setConnected: (connected) => set({ connected }),
  setCarrier: (carrier) => set({ carrier }),
  setConnectionMode: (connectionMode) => set({ connectionMode }),
  setRetryStatus: (retryStatus) => set({ retryStatus }),
  setAuthKey: (authKey) => set({ authKey }),
  setAdmitted: (admitted) => set({ admitted }),
  // Unified device-approval verdict, arriving from socket.io OR the DO
  // signaling relay. A reconnect keeps a standing approval; a pending after
  // approved is a stale late signal.
  applyApproval: (next) => set((prev) => {
    const cur = prev.approvalStatus;
    if (next === APPROVAL_STATUS.reconnect) return cur === APPROVAL_STATUS.approved ? { approvalStatus: null } : {};
    if (cur === APPROVAL_STATUS.approved && next === APPROVAL_STATUS.pending) return {};
    return { approvalStatus: next };
  }),
  // NOTE: reset() deliberately keeps authKey — a transient disconnect must not
  // look like a host switch (which would tear the connection down). Admission
  // state DOES reset: it belongs to the connection being dropped.
  reset: () => set({
    bus: null,
    connected: false,
    deliberate: false,
    connectionMode: "tunnel",
    carrier: "ws",
    endpoint: null,
    approvalStatus: null,
    admitted: false,
    retryStatus: { isRetrying: false, attempt: 0, maxAttempts: 10, failed: false }
  })
}));
