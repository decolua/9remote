import { createServer } from "http";
import { parse } from "url";
import next from "next";
import { setupSocketIO } from "./src/lib/socketio.js";
import { scanLocalSites } from "./src/lib/portScanner.js";
import httpProxy from "http-proxy";
import harmon from "harmon";

const dev = process.env.NODE_ENV !== "production";
const hostname = "localhost";
const port = parseInt(process.env.PORT || "3000", 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const proxy = httpProxy.createProxyServer({});
  
  const server = createServer(async (req, res) => {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    
    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }
    
    try {
      const parsedUrl = parse(req.url, true);
      
      // API: Get local sites
      if (parsedUrl.pathname === "/api/local-sites") {
        const sites = await scanLocalSites();
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify(sites));
        return;
      }
      
      // Proxy: /proxy/:port/*
      if (parsedUrl.pathname.startsWith("/proxy/")) {
        const match = parsedUrl.pathname.match(/^\/proxy\/(\d+)(\/.*)?$/);
        if (match) {
          const targetPort = match[1];
          const targetPath = match[2] || "/";
          
          // Rewrite URL
          req.url = targetPath + (parsedUrl.search || "");
          
          // Setup harmon to inject base tag AND rewrite absolute paths
          const harmonMiddleware = harmon([], [
            {
              // Inject base tag into head
              query: "head",
              func: (node) => {
                const rs = node.createReadStream();
                const ws = node.createWriteStream();
                
                // Inject base tag before existing content
                ws.write(`<base href="/proxy/${targetPort}/">`);
                
                // Pipe existing content
                rs.pipe(ws, { end: true });
              }
            },
            {
              // Rewrite href attributes (CSS, links)
              query: "link[href]",
              func: (node) => {
                const href = node.getAttribute("href");
                if (href && href.startsWith("/") && !href.startsWith("/proxy/")) {
                  node.setAttribute("href", `/proxy/${targetPort}${href}`);
                }
              }
            },
            {
              // Rewrite src attributes (JS, images)
              query: "script[src], img[src]",
              func: (node) => {
                const src = node.getAttribute("src");
                if (src && src.startsWith("/") && !src.startsWith("/proxy/")) {
                  node.setAttribute("src", `/proxy/${targetPort}${src}`);
                }
              }
            }
          ], true);
          
          // Apply harmon middleware
          harmonMiddleware(req, res, () => {
            proxy.web(req, res, {
              target: `http://localhost:${targetPort}`,
              changeOrigin: true
            }, (err) => {
              console.error(`[Proxy] Error for port ${targetPort}:`, err.message);
              res.writeHead(502);
              res.end(`Bad Gateway: ${err.message}`);
            });
          });
          return;
        }
      }
      
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
});
