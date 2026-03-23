import { getCloudflareContext } from "@opennextjs/cloudflare";
import { verifyApiKeyCrc } from "@/shared/utils/apiKey";
import { jsonOk, jsonError, optionsResponse } from "@/shared/utils/apiResponse";


const TURN_API = "https://rtc.live.cloudflare.com/v1/turn/keys";
const TTL = 86400;

export function OPTIONS() { return optionsResponse(); }

export async function GET(request) {
  try {
    const { env } = getCloudflareContext();
    const apiKey = request.headers.get("X-API-Key");

    if (!apiKey || !(await verifyApiKeyCrc(apiKey))) return jsonError("Unauthorized", 401);

    const resp = await fetch(`${TURN_API}/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${env.TURN_KEY_SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: TTL })
    });

    if (!resp.ok) return jsonError("Failed to generate TURN credentials", 502);

    const { iceServers } = await resp.json();
    return jsonOk({ iceServers });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}
