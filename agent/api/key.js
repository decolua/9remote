/**
 * API key management handlers (localhost-only)
 */

import { jsonOk, jsonErr } from "../lib/router.js";
import { loadKey, saveKey } from "../cli/utils/state.js";
import { generateApiKeyV2 } from "../cli/utils/apiKey.js";
import { getConsistentMachineId } from "../cli/utils/machineId.js";
import { getUiState, updateUiState } from "./ui.js";
import { createTempKey, connectUrlOf, registerSession } from "../cli/utils/token.js";
import { initSignalingGlobal } from "../lib/signalingGlobal.js";
import { headOf } from "../cli/utils/apiKey.js";

export async function handleOneTimeKey(req, res) {
  const state = getUiState();
  const workerUrl = state.workerUrl || "https://9remote.cc";
  if (!state.permanentKey) { jsonErr(res, 400, "No permanent key set"); return; }
  const data = await createTempKey(state.permanentKey, workerUrl);
  if (!data) { jsonErr(res, 500, "Temp key creation failed"); return; }
  const qrUrl = connectUrlOf(workerUrl, data);
  updateUiState({ oneTimeKey: data.oneTimeKey, oneTimeKeyExpiresAt: data.expiresAt, qrUrl });
  jsonOk(res, { oneTimeKey: data.oneTimeKey, expiresAt: data.expiresAt, qrUrl });
}

export async function handleRegenerate(req, res) {
  try {
    const state = getUiState();
    const workerUrl = state.workerUrl || "https://9remote.cc";
    const machineId = await getConsistentMachineId();
    const key = generateApiKeyV2(machineId);
    const existing = loadKey();
    // Register the new key with the Worker BEFORE storing it: without a session
    // row the key cannot resolve a tunnel and every login fails.
    const registered = await registerSession(key, workerUrl, state.tunnelUrl, existing?.key);
    if (!registered) { jsonErr(res, 502, "Could not register the new key with the server"); return; }
    saveKey(machineId, key, existing?.name || "Default");
    // The DO signaling room is keyed by the apiKey HEAD, and it was joined at
    // boot with the OLD key. Without rejoining, clients holding the new key land
    // in a room the agent never listens to and spin forever.
    initSignalingGlobal(headOf(key));
    // The two keys have separate lifecycles: regenerating this one does NOT
    // mint a pairing code. The old code is still cleared though — it redeems to
    // the key just retired, so keeping it on screen would hand a client a dead
    // key. QR follows the one-time key, so it clears with it. The user mints
    // the next code explicitly (pairingUsed blocks the UI auto-mint).
    updateUiState({ permanentKey: key, oneTimeKey: "", oneTimeKeyExpiresAt: null, qrUrl: "", pairingUsed: true });
    jsonOk(res, { ok: true, permanentKey: key });
  } catch (err) { jsonErr(res, 500, err.message); }
}
