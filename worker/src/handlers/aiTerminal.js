/**
 * AITerminal Handler - Proxy requests to AI endpoint
 */

const SYSTEM_PROMPT = `You are a terminal command expert. Rules:
1. Return ONLY the exact command(s) - no explanations, no markdown, no backticks
2. Multiple commands: use && or separate lines
3. Use syntax appropriate for the user's OS
4. If unclear, provide the most likely command`;

/**
 * Handle AI terminal request
 * POST /api/ai-terminal
 * Body: { message: string }
 */
export async function handleAITerminal(request, env, corsHeaders) {
  try {
    const { message, os } = await request.json();

    if (!message || typeof message !== "string") {
      return new Response(
        JSON.stringify({ error: "Message is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check env variables
    if (!env.AI_ENDPOINT || !env.AI_API_KEY) {
      return new Response(
        JSON.stringify({ error: "AI service not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Call AI endpoint
    const aiResponse = await fetch(env.AI_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.AI_API_KEY}`
      },
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

    if (!aiResponse.ok) {
      const errorText = await aiResponse.text();
      console.error("AI API error:", errorText);
      return new Response(
        JSON.stringify({ error: "AI service error" }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const aiData = await aiResponse.json();
    const command = aiData.choices?.[0]?.message?.content?.trim() || "";

    return new Response(
      JSON.stringify({ command }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("AITerminal handler error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
}
