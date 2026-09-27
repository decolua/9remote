/**
 * API handler for /api/local-sites
 */

import { scanLocalSites } from "../features/terminal/portScanner.js";
import { matchesLocalKey } from "../cli/utils/apiKey.js";
import { loadKey } from "../cli/utils/state.js";

/**
 * Handle /api/local-sites request
 */
export async function handleLocalSites(req, res) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(401);
    res.end(JSON.stringify({ error: "Unauthorized: Missing API key" }));
    return;
  }
  
  const apiKey = authHeader.slice(7);
  // Against the key this agent holds — the shape check it replaced accepted
  // any string matching the v2 pattern, which is to say anyone's.
  if (!matchesLocalKey(apiKey, loadKey()?.key)) {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(401);
    res.end(JSON.stringify({ error: "Unauthorized: Invalid API key" }));
    return;
  }
  
  const sites = await scanLocalSites();
  res.setHeader("Content-Type", "application/json");
  res.writeHead(200);
  res.end(JSON.stringify(sites));
}
