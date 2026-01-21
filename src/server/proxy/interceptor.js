/**
 * Service Worker registration script
 */

export function getInterceptorScript(targetPort) {
  return `
<script data-proxy-injected="true">
(function() {
  if (window.__proxyInterceptorLoaded) return;
  window.__proxyInterceptorLoaded = true;
  
  var targetPort = ${targetPort};
  var proxyBase = '/proxy/' + targetPort;
  
  console.log('[9Remote Proxy] Registering Service Worker for port:', targetPort);
  
  // Register Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register(proxyBase + '/sw.js', { scope: '/' })
      .then(function(registration) {
        console.log('[9Remote Proxy] Service Worker registered:', registration.scope);
        
        // Wait for SW to be active
        if (registration.active) {
          console.log('[9Remote Proxy] Service Worker already active');
        } else {
          registration.addEventListener('updatefound', function() {
            var worker = registration.installing;
            worker.addEventListener('statechange', function() {
              if (worker.state === 'activated') {
                console.log('[9Remote Proxy] Service Worker activated');
              }
            });
          });
        }
      })
      .catch(function(error) {
        console.error('[9Remote Proxy] Service Worker registration failed:', error);
      });
  } else {
    console.warn('[9Remote Proxy] Service Worker not supported');
  }
  
  // Notify parent iframe for navigation tracking
  function notifyParent(path) {
    if (window.parent !== window) {
      window.parent.postMessage({
        type: 'proxy-navigation',
        port: targetPort,
        path: path,
        url: 'http://localhost:' + targetPort + path
      }, '*');
    }
  }
  
  notifyParent(window.location.pathname.replace(proxyBase, '') || '/');
  
  window.addEventListener('popstate', function() {
    notifyParent(window.location.pathname.replace(proxyBase, '') || '/');
  });
})();
</script>`;
}
