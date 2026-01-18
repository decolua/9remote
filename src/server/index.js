/**
 * Server initialization and request routing
 */

import { createServer } from "http";
import { parse } from "url";
import next from "next";
import { setupSocketIO } from "../shared/lib/socketio.js";
import { createProxyServer, handleProxyRequest } from "./proxy/index.js";
import { handleLocalSites } from "./api/localSites.js";
import { setCorsHeaders, handlePreflight } from "./middleware/cors.js";

const dev = process.env.NODE_ENV !== "production";
const hostname = "localhost";
const port = parseInt(process.env.PORT || "3000", 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

export async function startServer() {
  await app.prepare();
  
  const proxy = createProxyServer();
  
  const server = createServer(async (req, res) => {
    setCorsHeaders(res);
    
    if (handlePreflight(req, res)) return;
    
    try {
      const parsedUrl = parse(req.url, true);
      const { pathname, search } = parsedUrl;
      
      // API routes
      if (pathname === "/api/local-sites") {
        await handleLocalSites(req, res);
        return;
      }
      
      // Proxy routes
      if (pathname.startsWith("/proxy/")) {
        const match = pathname.match(/^\/proxy\/(\d+)(\/.*)?$/);
        if (match) {
          handleProxyRequest(proxy, req, res, match[1], match[2] || "/", search);
          return;
        }
      }
      
      // Next.js handler
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error("Error:", req.url, err);
      res.statusCode = 500;
      res.end("Internal server error");
    }
  });

  setupSocketIO(server);

  server.listen(port, (err) => {
    if (err) throw err;
    console.log(`> Ready on http://${hostname}:${port}`);
  });
}
