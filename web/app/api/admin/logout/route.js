import { optionsResponse, corsHeaders } from "@/shared/utils/apiResponse";
import { buildClearCookie } from "@/features/admin/lib/auth";

export function OPTIONS() { return optionsResponse(); }

export async function POST() {
  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Set-Cookie": buildClearCookie() }
  });
}
