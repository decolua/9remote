/**
 * Service Worker script generator for proxy URL rewriting
 * SW intercepts all fetch requests and rewrites URLs to include proxy prefix
 */

export function getServiceWorkerScript(targetPort) {
  const proxyBase = `/proxy/${targetPort}`;
  
  return `
// Service Worker for 9Remote Proxy - Port ${targetPort}
const PROXY_BASE = '${proxyBase}';
const TARGET_PORT = ${targetPort};

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  
  // Only intercept same-origin requests
  if (url.origin !== location.origin) {
    return;
  }
  
  // Skip if already has proxy prefix
  if (url.pathname.startsWith(PROXY_BASE)) {
    return;
  }
  
  // Skip service worker and socket.io requests
  if (url.pathname.includes('/sw.js') || url.pathname.includes('socket.io')) {
    return;
  }
  
  // Rewrite URL to include proxy prefix
  const newUrl = new URL(url);
  newUrl.pathname = PROXY_BASE + url.pathname;
  
  // Build request init object
  const requestInit = {
    method: event.request.method,
    headers: event.request.headers,
    mode: event.request.mode,
    credentials: event.request.credentials,
    cache: event.request.cache,
    redirect: event.request.redirect,
    referrer: event.request.referrer,
    integrity: event.request.integrity
  };
  
  // Add body and duplex for POST/PUT/PATCH requests
  if (event.request.body) {
    requestInit.body = event.request.body;
    requestInit.duplex = 'half';
  }
  
  event.respondWith(fetch(new Request(newUrl, requestInit)));
});
`;
}

/**
 * Script to register the Service Worker - injected into HTML
 */
export function getSwRegistrationScript(targetPort) {
  const proxyBase = `/proxy/${targetPort}`;
  
  return `
<script data-proxy-injected="true">
(function() {
  if (window.__proxySwRegistered) return;
  window.__proxySwRegistered = true;
  
  const proxyBase = '${proxyBase}';
  const swUrl = proxyBase + '/sw.js';
  
  if ('serviceWorker' in navigator) {
    // Unregister all old SWs first
    navigator.serviceWorker.getRegistrations().then(function(registrations) {
      return Promise.all(registrations.map(function(reg) {
        return reg.unregister();
      }));
    }).then(function() {
      return navigator.serviceWorker.register(swUrl, { scope: '/' });
    }).then(function(reg) {
      // If SW is not controlling this page yet, wait and reload
      if (!navigator.serviceWorker.controller) {
        // Wait for SW to become active
        var worker = reg.installing || reg.waiting || reg.active;
        if (worker) {
          if (worker.state === 'activated') {
            window.location.reload();
          } else {
            worker.addEventListener('statechange', function() {
              if (worker.state === 'activated') {
                window.location.reload();
              }
            });
          }
        }
      }
    }).catch(function(err) {
      console.error('[9Remote] SW registration failed:', err);
    });
  }
})();
</script>`;
}
