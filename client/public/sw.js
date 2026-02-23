// Service Worker - NO CACHE (Always fetch fresh)
// This SW only handles PWA installation, no caching

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Clear all existing caches
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
