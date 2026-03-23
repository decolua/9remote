import { getCloudflareContext } from "@opennextjs/cloudflare";
import { jsonOk, jsonError, optionsResponse } from "@/shared/utils/apiResponse";


const SYSTEM_PROMPT = `You are a terminal command expert. Rules:
1. Return ONLY the exact command(s) - no explanations, no markdown, no backticks
2. Multiple commands: use && or separate lines
3. Use syntax appropriate for the user's OS
4. If unclear, provide the most likely command`;

export function OPTIONS() {
  return optionsResponse();
}

export async function POST(request) {
  try {
    const { env } = getCloudflareContext();
    const { message, os } = await request.json();

    if (!message || typeof message !== "string") return jsonError("Message is required");
    if (!env.AI_ENDPOINT || !env.AI_API_KEY) return jsonError("AI service not configured", 500);

    const aiResponse = await fetch(env.AI_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.AI_API_KEY}` },
      body: JSON.stringify({
        model: env.AI_MODEL || "9remote",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: os ? `[OS: ${os}] ${message}` : message }
        ],
        max_tokens: 500,
        temperature: 0.3,
        stream: false
      })
    });

    if (!aiResponse.ok) return jsonError("AI service error", 502);

    const aiData = await aiResponse.json();
    const command = aiData.choices?.[0]?.message?.content?.trim() || "";
    return jsonOk({ command });
  } catch (e) {
    return jsonError(e?.message || String(e), 500);
  }
}
