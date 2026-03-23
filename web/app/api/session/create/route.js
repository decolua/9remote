import { getCloudflareContext } from "@opennextjs/cloudflare";
import { parseApiKey, verifyApiKeyCrc } from "@/shared/utils/apiKey";
import { jsonOk, jsonError, optionsResponse } from "@/shared/utils/apiResponse";


export function OPTIONS() { return optionsResponse(); }

export async function POST(request) {
  try {
  const { env } = getCloudflareContext();
  const { apiKey, shortId } = await request.json();

  if (!(await verifyApiKeyCrc(apiKey))) return jsonError("Invalid API key");
  const { machineId } = parseApiKey(apiKey);

  await env.DB.prepare(`
    INSERT INTO sessions (machineId, apiKey, shortId, tunnelUrl, lastAccessAt, expiresAt)
    VALUES (?, ?, ?, NULL, datetime('now'), datetime('now', '+7 days'))
    ON CONFLICT(apiKey)
    DO UPDATE SET
      shortId = COALESCE(shortId, excluded.shortId),
      lastAccessAt = datetime('now'),
      expiresAt = datetime('now', '+7 days')
  `).bind(machineId, apiKey, shortId || null).run();

  return jsonOk({ success: true, machineId });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}
