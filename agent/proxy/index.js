/**
 * Proxy server setup and response handler
 */

import { createGunzip, createInflate, createBrotliDecompress } from "zlib";
import httpProxy from "http-proxy";
import { rewriteUrl, rewriteHtmlLinks } from "./rewriter.js";
import { getInterceptorScript } from "./interceptor.js";
import { getServiceWorkerScript, getSwRegistrationScript } from "./serviceWorker.js";

// Active proxy sessions - ports currently being viewed
const activeProxyPorts = new Set();

export function startProxySession(port) {
  activeProxyPorts.add(String(port));
}

export function endProxySession(port) {
  activeProxyPorts.delete(String(port));
}

function isProxySessionActive(port) {
  return activeProxyPorts.has(String(port));
}

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
 * Inject script into HTML at the beginning of <head> to run before any other scripts
 */
function injectScript(html, script) {
  // Inject right after <head> to ensure it runs first
  if (html.includes("<head>")) {
    return html.replace("<head>", "<head>" + script);
  }
  if (html.includes("<HEAD>")) {
    return html.replace("<HEAD>", "<HEAD>" + script);
  }
  // Fallback: try case-insensitive
  const headMatch = html.match(/<head[^>]*>/i);
  if (headMatch) {
    return html.replace(headMatch[0], headMatch[0] + script);
  }
  // Last resort: prepend to document
  return script + html;
}

/**
 * Create and configure proxy server
 */
export function createProxyServer() {''
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
    
    // JSON/RSC responses: remove complex rewriting, SW will handle it
    const isJson = contentType.includes("application/json") || contentType.includes("text/x-component");
    if (isJson) {
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res);
      return;
    }
    
    // JavaScript files: remove complex rewriting, SW will handle it
    const isJs = contentType.includes("javascript") || contentType.includes("text/javascript");
    if (isJs) {
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res);
      return;
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
      const script = getSwRegistrationScript(targetPort);
      html = injectScript(html, script);
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
  // Serve Service Worker script
  if (targetPath === "/sw.js") {
    const swScript = getServiceWorkerScript(targetPort);
    res.writeHead(200, {
      "Content-Type": "application/javascript; charset=utf-8",
      "Service-Worker-Allowed": "/",
      "Cache-Control": "no-store, no-cache, must-revalidate"
    });
    res.end(swScript);
    return;
  }
  
  // Check if proxy session is active for this port
  if (!isProxySessionActive(targetPort)) {
    res.writeHead(401, { "Content-Type": "text/html" });
    res.end(`
      <!DOCTYPE html>
      <html>
        <head><title>Unauthorized</title></head>
        <body style="font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1e293b; color: #94a3b8;">
          <div style="text-align: center;">
            <h1 style="color: #f87171;">401 Unauthorized</h1>
            <p>Please open site through 9Remote first.</p>
          </div>
        </body>
      </html>
    `);
    return;
  }

  req._proxyTargetPort = targetPort;
  req.url = targetPath + (search || "");
  
  proxy.web(req, res, {
    target: `http://localhost:${targetPort}`,
    changeOrigin: true
  }, (err) => {
    // console.error(`[Proxy] Error for port ${targetPort}:`, err.message);
    res.writeHead(502);
    res.end(`Bad Gateway: ${err.message}`);
  });
}
