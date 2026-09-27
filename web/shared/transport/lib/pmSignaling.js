import { SIGNALING_CONFIG, SIGNALING_ERRORS, ADAPTER_STATE } from "@/shared/constants/transport";
import { WORKER_API } from "@/shared/constants/API";
import { debugLog } from "@/shared/utils/debugLog";
import { termLog } from "@/shared/utils/termLog";

// DO signaling relay: bring-up, approval handling, and the outbound buffer that
// holds offers created before any carrier was ready.
// Extracted verbatim from ProtocolManager.

export function initSignalingClient(pm) {
  if (!SIGNALING_CONFIG.enabled || pm._sig || pm._sigDestroyed) return;
  if (!pm._auth.deviceId || !pm._auth.apiKey) return;
  // DO endpoint follows WORKER_API (env override → localhost UI talks to deployed DO).
  const doUrl = WORKER_API.replace(/^http/, "ws") + "/signaling";
  import("../SignalingClient").then(({ SignalingClient }) => {
    // Guard: disconnect may have run while the dynamic import was pending.
    if (pm._sig || pm._sigDestroyed) return;
    pm._sig = new SignalingClient({
      url: doUrl,
      role: "client",
      roomId: pm._auth.apiKey,
      apiKey: pm._auth.apiKey,
      from: pm._peerId,
      onReady: () => onSignalingReady(pm),
      pingMs: SIGNALING_CONFIG.pingMs
    });
    pm._sig.on((msg) => {
      // Host test-toggle: RTC refused. Stop retrying so the client stays on WS
      // instead of looping offer→refuse→close→restart. Cleared by reload.
      if (msg.type === "error" && msg.message === "rtc-disabled") {
        pm._rtcTestDisabled = true;
        termLog("switch", "rtc-disabled by host → stop RTC retry (use WS)");
        return;
      }
      if (handleApprovalSignal(pm, msg)) return;
      pm._rtcSignalingHandler?.(msg);
    });
    pm._sig.connect();
  }).catch((err) => debugLog("transport", `[pm] SignalingClient load failed: ${err?.message || err}`));
}

/** The host answered "not approved" rather than failing to connect. Surface it
 * as approval UI and stop renegotiating — retrying can't change a policy answer,
 * and letting it reach the RTC adapter would tear the peer down and fall back to
 * the tunnel, hiding the approval screen behind a connection error.
 * @returns {boolean} true when handled (caller must not forward the message) */
export function handleApprovalSignal(pm, msg) {
  if (msg?.type !== "error") return false;
  const status = msg.message === SIGNALING_ERRORS.pending ? "pending"
    : msg.message === SIGNALING_ERRORS.rejected ? "rejected"
    : null;
  if (!status) return false;
  debugLog("transport", `[pm] device ${status} → approval UI`);
  pm._awaitingApproval = true;
  pm._wsCallbacks.onApproval?.(status);
  return true;
}

/** Relay (re)connected — drain queued signaling, and renegotiate if RTC died
 * while we had no carrier (resume from background, network handover). */
export function onSignalingReady(pm) {
  termLog("switch", "signaling ready");
  flushSigBuffer(pm);
  if (pm._awaitingApproval) return; // policy answer pending — a re-offer changes nothing
  const rtc = pm._adapters.get("rtc");
  // connect() defers RTC when the relay is not up yet (an offer sent then only
  // reaches the outbound buffer). This is that deferred start.
  if (!rtc) {
    termLog("switch", "sig-ready → start rtc (was deferred)");
    pm._startSecondaryAdapters();
    return;
  }
  // Otherwise RTC is already negotiating — only step in once it's dead.
  if (rtc.state === ADAPTER_STATE.closed) {
    termLog("switch", "sig-ready → restartRtc (rtc was closed)");
    pm._restartRtc("sig-ready");
  }
}

export function sendSignaling(pm, msg) {
  // DO is the sole signaling carrier — the tunnel carries data only.
  if (pm._sig?.ready && pm._sig.send(msg)) return;
  // A queued offer describes a peer this client has already thrown away: each
  // RTC retry builds a new one. Flushing the whole queue made the host tear
  // down and rebuild its peer once per stale offer, and the answers to those
  // went nowhere — so only the newest offer, plus the ICE gathered for it,
  // is worth keeping.
  if (msg.type === "offer") {
    pm._sigBuffer = pm._sigBuffer.filter((m) => m.type !== "offer" && m.type !== "ice");
  }
  pm._sigBuffer.push(msg);
  if (pm._sigBuffer.length > 32) pm._sigBuffer.shift();
}

export function flushSigBuffer(pm) {
  if (!pm._sigBuffer.length) return;
  const queued = pm._sigBuffer;
  pm._sigBuffer = [];
  for (const msg of queued) sendSignaling(pm, msg);
}

/** The cached tunnelUrl may be stale (cloudflared restarted → new trycloudflare
 * URL). Re-fetch the latest from the Worker before connecting. */
export async function refreshTunnelUrl(pm) {
  // The page-origin carrier cannot go stale — only a remote tunnel URL can.
  // Skipping also keeps the host-served tab from calling the Worker at all.
  if (pm._auth.tunnelUrl === (typeof window !== "undefined" ? window.location.origin : "")) return;
  try {
    debugLog("transport", `[pm] refreshTunnelUrl: fetching from ${WORKER_API}/api/connect`);
    const res = await fetch(`${WORKER_API}/api/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: pm._auth.apiKey }),
    });
    if (!res.ok) {
      debugLog("transport", `[pm] refreshTunnelUrl: HTTP ${res.status}`);
      return;
    }
    const data = await res.json();
    debugLog("transport", `[pm] refreshTunnelUrl: got ${data.tunnelUrl} (was ${pm._auth.tunnelUrl})`);
    if (data.tunnelUrl && data.tunnelUrl !== pm._auth.tunnelUrl) {
      pm._auth.tunnelUrl = data.tunnelUrl;
    }
  } catch (e) {
    debugLog("transport", `[pm] refreshTunnelUrl: error ${e.message}`);
  }
}
