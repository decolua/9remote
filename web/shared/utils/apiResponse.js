export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-API-Key"
};

export function jsonOk(data) {
  return Response.json(data, { headers: corsHeaders });
}

export function jsonError(message, status = 400) {
  return Response.json({ error: message }, { status, headers: corsHeaders });
}

export function optionsResponse() {
  return new Response(null, { headers: corsHeaders });
}
