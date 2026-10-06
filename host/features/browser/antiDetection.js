// Anti-detection script ported from Orca to prevent bot-detection on automated Chrome.
export const ANTI_DETECTION_SCRIPT = `(function() {
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
  if (navigator.plugins.length === 0) {
    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
        { name: 'Native Client', filename: 'internal-nacl-plugin' }
      ]
    });
  }
  if (!window.chrome) window.chrome = {};
  if (!window.chrome.runtime) window.chrome.runtime = {};
  if (!window.chrome.csi) {
    window.chrome.csi = function() { return { startE: Date.now(), onloadT: Date.now(), pageT: performance.now(), tran: 15 }; };
  }
  if (!window.chrome.loadTimes) {
    window.chrome.loadTimes = function() {
      var now = Date.now() / 1000;
      return { commitLoadTime: now, connectionInfo: 'h2', finishDocumentLoadTime: now, finishLoadTime: now,
        firstPaintAfterLoadTime: 0, firstPaintTime: now, navigationType: 'Other', npnNegotiatedProtocol: 'h2',
        requestTime: now - 0.16, startLoadTime: now - 0.3, wasAlternateProtocolAvailable: false,
        wasFetchedViaSpdy: true, wasNpnNegotiated: true };
    };
  }
  try {
    var permQuery = Permissions.prototype.query;
    var promptPerms = new Set(['geolocation', 'camera', 'microphone', 'midi', 'idle-detection', 'storage-access']);
    Permissions.prototype.query = function(desc) {
      if (desc && (desc.name === 'notifications' || promptPerms.has(desc.name))) {
        return Promise.resolve({ state: 'prompt', onchange: null });
      }
      return permQuery.call(this, desc);
    };
  } catch {}
  if (!navigator.languages || navigator.languages.length === 0) {
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  }
})()`;

export function stripHeadlessUa(ua) {
  return String(ua || "").replace(/HeadlessChrome/gi, "Chrome");
}
