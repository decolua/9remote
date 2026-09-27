// Remote access on/off — localhost-only (agent UI). Persisted in settings.json;
// off drops remote clients and the DO relay, on re-runs the connect steps.
import { jsonOk, jsonErr, parseJsonBody } from "../lib/router.js";
import { saveSettings, writeCmd } from "../cli/utils/state.js";
import { setRemoteEnabled, isRemoteEnabled } from "../transport/server.js";
import { pushUiEvent } from "./ui.js";

function payload(enabled) {
  return { enabled };
}

export function handleRemoteEnabledGet(req, res) {
  jsonOk(res, payload(isRemoteEnabled()));
}

export async function handleRemoteEnabledPost(req, res) {
  const data = await parseJsonBody(req, res);
  if (!data) return; // parseJsonBody already answered 400
  if (typeof data.enabled !== "boolean") return jsonErr(res, 400, "enabled must be a boolean");
  saveSettings({ remoteEnabled: data.enabled });
  setRemoteEnabled(data.enabled);
  // The CLI parent owns the tunnel process and the step machine
  writeCmd(data.enabled ? "start-tunnel" : "stop-tunnel");
  const p = payload(data.enabled);
  pushUiEvent("remote", p);
  jsonOk(res, p);
}
