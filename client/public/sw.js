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

    event.waitUntil(
      self.registration.showNotification(title, options)
    );
  } catch (error) {
    console.error("Push event error:", error);
  }
});

// Notification click - open/focus the app
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const url = event.notification.data?.url || "/workspace";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      // Focus existing window if found
      for (const client of clientList) {
        if (client.url.includes("/workspace") && "focus" in client) {
          return client.focus();
        }
      }
      // Open new window
      return self.clients.openWindow(url);
    })
  );
});
