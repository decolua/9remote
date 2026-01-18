/**
 * API handler for /api/local-sites
 */

import { scanLocalSites } from "../../features/terminal/services/portScanner.js";
import { verifyApiKeyCrc } from "../../../cli/utils/apiKey.js";

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
  if (!verifyApiKeyCrc(apiKey)) {
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
