"use client";

import { useEffect, useCallback, useRef, useState } from "react";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { sameEntry, sameMap } from "@/shared/utils/shallowEqual";

/**
 * Hook to manage push notifications and chat notification events
 * Badge state is stored on server, synced to client via bus
 * Live updates arrive as statusChange (one entry); full maps are refetched only on
 * reconnect and when another client clears a badge.
 * NOTE: badge state shape here is `notifications` (object keyed by sessionId);
 * the agent preact UI uses a Set `finishedIds` (see agent/ui/src/lib/terminalSocket.js) — equivalent semantics.
 */
// Persisted across reloads; survives SW updates so toggle-off sticks
export const USER_DISABLED_KEY = "9remote:push:userDisabled";

const omit = (obj, key) => {
  const { [key]: _dropped, ...rest } = obj;
  return rest;
};

export function useNotification(busRef, connected) {
  const subscriptionRef = useRef(null);
  const [notifications, setNotifications] = useState({});
  // 4-state map: sessionId → { state, tool, since }
  const [sessionStatus, setSessionStatus] = useState({});
  // Mirrors of the two maps, read by clearNotification so it can bail out without
  // depending on them — it fires on every keystroke, and a changed identity there
  // would re-render the whole workspace once per typed character.
  const notificationsRef = useRef(notifications);
  const sessionStatusRef = useRef(sessionStatus);
  useEffect(() => { notificationsRef.current = notifications; }, [notifications]);
  useEffect(() => { sessionStatusRef.current = sessionStatus; }, [sessionStatus]);
  const getSelectedSession = useTerminalStore((state) => state.getSelectedSession);
  const getCurrentView = useTerminalStore((state) => state.getCurrentView);
  const pushView = useTerminalStore((state) => state.pushView);
  const addOpenedSession = useTerminalStore((state) => state.addOpenedSession);

  const isExpoWebView = typeof window !== "undefined" && !!window.ReactNativeWebView;

  // Expose deep-link handler for native notification tap (Expo WebView)
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.handleNotificationTap = (payload) => {
      const sessionId = payload?.sessionId;
      if (!sessionId) return;
      addOpenedSession(sessionId);
      pushView({ type: "terminal", sessionId });
    };
    return () => {
      try { delete window.handleNotificationTap; } catch (e) { window.handleNotificationTap = undefined; }
    };
  }, [pushView, addOpenedSession]);

  // Native shell drives focus state: document.hidden never flips inside a WebView
  useEffect(() => {
    if (typeof window === "undefined" || !isExpoWebView) return;
    window.handleAppStateChange = (hidden) => {
      busRef?.current?.emit("visibilityChange", !!hidden);
    };
    return () => {
      try { delete window.handleAppStateChange; } catch (e) { window.handleAppStateChange = undefined; }
    };
  }, [busRef, isExpoWebView]);

  // Subscribe to push notifications and send subscription to server
  const subscribeToPush = useCallback(async () => {
    if (!busRef?.current) return;
    if (typeof window !== "undefined") localStorage.removeItem(USER_DISABLED_KEY);

    // Expo WebView: request token via native bridge
    if (isExpoWebView) {
      window.handleExpoPushToken = (token) => {
        busRef.current?.emit("pushSubscribe", { type: "expo", token });
        subscriptionRef.current = { type: "expo", token };
      };
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: "REQUEST_PUSH_TOKEN" }));
      return;
    }

    // PWA: WebPush via Service Worker
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      console.warn("🔕 Push not supported");
      return;
    }
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") return;

      const registration = await navigator.serviceWorker.ready;
      if (!registration.pushManager) return;

      // Await the bus callback so caller can rely on subscription being ready
      const vapidKey = await new Promise((resolve) => busRef.current.emit("getVapidKey", resolve));
      if (!vapidKey) return;
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: vapidKey
        });
      }
      busRef.current.emit("pushSubscribe", subscription.toJSON());
      // Sync current visibility so server knows focus state immediately
      busRef.current.emit("visibilityChange", document.hidden);
      subscriptionRef.current = subscription;
    } catch (error) {
      console.error("Push notification setup failed:", error);
    }
  }, [busRef, isExpoWebView]);

  // Auto re-send existing subscription on reconnect
  useEffect(() => {
    const currentSocket = busRef?.current;
    if (!currentSocket || !connected) return;
    // Honor explicit user toggle-off (survives SW updates and reloads)
    if (typeof window !== "undefined" && localStorage.getItem(USER_DISABLED_KEY) === "1") return;

    if (isExpoWebView) {
      // Re-request token via bridge to update socketId on server
      window.handleExpoPushToken = (token) => {
        currentSocket.emit("pushSubscribe", { type: "expo", token });
        subscriptionRef.current = { type: "expo", token };
      };
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: "REQUEST_PUSH_TOKEN" }));
      return;
    }

    (async () => {
      try {
        if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
        const registration = await navigator.serviceWorker.ready;
        if (!registration.pushManager) return;
        let subscription = await registration.pushManager.getSubscription();
        // iOS silently drops the sub on SW update/expiry. Re-subscribe if permission
        // is still granted so the toggle doesn't turn itself off between deploys.
        if (!subscription && Notification.permission === "granted") {
          const vapidKey = await new Promise((resolve) => currentSocket.emit("getVapidKey", resolve));
          if (vapidKey) {
            subscription = await registration.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: vapidKey
            });
          }
        }
        if (subscription) {
          currentSocket.emit("pushSubscribe", subscription.toJSON());
          // Re-sync focus state — addPushSubscription keeps stale hidden flag otherwise
          currentSocket.emit("visibilityChange", document.hidden);
        }
      } catch (e) { /* ignore */ }
    })();
  }, [busRef, connected, isExpoWebView]);

  // Listen for notification events from server
  useEffect(() => {
    const currentSocket = busRef?.current;
    if (!currentSocket || !connected) return;

    const fetchState = () => {
      currentSocket.emit("getStatusState");
      currentSocket.emit("getNotificationState");
    };

    // Receive full 4-state map from server (idle/working/blocked/done).
    // Preserve last-known tool for sessions the agent cleared (no longer in map)
    // so the agent icon persists when idle.
    const handleStatusState = (state) => {
      setSessionStatus((prev) => {
        const incoming = state || {};
        const merged = { ...incoming };
        for (const [id, s] of Object.entries(prev)) {
          if (!merged[id] && s.tool) {
            merged[id] = { state: "idle", tool: s.tool, since: s.since };
          } else if (merged[id] && !merged[id].tool && s.tool) {
            merged[id] = { ...merged[id], tool: s.tool };
          }
        }
        return sameMap(prev, merged) ? prev : merged;
      });
    };

    // Single status transition from a hook (working/blocked/done) — patch one entry.
    // conversationId rides along when the CLI's hook reported it; kept across transitions.
    const handleStatusChange = ({ sessionId, state, tool, since, conversationId }) => {
      if (!sessionId) return;
      setSessionStatus((prev) => ({
        ...prev,
        [sessionId]: {
          state, tool: tool || prev[sessionId]?.tool, since,
          ...(conversationId || prev[sessionId]?.conversationId ? { conversationId: conversationId || prev[sessionId]?.conversationId } : {}),
        },
      }));
      // The badge map is the done/blocked subset of the same state — mirroring it here
      // is what the chatNotification refetch used to cost two round-trips to learn.
      // Shape matches the agent's getNotifications() entries.
      const badge = state === "done" || state === "blocked";
      setNotifications((prev) => {
        if (!badge) return sessionId in prev ? omit(prev, sessionId) : prev;
        const next = { sessionId, type: state, tool, timestamp: since };
        return sameEntry(prev[sessionId], next) ? prev : { ...prev, [sessionId]: next };
      });
    };

    // Another client cleared a session's status → mark idle, keep tool (icon persists)
    const handleStatusCleared = (sessionId) => {
      if (!sessionId) return;
      setSessionStatus((prev) => {
        const existing = prev[sessionId];
        if (!existing) return prev;
        return { ...prev, [sessionId]: { state: "idle", tool: existing.tool, since: existing.since } };
      });
    };

    // Receive full badge state from server, auto-clear active focused tab
    const handleNotificationState = (state) => {
      // Keep badges even for the focused session; cleared only on input (A) or switch (B)
      const incoming = state || {};
      setNotifications((prev) => (sameMap(prev, incoming) ? prev : incoming));
    };

    // Another client cleared a badge → re-fetch to stay in sync
    const handleNotificationCleared = () => fetchState();

    // Notify server when visibility changes → server gates push on this (no ack round-trip)
    const handleVisibilityChange = () => {
      currentSocket.emit("visibilityChange", document.hidden);
    };

    // Fetch latest notification state after reconnect
    const handleReconnect = () => fetchState();

    currentSocket.on("notificationState", handleNotificationState);
    currentSocket.on("notificationCleared", handleNotificationCleared);
    currentSocket.on("statusState", handleStatusState);
    currentSocket.on("statusChange", handleStatusChange);
    currentSocket.on("statusCleared", handleStatusCleared);
    currentSocket.on("connect", handleReconnect);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    // Request badge state after listeners are registered
    fetchState();

    return () => {
      currentSocket.off("notificationState", handleNotificationState);
      currentSocket.off("notificationCleared", handleNotificationCleared);
      currentSocket.off("statusState", handleStatusState);
      currentSocket.off("statusChange", handleStatusChange);
      currentSocket.off("statusCleared", handleStatusCleared);
      currentSocket.off("connect", handleReconnect);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [busRef, connected]);

  // Sync in-app notification count → PWA icon badge (Android/desktop Chrome/Edge/Brave; iOS ignores)
  useEffect(() => {
    if (typeof navigator === "undefined" || !("setAppBadge" in navigator)) return;
    const count = Object.keys(notifications).length;
    if (count > 0) {
      navigator.setAppBadge(count).catch(() => {});
    } else {
      navigator.clearAppBadge().catch(() => {});
    }
  }, [notifications]);

  const clearNotification = useCallback((sessionId) => {
    if (!sessionId) return;
    const hasBadge = !!notificationsRef.current[sessionId];
    const hasDone = sessionStatusRef.current[sessionId]?.state === "done";
    // Nothing to clear — typing into an already-clean session must stay free.
    if (!hasBadge && !hasDone) return;
    setNotifications((prev) => {
      if (!(sessionId in prev)) return prev;
      const { [sessionId]: _, ...rest } = prev;
      return rest;
    });
    // Only drop status if DONE (seen → idle). working/blocked must persist — focusing a running
    // agent must not erase its spinner. Keep tool so the agent icon survives when idle.
    setSessionStatus((prev) => {
      const existing = prev[sessionId];
      if (!existing || existing.state !== "done") return prev;
      return { ...prev, [sessionId]: { state: "idle", tool: existing.tool, since: existing.since } };
    });
    // Mark cleared right away: the refs only re-sync after commit, so a second call
    // in the same tick (fast typing, paste) would otherwise pass the guard again.
    if (hasBadge) { const { [sessionId]: _b, ...rest } = notificationsRef.current; notificationsRef.current = rest; }
    if (hasDone) sessionStatusRef.current = {
      ...sessionStatusRef.current,
      [sessionId]: { ...sessionStatusRef.current[sessionId], state: "idle" },
    };
    busRef.current?.emit("clearNotification", sessionId);
    busRef.current?.emit("clearStatus", sessionId);
  }, [busRef]);

  const unsubscribeFromPush = useCallback(async () => {
    if (typeof window !== "undefined") localStorage.setItem(USER_DISABLED_KEY, "1");
    try {
      if (subscriptionRef.current?.type === "expo") {
        busRef.current?.emit("pushUnsubscribe", subscriptionRef.current.token);
        subscriptionRef.current = null;
        return;
      }
      if (subscriptionRef.current) {
        await subscriptionRef.current.unsubscribe();
        busRef.current?.emit("pushUnsubscribe", subscriptionRef.current.endpoint);
        subscriptionRef.current = null;
      } else {
        const registration = await navigator.serviceWorker.ready;
        const sub = await registration.pushManager.getSubscription();
        if (sub) {
          busRef.current?.emit("pushUnsubscribe", sub.endpoint);
          await sub.unsubscribe();
        }
      }
    } catch (error) {
      console.error("Push unsubscribe failed:", error);
    }
  }, [busRef]);

  return { subscribeToPush, unsubscribeFromPush, notifications, sessionStatus, clearNotification };
}
