/**
 * Proxy server setup and response handler
 */

import { createGunzip, createInflate, createBrotliDecompress } from "zlib";
import httpProxy from "http-proxy";
import { rewriteUrl, rewriteHtmlLinks } from "./rewriter.js";
import { getInterceptorScript } from "./interceptor.js";
import { verifyApiKeyCrc } from "../../../cli/utils/apiKey.js";

const AUTH_COOKIE_NAME = "9remote_auth";

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
 * Parse cookies from request header
 */
function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  
  cookieHeader.split(";").forEach(cookie => {
    const [name, ...rest] = cookie.trim().split("=");
    if (name) {
      cookies[name] = rest.join("=");
    }
  });
  return cookies;
}

/**
 * Verify proxy authentication from cookie
 */
function verifyProxyAuth(req) {
  const cookies = parseCookies(req.headers.cookie);
  const apiKey = cookies[AUTH_COOKIE_NAME];
  
  if (!apiKey) return false;
  return verifyApiKeyCrc(apiKey);
}

/**
 * Handle proxy request
 */
export function handleProxyRequest(proxy, req, res, targetPort, targetPath, search) {
  // Verify authentication
  if (!verifyProxyAuth(req)) {
    res.writeHead(401, { "Content-Type": "text/html" });
    res.end(`
      <!DOCTYPE html>
      <html>
        <head><title>Unauthorized</title></head>
        <body style="font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1e293b; color: #94a3b8;">
          <div style="text-align: center;">
            <h1 style="color: #f87171;">401 Unauthorized</h1>
            <p>Please authenticate through 9Remote first.</p>
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
    console.error(`[Proxy] Error for port ${targetPort}:`, err.message);
    res.writeHead(502);
    res.end(`Bad Gateway: ${err.message}`);
  });
}
