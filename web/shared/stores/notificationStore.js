"use client";

import { create } from "zustand";
import { useConnectionStore } from "@/shared/stores/connectionStore";
import { useFleetStore, fleetBusOf } from "@/shared/stores/fleetStore";
import { sameEntry, sameMap } from "@/shared/utils/shallowEqual";

const omit = (obj, key) => {
  const { [key]: _dropped, ...rest } = obj;
  return rest;
};

// A session's status entry, whichever host owns it — the fleet store is the
// single status lane now. Resolved via fleetStore directly: hostConn imports
// this store, the reverse would cycle.
const hostStatusOf = (sessionId) => {
  const { hosts } = useFleetStore.getState();
  for (const h of Object.values(hosts)) {
    const st = h.statusMap?.[sessionId];
    if (st) return st;
  }
  return null;
};

export const useNotificationStore = create((set, get) => ({
  notifications: {},

  // Badges only — the status map itself lives in each host's fleet entry.
  handleStatusChange: ({ sessionId, state, tool, since } = {}) => {
    if (!sessionId) return;
    set((prev) => {
      const badge = state === "done" || state === "blocked";
      let notifications = prev.notifications;
      if (!badge) {
        if (sessionId in prev.notifications) notifications = omit(prev.notifications, sessionId);
      } else {
        const nextBadge = { sessionId, type: state, tool: tool !== undefined ? tool : hostStatusOf(sessionId)?.tool, timestamp: since };
        if (!sameEntry(prev.notifications[sessionId], nextBadge)) {
          notifications = { ...prev.notifications, [sessionId]: nextBadge };
        }
      }
      return { notifications };
    });
  },

  handleNotificationState: (state) => set((prev) => {
    const incoming = state || {};
    return sameMap(prev.notifications, incoming) ? prev : { notifications: incoming };
  }),

  clearNotification: (sessionId) => {
    if (!sessionId) return;
    const state = hostStatusOf(sessionId)?.state;
    // A blocked session is still waiting on the user: the agent refuses to clear it, so
    // neither do we — badge and wire both stay put rather than half-clearing.
    if (state === "blocked") return;
    if (!get().notifications[sessionId] && state !== "done") return;

    set((prev) => ({
      notifications: sessionId in prev.notifications
        ? omit(prev.notifications, sessionId)
        : prev.notifications
    }));

    // The clear goes to the machine OWNING the session — typing in a fleet pane must
    // clear that host's dot, not poke an unknown id on the main agent. (Resolved
    // via fleetStore directly: hostConn imports this store, the reverse would cycle.)
    let bus = null;
    const { hosts } = useFleetStore.getState();
    for (const h of Object.values(hosts)) {
      if (h.sessions?.some((s) => s.id === sessionId)) { bus = fleetBusOf(h.key); break; }
    }
    bus = bus || useConnectionStore.getState().busRef?.current || useConnectionStore.getState().bus;
    // One event, not two: the agent's clearStatus broadcasts BOTH statusCleared and
    // notificationCleared, and this client refetches on each — two emits meant two
    // round-trips for one clear.
    bus?.emit("clearStatus", sessionId);
  },

  reset: () => set({ notifications: {} })
}));
