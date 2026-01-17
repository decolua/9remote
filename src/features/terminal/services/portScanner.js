import http from "http";

// Common development ports to scan
const COMMON_PORTS = [
  3000, 3001, 3002, 3003, 3004, 3005,
  4200, 5000, 5173, 5174,
  8000, 8080, 8081, 8888,
  9000, 9001
];

/**
 * Check if a port is running a HTTP service
 */
async function checkPort(port) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: "localhost",
        port,
        method: "GET",
        path: "/",
        timeout: 1000
      },
      (res) => {
        // If we get ANY response, the port is active
        resolve({
          port,
          active: true,
          status: res.statusCode
        });
      }
    );

    req.on("error", () => {
      resolve({ port, active: false });
    });

    req.on("timeout", () => {
      req.destroy();
      resolve({ port, active: false });
    });

    req.end();
  });
}

/**
 * Scan all common ports and return active web services
 */
export async function scanLocalSites() {
  const results = await Promise.all(
    COMMON_PORTS.map(port => checkPort(port))
  );

  return results
    .filter(r => r.active)
    .map(r => ({
      port: r.port,
      url: `http://localhost:${r.port}`,
      name: `Local :${r.port}`
    }));
}
