"use client";

import { useCallback, useEffect, useRef } from "react";
import { usePendingDeviceStore } from "@/features/session/stores/pendingDeviceStore";
import { isHostEnvironment } from "@/shared/utils/localOrigin";

const PENDING_POLL_MS = 3000;

const post = (path, body) => fetch(path, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body)
}).catch(() => null);

/**
 * Global approval gate — mounted once at the workspace root (host env only).
 * Watches the host's SSE stream + polls for pending approvals, so a new device
 * asking in shows the approve modal no matter which view is open.
 */
export default function PendingDeviceApprovalModal() {
  const pendingDevice = usePendingDeviceStore((s) => s.pendingDevice);
  const setPendingDevice = usePendingDeviceStore((s) => s.setPendingDevice);
  const clearPendingDevice = usePendingDeviceStore((s) => s.clearPendingDevice);
  const touchBump = usePendingDeviceStore((s) => s.touchBump);
  const pendingRef = useRef(null);

  useEffect(() => { pendingRef.current = pendingDevice; }, [pendingDevice]);

  useEffect(() => {
    if (!isHostEnvironment()) return;
    const es = new EventSource("/api/ui/events");
    es.onmessage = (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      if (data.type === "deviceApproval" && data.action === "pending") {
        setPendingDevice({ socketId: data.socketId, deviceId: data.deviceId, ip: data.ip });
      }
    };
    // Fallback poll: recover an approval the SSE event missed (mount-after, reconnect).
    const pollId = setInterval(async () => {
      if (pendingRef.current) return;
      try {
        const r = await fetch("/api/device/pending");
        if (!r.ok) return;
        const d = await r.json();
        const first = d?.pending?.[0];
        if (first) setPendingDevice({ socketId: first.socketId, deviceId: first.deviceId, ip: first.ip });
      } catch {}
    }, PENDING_POLL_MS);
    return () => { clearInterval(pollId); es.close(); };
  }, [setPendingDevice]);

  const settle = useCallback(async (endpoint) => {
    if (!pendingRef.current) return;
    await post(endpoint, { socketId: pendingRef.current.socketId });
    clearPendingDevice();
    touchBump();
  }, [clearPendingDevice, touchBump]);

  const approve = useCallback(() => settle("/api/device/approve"), [settle]);
  const reject = useCallback(() => settle("/api/device/reject"), [settle]);

  // Keyboard: Enter approves, Escape rejects — same contract as the dashboard.
  useEffect(() => {
    if (!pendingDevice) return;
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); reject(); }
      else if (e.key === "Enter") { e.preventDefault(); approve(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!pendingDevice) return null;

  return (
    <div className="agent-dashboard fixed inset-0 z-[70] flex items-center justify-center" style={{ background: "rgba(0,0,0,0.6)" }}>
      <div className="card-elev p-5 flex flex-col gap-4 w-80">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined" style={{ color: "var(--brand-500)", fontSize: 24 }}>devices</span>
          <span className="text-sm font-semibold" style={{ color: "var(--text-main)" }}>New Device Connection</span>
        </div>
        <div className="flex flex-col gap-1 text-xs" style={{ color: "var(--text-muted)" }}>
          <span>Device: <span style={{ color: "var(--text-main)" }}>{pendingDevice.deviceId?.slice(0, 8)}...</span></span>
          <span>IP: <span style={{ color: "var(--text-main)" }}>{pendingDevice.ip}</span></span>
        </div>
        <div className="flex gap-2">
          <button onClick={reject} className="glass-btn flex-1 py-2 text-sm flex items-center justify-center gap-1.5" style={{ color: "var(--text-muted)" }}>
            <span>Reject</span>
            <kbd className="text-[10px] font-mono px-1 py-0.5 rounded opacity-70 leading-none" style={{ background: "var(--glass-bg)" }}>Esc</kbd>
          </button>
          <button
            onClick={approve}
            className="btn-primary flex-1 py-2 text-sm font-semibold rounded-lg flex items-center justify-center gap-1.5"
          >
            <span>Approve</span>
            <kbd className="text-[10px] font-mono px-1 py-0.5 rounded bg-white/20 text-white leading-none">↵</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}
