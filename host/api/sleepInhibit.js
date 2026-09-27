// Sleep inhibitor mode toggle — localhost-only (agent UI)
import { jsonOk, parseJsonBody } from "../lib/router.js";
import * as sleepInhibitor from "../lib/sleepInhibitor.js";
import { saveSettings } from "../cli/utils/state.js";
import { REMOTE_CONFIG } from "../features/remote/REMOTE_CONFIG.js";
import { pushUiEvent } from "./ui.js";

function payload() {
  return {
    mode: sleepInhibitor.getMode(),
    active: sleepInhibitor.isActive(),
    presets: Object.keys(REMOTE_CONFIG.sleepInhibit?.presets || {})
  };
}

export function handleSleepInhibitGet(req, res) {
  jsonOk(res, payload());
}

export async function handleSleepInhibitPost(req, res) {
  const data = await parseJsonBody(req, res);
  if (!data) return;
  const next = sleepInhibitor.setMode(data.mode);
  saveSettings({ sleepInhibitMode: next });
  const p = payload();
  pushUiEvent("sleepInhibit", p);
  jsonOk(res, p);
}
