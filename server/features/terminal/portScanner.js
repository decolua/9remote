import http from "http";
import https from "https";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

/**
 * Get listening ports using OS commands
 */
async function getListeningPorts() {
  const platform = process.platform;
  // Always include common HTTP ports
  const ports = new Set([80, 443]);
  
  try {
    let command;
    if (platform === "win32") {
      command = "netstat -ano | findstr LISTENING";
    } else {
      // Mac/Linux: lsof is more reliable
      const nullDevice = "/dev/null";
      command = `lsof -iTCP -sTCP:LISTEN -P -n 2>${nullDevice} || netstat -tlnp 2>${nullDevice}`;
    }

    const { stdout } = await execAsync(command);

    // Parse output to extract ports - improved regex
    const lines = stdout.split("\n");
    for (const line of lines) {
      // Match patterns: *:80, :80, 0.0.0.0:80, 127.0.0.1:80, [::]:80
      const portMatches = line.match(/[:\*\]](\d{2,5})(?:\s|$)/g);
      if (portMatches) {
        for (const match of portMatches) {
          const port = parseInt(match.replace(/[:\*\]\s]/g, ""), 10);
          if (port > 0 && port <= 65535) {
            // Include: 80, 443, and ports >= 1024
            if (port === 80 || port === 443 || port >= 1024) {
              ports.add(port);
            }
          }
        }
      }
    }

    return Array.from(ports);
  } catch (error) {
    console.error("Failed to get listening ports:", error.message);
    // Fallback to common ports (including 80, 443)
    return [80, 443, 3000, 3001, 4200, 5000, 5173, 8000, 8080, 9000];
  }
}

/**
 * Try HTTP request to port
 */
function tryHttp(port, timeout = 2000) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "localhost", port, method: "GET", path: "/", timeout },
      (res) => {
        // Consume response to free up socket
        res.on("data", () => {});
        res.on("end", () => {});
        resolve({ active: true, protocol: "http", status: res.statusCode });
      }
    );
    req.on("error", (err) => {
      resolve({ active: false, error: err.message });
    });
    req.on("timeout", () => { 
      req.destroy(); 
      resolve({ active: false, error: "timeout" }); 
    });
    req.end();
  });
}

/**
 * Try HTTPS request to port
 */
function tryHttps(port, timeout = 2000) {
  return new Promise((resolve) => {
    const req = https.request(
      { host: "localhost", port, method: "GET", path: "/", timeout, rejectUnauthorized: false },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => {});
        resolve({ active: true, protocol: "https", status: res.statusCode });
      }
    );
    req.on("error", (err) => {
      resolve({ active: false, error: err.message });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ active: false, error: "timeout" }); 
    });
    req.end();
  });
}

/**
 * Check if port is running HTTP/HTTPS service
 */
async function checkPort(port) {
  // Known HTTPS ports
  const httpsFirst = [443, 8443, 9443].includes(port);

  if (httpsFirst) {
    const httpsResult = await tryHttps(port);
    if (httpsResult.active) return { port, ...httpsResult };
    const httpResult = await tryHttp(port);
    if (httpResult.active) return { port, ...httpResult };
  } else {
    const httpResult = await tryHttp(port);
    if (httpResult.active) return { port, ...httpResult };
    const httpsResult = await tryHttps(port);
    if (httpsResult.active) return { port, ...httpsResult };
  }

  return { port, active: false };
}

/**
 * Scan all listening ports and return active web services
 */
export async function scanLocalSites() {
  const listeningPorts = await getListeningPorts();
  
  const results = await Promise.all(
    listeningPorts.map(port => checkPort(port))
  );

  return results
    .filter(r => r.active)
    .map(r => ({
      port: r.port,
      protocol: r.protocol,
      url: `${r.protocol}://localhost:${r.port}`,
      name: `localhost:${r.port}`,
      status: r.status
    }))
    .sort((a, b) => a.port - b.port);
}
