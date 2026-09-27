/**
 * URL rewriting utilities for proxy
 */

const SKIP_PREFIXES = ["data:", "javascript:", "#", "mailto:", "blob:"];

// Attributes that contain URLs
const URL_ATTRS = [
  "href", "src", "action", "srcset", "poster", "data", "formaction",
  "data-src", "data-href", "data-url", "data-background"
];

/**
 * Rewrite URL to proxy path.
 * Takes the session id, not the port: the id is what addresses this site from
 * outside, and a port in the path would be guessable by anyone with the URL.
 */
export function rewriteUrl(url, sessionId, targetPort) {
  if (!url || SKIP_PREFIXES.some(p => url.startsWith(p))) {
    return url;
  }
  
  if (url.startsWith("/proxy/")) {
    return url;
  }
  
  if (url.startsWith(`http://localhost:${targetPort}`)) {
    return url.replace(`http://localhost:${targetPort}`, `/proxy/${sessionId}`);
  }
  
  if (url.startsWith("/") && !url.startsWith("//")) {
    return `/proxy/${sessionId}${url}`;
  }
  
  return url;
}

/**
 * Rewrite all links in HTML content
 */
export function rewriteHtmlLinks(html, sessionId, targetPort) {
  const proxyBase = `/proxy/${sessionId}`;
  
  // Rewrite standard URL attributes
  const attrPattern = new RegExp(
    `(${URL_ATTRS.join("|")})=(["'])([^"']*?)\\2`,
    "gi"
  );
  
  html = html.replace(attrPattern, (match, attr, quote, url) => {
    if (attr.toLowerCase() === "srcset") {
      const rewritten = url.split(",").map(part => {
        const [srcUrl, ...rest] = part.trim().split(/\s+/);
        const newUrl = rewriteUrl(srcUrl, sessionId, targetPort);
        return rest.length ? `${newUrl} ${rest.join(" ")}` : newUrl;
      }).join(", ");
      return `${attr}=${quote}${rewritten}${quote}`;
    }
    return `${attr}=${quote}${rewriteUrl(url, sessionId, targetPort)}${quote}`;
  });
  
  // Rewrite inline style url()
  html = html.replace(
    /url\(\s*(["']?)(\/_next\/[^)"']+)\1\s*\)/gi,
    (match, quote, url) => `url(${quote}${proxyBase}${url}${quote})`
  );
  
  // Rewrite JSON-like paths in scripts (Next.js data)
  html = html.replace(
    /"(\/_next\/[^"]+)"/g,
    (match, url) => `"${proxyBase}${url}"`
  );
  
  return html;
}
