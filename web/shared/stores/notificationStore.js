"use client";

import { create } from "zustand";
import { useConnectionStore } from "@/shared/stores/connectionStore";
import { useFleetStore, fleetBusOf } from "@/shared/stores/fleetStore";
import { sameEntry, sameMap } from "@/shared/utils/shallowEqual";

const omit = (obj, key) => {
  const { [key]: _dropped, ...rest } = obj;
  return rest;
};

export const useNotificationStore = create((set, get) => ({
  notifications: {},
  sessionStatus: {},

  handleStatusState: (state) => set((prev) => {
    const incoming = state || {};
    return sameMap(prev.sessionStatus, incoming) ? prev : { sessionStatus: incoming };
  }),

  handleStatusChange: ({ sessionId, state, tool, since, conversationId }) => {
    if (!sessionId) return;
    set((prev) => {
      const prevStatus = prev.sessionStatus[sessionId];
      const nextStatus = {
        state,
        tool: tool !== undefined ? tool : prevStatus?.tool,
        since,
        ...(conversationId || prevStatus?.conversationId ? { conversationId: conversationId || prevStatus?.conversationId } : {})
      };
      const sessionStatus = { ...prev.sessionStatus, [sessionId]: nextStatus };

      const badge = state === "done" || state === "blocked";
      let notifications = prev.notifications;
      if (!badge) {
        if (sessionId in prev.notifications) notifications = omit(prev.notifications, sessionId);
      } else {
        const nextBadge = { sessionId, type: state, tool, timestamp: since };
        if (!sameEntry(prev.notifications[sessionId], nextBadge)) {
          notifications = { ...prev.notifications, [sessionId]: nextBadge };
        }
      }

      return { sessionStatus, notifications };
    });
  },

  handleStatusCleared: (sessionId) => {
    if (!sessionId) return;
    set((prev) => {
      const existing = prev.sessionStatus[sessionId];
      if (!existing) return prev;
      return {
        sessionStatus: {
          ...prev.sessionStatus,
          [sessionId]: { state: "idle", tool: existing.tool, since: existing.since }
        }
      };
    });
  },

  handleNotificationState: (state) => set((prev) => {
    const incoming = state || {};
    return sameMap(prev.notifications, incoming) ? prev : { notifications: incoming };
  }),

  clearNotification: (sessionId) => {
    if (!sessionId) return;
    const { notifications, sessionStatus } = get();
    const state = sessionStatus[sessionId]?.state;
    // A blocked session is still waiting on the user: the agent refuses to clear it, so
    // neither do we — badge, status and wire all stay put rather than half-clearing.
    if (state === "blocked") return;
    if (!notifications[sessionId] && state !== "done") return;

    set((prev) => {
      const existing = prev.sessionStatus[sessionId];
      const nextNotifs = sessionId in prev.notifications
        ? omit(prev.notifications, sessionId)
        : prev.notifications;
      const nextStatus = existing?.state === "done"
        ? { ...prev.sessionStatus, [sessionId]: { state: "idle", tool: existing.tool, since: existing.since } }
        : prev.sessionStatus;
      return { notifications: nextNotifs, sessionStatus: nextStatus };
    });

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

  reset: () => set({ notifications: {}, sessionStatus: {} })
}));
