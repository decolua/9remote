// Sleep inhibitor toggle — public via tunnel (Bearer API key required)
import { jsonOk, jsonErr, parseJsonBody } from "../lib/router.js";
import * as sleepInhibitor from "../lib/sleepInhibitor.js";
import { saveSettings } from "../cli/utils/state.js";
import { verifyApiKeyCrc } from "../cli/utils/apiKey.js";

function authorized(req) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith("Bearer ")) return false;
  return verifyApiKeyCrc(h.slice(7));
}

export function handleSleepInhibitGet(req, res) {
  if (!authorized(req)) return jsonErr(res, 401, "Unauthorized");
  jsonOk(res, { enabled: sleepInhibitor.isActive() });
}

export async function handleSleepInhibitPost(req, res) {
  if (!authorized(req)) return jsonErr(res, 401, "Unauthorized");
  const data = await parseJsonBody(req, res);
  if (!data) return;
  const enabled = !!data.enabled;
  sleepInhibitor.setEnabled(enabled);
  saveSettings({ sleepInhibit: enabled });
  jsonOk(res, { enabled: sleepInhibitor.isActive() });
}
