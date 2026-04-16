/**
 * API key management handlers (localhost-only)
 */

import { jsonOk, jsonErr } from "../lib/router.js";
import { browserFetch } from "../lib/constants.js";
import { loadKey, saveKey } from "../cli/utils/state.js";
import { generateApiKeyWithMachine } from "../cli/utils/apiKey.js";
import { getConsistentMachineId } from "../cli/utils/machineId.js";
import { getUiState, updateUiState } from "./ui.js";

export async function handleOneTimeKey(req, res) {
  const state = getUiState();
  const workerUrl = state.workerUrl || "https://9remote.cc";
  if (!state.permanentKey) { jsonErr(res, 400, "No permanent key set"); return; }
  try {
    const r = await browserFetch(`${workerUrl}/api/temp-key/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: state.permanentKey, expiryMinutes: 30 }),
    });
    const data = await r.json();
    const qrUrl = `${workerUrl}/login?k=${data.tempKey}`;
    updateUiState({ oneTimeKey: data.tempKey, oneTimeKeyExpiresAt: data.expiresAt, qrUrl });
    jsonOk(res, { oneTimeKey: data.tempKey, expiresAt: data.expiresAt, qrUrl });
  } catch (err) { jsonErr(res, 500, err.message); }
}

export async function handleRegenerate(req, res) {
  try {
    const machineId = await getConsistentMachineId();
    const { key } = generateApiKeyWithMachine(machineId);
    const existing = loadKey();
    saveKey(machineId, key, existing?.name || "Default");
    updateUiState({ permanentKey: key });
    jsonOk(res, { ok: true, permanentKey: key });
  } catch (err) { jsonErr(res, 500, err.message); }
}
