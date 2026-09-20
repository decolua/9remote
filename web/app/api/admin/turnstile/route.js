import { getCloudflareContext } from "@opennextjs/cloudflare";
import { jsonOk, optionsResponse } from "@/shared/utils/apiResponse";

export function OPTIONS() { return optionsResponse(); }

// Public on purpose: the Turnstile sitekey is public by design — it ships in
// the HTML of every page that renders the widget. Empty when unset, which the
// login page reads as "no captcha configured" (matching the secret's absence).
export async function GET() {
  const { env } = getCloudflareContext();
  return jsonOk({ siteKey: env.TURNSTILE_SITE_KEY || "" });
}
