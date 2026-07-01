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
export function useNotification(socketRef, connected) {
  const subscriptionRef = useRef(null);
  const [notifications, setNotifications] = useState({});
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

  // Subscribe to push notifications and send subscription to server
  const subscribeToPush = useCallback(async () => {
    if (!socketRef?.current) return;

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
        const subscription = await registration.pushManager.getSubscription();
        if (subscription) currentSocket.emit("pushSubscribe", subscription.toJSON());
      } catch (e) { /* ignore */ }
    })();
  }, [socketRef, connected, isExpoWebView]);

  // Listen for notification events from server
  useEffect(() => {
    const currentSocket = socketRef?.current;
    if (!currentSocket || !connected) return;

    const fetchState = () => currentSocket.emit("getNotificationState");

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
    currentSocket.on("connect", handleReconnect);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    // Request badge state after listeners are registered
    fetchState();

    return () => {
      currentSocket.off("notificationState", handleNotificationState);
      currentSocket.off("chatNotification", handleChatNotification);
      currentSocket.off("notificationCleared", handleNotificationCleared);
      currentSocket.off("connect", handleReconnect);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [socketRef, connected]);

  const clearNotification = useCallback((sessionId) => {
    if (!sessionId) return;
    setNotifications((prev) => {
      const { [sessionId]: _, ...rest } = prev;
      return rest;
    });
    socketRef.current?.emit("clearNotification", sessionId);
  }, [socketRef]);

  const unsubscribeFromPush = useCallback(async () => {
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

  return { subscribeToPush, unsubscribeFromPush, notifications, clearNotification };
}
