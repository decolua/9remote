/**
 * URL rewriting utilities for proxy
 */

const SKIP_PREFIXES = ["data:", "javascript:", "#", "mailto:", "blob:"];

/**
 * Rewrite URL to proxy path
 */
export function rewriteUrl(url, targetPort) {
  if (!url || SKIP_PREFIXES.some(p => url.startsWith(p))) {
    return url;
  }
  
  if (url.startsWith("/proxy/")) {
    return url;
  }
  
  if (url.startsWith(`http://localhost:${targetPort}`)) {
    return url.replace(`http://localhost:${targetPort}`, `/proxy/${targetPort}`);
  }
  
  if (url.startsWith("/")) {
    return `/proxy/${targetPort}${url}`;
  }
  
  return url;
}

/**
 * Rewrite all links in HTML content
 */
export function rewriteHtmlLinks(html, targetPort) {
  return html.replace(
    /(href|src|action|srcset)=(["'])([^"']*)\2/gi,
    (match, attr, quote, url) => {
      if (attr.toLowerCase() === "srcset") {
        const rewritten = url.split(",").map(part => {
          const [srcUrl, ...rest] = part.trim().split(/\s+/);
          const newUrl = rewriteUrl(srcUrl, targetPort);
          return rest.length ? `${newUrl} ${rest.join(" ")}` : newUrl;
        }).join(", ");
        return `${attr}=${quote}${rewritten}${quote}`;
      }
      return `${attr}=${quote}${rewriteUrl(url, targetPort)}${quote}`;
    }
  );
}
