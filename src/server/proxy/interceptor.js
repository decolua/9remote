/**
 * Navigation interceptor script injected into proxied pages
 */

export function getInterceptorScript(targetPort) {
  return `
<script data-proxy-injected="true">
(function() {
  if (window.__proxyInterceptorLoaded) return;
  window.__proxyInterceptorLoaded = true;
  
  var targetPort = ${targetPort};
  var proxyBase = '/proxy/' + targetPort;
  
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
  
  var origPushState = history.pushState;
  var origReplaceState = history.replaceState;
  
  history.pushState = function() {
    origPushState.apply(this, arguments);
    notifyParent(window.location.pathname.replace(proxyBase, '') || '/');
  };
  
  history.replaceState = function() {
    origReplaceState.apply(this, arguments);
    notifyParent(window.location.pathname.replace(proxyBase, '') || '/');
  };
  
  window.addEventListener('popstate', function() {
    notifyParent(window.location.pathname.replace(proxyBase, '') || '/');
  });
  
  document.addEventListener('click', function(e) {
    var target = e.target.closest('a');
    if (target && target.href) {
      setTimeout(function() {
        notifyParent(window.location.pathname.replace(proxyBase, '') || '/');
      }, 100);
    }
  });
})();
</script>`;
}
