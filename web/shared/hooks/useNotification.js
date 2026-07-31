"use client";

import { useEffect, useCallback, useRef, useState } from "react";
import { useTerminalStore } from "@/shared/stores/terminalStore";

/**
 * Hook to manage push notifications and chat notification events
 * Badge state is stored on server, synced to client via socket
 * On any chatNotification → re-fetch full state from server
 * NOTE: badge state shape here is `notifications` (object keyed by sessionId);
 * the agent preact UI uses a Set `finishedIds` (see agent/ui/src/lib/terminalSocket.js) — equivalent semantics.
 */
// Persisted across reloads; survives SW updates so toggle-off sticks
export const USER_DISABLED_KEY = "9remote:push:userDisabled";

export function useNotification(socketRef, connected) {
  const subscriptionRef = useRef(null);
  const [notifications, setNotifications] = useState({});
  // 4-state map: sessionId → { state, tool, since }
  const [sessionStatus, setSessionStatus] = useState({});
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
      socketRef?.current?.emit("visibilityChange", !!hidden);
    };
    return () => {
      try { delete window.handleAppStateChange; } catch (e) { window.handleAppStateChange = undefined; }
    };
  }, [socketRef, isExpoWebView]);

  // Subscribe to push notifications and send subscription to server
  const subscribeToPush = useCallback(async () => {
    if (!socketRef?.current) return;
    if (typeof window !== "undefined") localStorage.removeItem(USER_DISABLED_KEY);

    // Expo WebView: request token via native bridge
    if (isExpoWebView) {
      window.handleExpoPushToken = (token) => {
        socketRef.current?.emit("pushSubscribe", { type: "expo", token });
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

      // Await the socket callback so caller can rely on subscription being ready
      const vapidKey = await new Promise((resolve) => socketRef.current.emit("getVapidKey", resolve));
      if (!vapidKey) return;
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: vapidKey
        });
      }
      socketRef.current.emit("pushSubscribe", subscription.toJSON());
      // Sync current visibility so server knows focus state immediately
      socketRef.current.emit("visibilityChange", document.hidden);
      subscriptionRef.current = subscription;
    } catch (error) {
      console.error("Push notification setup failed:", error);
    }
  }, [socketRef, isExpoWebView]);

  // Auto re-send existing subscription on reconnect
  useEffect(() => {
    const currentSocket = socketRef?.current;
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
  }, [socketRef, connected, isExpoWebView]);

  // Listen for notification events from server
  useEffect(() => {
    const currentSocket = socketRef?.current;
    if (!currentSocket || !connected) return;

    const fetchState = () => {
      currentSocket.emit("getStatusState");
      currentSocket.emit("getNotificationState");
    };

    // Receive full 4-state map from server (idle/working/blocked/done)
    const handleStatusState = (state) => setSessionStatus(state || {});

    // Single status transition from a hook (working/blocked/done) — patch one entry
    const handleStatusChange = ({ sessionId, state, tool, since }) => {
      if (!sessionId) return;
      setSessionStatus((prev) => ({ ...prev, [sessionId]: { state, tool, since } }));
    };

    // Another client cleared a session's status → drop entry (→ idle)
    const handleStatusCleared = (sessionId) => {
      if (!sessionId) return;
      setSessionStatus((prev) => { const { [sessionId]: _, ...rest } = prev; return rest; });
    };

    // Receive full badge state from server, auto-clear active focused tab
    const handleNotificationState = (state) => {
      // Keep badges even for the focused session; cleared only on input (A) or switch (B)
      setNotifications(state || {});
    };

    // On any new notification → re-fetch full state (server is source of truth)
    const handleChatNotification = (n) => {
      fetchState();
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
    currentSocket.on("chatNotification", handleChatNotification);
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
      currentSocket.off("chatNotification", handleChatNotification);
      currentSocket.off("notificationCleared", handleNotificationCleared);
      currentSocket.off("statusState", handleStatusState);
      currentSocket.off("statusChange", handleStatusChange);
      currentSocket.off("statusCleared", handleStatusCleared);
      currentSocket.off("connect", handleReconnect);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [socketRef, connected]);

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
    setNotifications((prev) => {
      const { [sessionId]: _, ...rest } = prev;
      return rest;
    });
    // Only drop status if DONE (seen → idle). working/blocked must persist — focusing a running
    // agent must not erase its spinner.
    setSessionStatus((prev) => {
      if (!prev[sessionId] || prev[sessionId].state !== "done") return prev;
      const { [sessionId]: _, ...rest } = prev;
      return rest;
    });
    socketRef.current?.emit("clearNotification", sessionId);
    socketRef.current?.emit("clearStatus", sessionId);
  }, [socketRef]);

  const unsubscribeFromPush = useCallback(async () => {
    if (typeof window !== "undefined") localStorage.setItem(USER_DISABLED_KEY, "1");
    try {
      if (subscriptionRef.current?.type === "expo") {
        socketRef.current?.emit("pushUnsubscribe", subscriptionRef.current.token);
        subscriptionRef.current = null;
        return;
      }
      if (subscriptionRef.current) {
        await subscriptionRef.current.unsubscribe();
        socketRef.current?.emit("pushUnsubscribe", subscriptionRef.current.endpoint);
        subscriptionRef.current = null;
      } else {
        const registration = await navigator.serviceWorker.ready;
        const sub = await registration.pushManager.getSubscription();
        if (sub) {
          socketRef.current?.emit("pushUnsubscribe", sub.endpoint);
          await sub.unsubscribe();
        }
      }
    } catch (error) {
      console.error("Push unsubscribe failed:", error);
    }
  }, [socketRef]);

  return { subscribeToPush, unsubscribeFromPush, notifications, sessionStatus, clearNotification };
}
