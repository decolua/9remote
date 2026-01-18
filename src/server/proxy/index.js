/**
 * Proxy server setup and response handler
 */

import { createGunzip, createInflate, createBrotliDecompress } from "zlib";
import httpProxy from "http-proxy";
import { rewriteUrl, rewriteHtmlLinks } from "./rewriter.js";
import { getInterceptorScript } from "./interceptor.js";

/**
 * Create decompression stream based on content-encoding
 */
function createDecompressor(encoding) {
  switch (encoding) {
    case "gzip": return createGunzip();
    case "deflate": return createInflate();
    case "br": return createBrotliDecompress();
    default: return null;
  }
}

/**
 * Inject script into HTML
 */
function injectScript(html, script) {
  if (html.includes("</head>")) {
    return html.replace("</head>", script + "</head>");
  }
  if (html.includes("</body>")) {
    return html.replace("</body>", script + "</body>");
  }
  return html + script;
}

/**
 * Create and configure proxy server
 */
export function createProxyServer() {
  const proxy = httpProxy.createProxyServer({ selfHandleResponse: true });
  
  proxy.on("proxyRes", (proxyRes, req, res) => {
    const targetPort = req._proxyTargetPort;
    const contentType = proxyRes.headers["content-type"] || "";
    const contentEncoding = proxyRes.headers["content-encoding"] || "";
    const isHtml = contentType.includes("text/html");
    const headers = { ...proxyRes.headers };
    
    // Rewrite redirect location
    if (headers.location) {
      headers.location = rewriteUrl(headers.location, targetPort);
    }
    
    // Non-HTML: pipe through directly
    if (!isHtml) {
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res);
      return;
    }
    
    // HTML: rewrite links and inject script
    delete headers["content-length"];
    delete headers["content-encoding"];
    
    const decompressor = createDecompressor(contentEncoding);
    const sourceStream = decompressor ? proxyRes.pipe(decompressor) : proxyRes;
    const chunks = [];
    
    sourceStream.on("data", chunk => chunks.push(chunk));
    sourceStream.on("error", (err) => {
      console.error("[Proxy] Decompress error:", err.message);
      res.writeHead(502);
      res.end("Bad Gateway: Decompression failed");
    });
    sourceStream.on("end", () => {
      let html = Buffer.concat(chunks).toString("utf8");
      html = rewriteHtmlLinks(html, targetPort);
      html = injectScript(html, getInterceptorScript(targetPort));
      
      res.writeHead(proxyRes.statusCode, headers);
      res.end(html);
    });
  });
  
  return proxy;
}

/**
 * Handle proxy request
 */
export function handleProxyRequest(proxy, req, res, targetPort, targetPath, search) {
  req._proxyTargetPort = targetPort;
  req.url = targetPath + (search || "");
  
  proxy.web(req, res, {
    target: `http://localhost:${targetPort}`,
    changeOrigin: true
  }, (err) => {
    console.error(`[Proxy] Error for port ${targetPort}:`, err.message);
    res.writeHead(502);
    res.end(`Bad Gateway: ${err.message}`);
  });
}
