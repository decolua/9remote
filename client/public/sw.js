// Service Worker - Network First Strategy (Always fetch fresh content)
const CACHE_NAME = "9remote-v1";

// Install event - cache essential assets
self.addEventListener("install", (event) => {
  self.skipWaiting(); // Activate immediately
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll([
        "/",
        "/workspace/",
        "/remote/",
        "/manifest.json"
      ]).catch(() => {
        // Ignore cache errors during install
        console.log("Cache install failed, continuing anyway");
      });
    })
  );
});

// Activate event - clean old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  return self.clients.claim(); // Take control immediately
});

// Fetch event - Network first, fallback to cache
self.addEventListener("fetch", (event) => {
  // Only cache GET requests (Cache API doesn't support POST/PUT/DELETE)
  const isGetRequest = event.request.method === "GET";
  
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Only cache GET requests
        if (isGetRequest) {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return response;
      })
      .catch(() => {
        // Network failed, try cache (only for GET requests)
        if (isGetRequest) {
          return caches.match(event.request).then((cachedResponse) => {
            if (cachedResponse) {
              return cachedResponse;
            }
            // No cache available
            return new Response("Offline - No cached version available", {
              status: 503,
              statusText: "Service Unavailable"
            });
          });
        }
        // Non-GET requests: return error
        return new Response("Network error", {
          status: 503,
          statusText: "Service Unavailable"
        });
      })
  );
});
