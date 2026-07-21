// Service Worker - NO CACHE + WebPush Notifications
// Handles PWA installation and push notifications

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => caches.delete(cacheName))
      );
    })
  );
  return self.clients.claim();
});

// Fetch event - Always network, no cache
self.addEventListener("fetch", (event) => {
  event.respondWith(
    fetch(event.request, {
      cache: "no-store"
    })
  );
});

// Push notification received
self.addEventListener("push", (event) => {
  if (!event.data) return;

  event.waitUntil(
    (async () => {
      // Skip when a PWA window is focused — backstop against stale server focus state
      const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (clientList.some((c) => c.visibilityState === "visible")) return;

      try {
        const data = event.data.json();
        const title = data.title || "9Remote";
        const options = {
          body: data.body || "Notification",
          icon: "/icon-192.svg",
          badge: "/icon-192.svg",
          data: data.data || { url: "/workspace" },
          vibrate: [200, 100, 200],
          tag: "9remote-notification",
          renotify: true
        };
        await self.registration.showNotification(title, options);

        // PWA icon badge (Android/desktop Chrome/Edge/Brave) — iOS silently ignores
        if (self.registration.setAppBadge) {
          const badgeCount = typeof data.badge === "number" ? data.badge : 1;
          await self.registration.setAppBadge(badgeCount);
        }
      } catch (error) {
        console.error("Push event error:", error);
      }
    })()
  );
});

// Notification click - focus any same-origin client and deep-link into it
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  // User acknowledged → clear icon badge
  if (self.registration.clearAppBadge) {
    self.registration.clearAppBadge().catch(() => {});
  }

  const url = event.notification.data?.url || "/workspace";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      // Focus any existing same-origin client to preserve auth/state
      for (const client of clientList) {
        if ("focus" in client) {
          client.postMessage({ type: "NOTIFICATION_CLICK", url });
          return client.focus();
        }
      }
      // No existing client — open a new one
      return self.clients.openWindow(url);
    })
  );
});
