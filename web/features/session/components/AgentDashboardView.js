"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";
import PromptDialog from "@/shared/components/ui/PromptDialog";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { isAgentEnvironment } from "@/shared/utils/localOrigin";
import { HOMEPAGE_URL } from "@/shared/constants/API";
import "./agentDashboard.css";

/* Full port of agent/ui's dashboard (MainScreen + App state layer). One home:
   the workspace's Pair Device view, served by the agent's own origin, so every
   localhost-only API is same-origin here. The whole view collapses to a notice
   outside that context.
   ponytail: labels are English literals like the source screen; localize when
   the agent-env UI vocabulary stabilizes. */

const LOGIN_URL = `${HOMEPAGE_URL}login`;
const UPDATE_UI = { startDelayMs: 3000, pollMs: 2000, timeoutMs: 90000 };
const PENDING_POLL_MS = 3000;
const MAX_LOGS = 200;
const STEP_READY = 5;
const BUSY_TIMEOUT_MS = 15000;

const post = (path, body) => fetch(path, {
  method: "POST",
  headers: body === undefined ? undefined : { "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body)
}).catch(() => null);

/* ── Small ported atoms ────────────────────────────────────────────────── */

function Toggle({ on, onClick, title, disabled }) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={title}
      className="flex-shrink-0 w-[46px] h-[26px] rounded-full transition-all relative"
      style={{
        background: on ? "linear-gradient(135deg, var(--brand-500), var(--brand-400))" : "rgba(140,145,160,0.35)",
        border: on ? "1px solid transparent" : "1px solid rgba(140,145,160,0.55)",
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? "not-allowed" : "pointer"
      }}
    >
      <span
        className="absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all"
        style={{ left: on ? "calc(100% - 22px)" : "2px", boxShadow: "0 2px 6px rgba(0,0,0,0.4)" }}
      />
    </button>
  );
}

const PERMISSION_META = {
  screenRecording: { label: "Screen Recording", icon: "screenshot_monitor" },
  accessibility: { label: "Accessibility", icon: "accessibility_new" }
};

function PermChip({ granted, label, onRequest }) {
  return (
    <button
      onClick={granted ? undefined : onRequest}
      className="flex items-center gap-1.5 text-[11.5px] px-2.5 py-1 rounded-lg"
      style={{
        background: "var(--row-bg)",
        border: "1px solid var(--border-subtle)",
        color: granted ? "var(--success)" : "var(--text-muted)",
        cursor: granted ? "default" : "pointer"
      }}
      title={granted ? "" : "Click to grant permission"}
    >
      {granted && <span className="material-symbols-outlined" style={{ fontSize: 15 }}>check_circle</span>}
      {label}
      {!granted && <span className="material-symbols-outlined" style={{ fontSize: 19, color: "var(--text-subtle)" }}>toggle_off</span>}
    </button>
  );
}

function IconBtn({ icon, onClick, title, danger, busy }) {
  return (
    <button
      onClick={busy ? undefined : onClick}
      title={title}
      disabled={busy}
      className="glass-btn w-7 h-7 flex items-center justify-center flex-shrink-0"
      style={{
        ...(danger ? { color: "rgba(255,100,100,0.7)" } : { color: "var(--text-muted)" }),
        ...(busy ? { opacity: 0.6, cursor: "default" } : null)
      }}
    >
      <span className={`material-symbols-outlined${busy ? " qr-spin" : ""}`} style={{ fontSize: 15 }}>{icon}</span>
    </button>
  );
}

function RemoteDesktopRow({ desktopEnabled, onDesktopToggle, permissions, onRequestPermission }) {
  const permEntries = Object.entries(PERMISSION_META);
  const canEnableDesktop = permEntries.every(([type]) => !!permissions?.[type]);
  const toggleDisabled = !canEnableDesktop && !desktopEnabled;

  return (
    <div className="row-hover flex items-start gap-4 py-3.5 px-3 -mx-3 rounded-xl">
      <div
        className="w-[34px] h-[34px] rounded-[9px] flex items-center justify-center flex-shrink-0 mt-0.5"
        style={{
          background: !canEnableDesktop ? "rgba(var(--warn-rgb),0.12)" : desktopEnabled ? "rgba(var(--brand-rgb),0.08)" : "var(--row-bg)",
          border: `1px solid ${!canEnableDesktop ? "rgba(var(--warn-rgb),0.3)" : desktopEnabled ? "rgba(var(--brand-rgb),0.25)" : "var(--border-subtle)"}`,
          color: !canEnableDesktop ? "var(--warn)" : desktopEnabled ? "var(--brand-400)" : "var(--text-muted)"
        }}
      >
        <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
          {!canEnableDesktop ? "warning" : "desktop_windows"}
        </span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-[13.5px] font-semibold" style={{ color: "var(--text-main)" }}>Remote Desktop</p>
          {!canEnableDesktop && (
            <span className="text-[10.5px] font-semibold px-2 py-0.5 rounded-full flex-shrink-0" style={{ background: "rgba(var(--warn-rgb), 0.15)", color: "var(--warn)" }}>
              Permission needed
            </span>
          )}
        </div>
        <p className="text-[11.5px] mt-0.5" style={{ color: "var(--text-muted)" }}>
          {!canEnableDesktop ? "Grant permissions to allow screen & control access" : "Control screen, mouse & keyboard"}
        </p>
        {permEntries.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 mt-2.5">
            {permEntries.map(([type, meta]) => (
              <PermChip key={type} granted={!!permissions?.[type]} label={meta.label} onRequest={() => onRequestPermission(type)} />
            ))}
          </div>
        )}
      </div>
      <Toggle on={desktopEnabled} onClick={onDesktopToggle} disabled={toggleDisabled} title={toggleDisabled ? "Grant permissions" : ""} />
    </div>
  );
}

function SleepInhibitRow({ mode, presets = [], onChange }) {
  const sleepLabels = { "30m": "30 min", "1h": "1 hour", "2h": "2 hours", "4h": "4 hours", "24h": "24 hours", never: "Always", none: "Off" };
  const active = mode !== "none";
  return (
    <div className="row-hover flex items-center gap-4 py-3.5 px-3 -mx-3 rounded-xl">
      <div
        className="w-[34px] h-[34px] rounded-[9px] flex items-center justify-center flex-shrink-0"
        style={{
          background: active ? "rgba(var(--brand-rgb),0.08)" : "var(--row-bg)",
          border: `1px solid ${active ? "rgba(var(--brand-rgb),0.25)" : "var(--border-subtle)"}`,
          color: active ? "var(--brand-400)" : "var(--text-muted)"
        }}
      >
        <span className="material-symbols-outlined" style={{ fontSize: 18 }}>coffee</span>
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[13.5px] font-semibold" style={{ color: "var(--text-main)" }}>Prevent Sleep</p>
        <p className="text-[11.5px] mt-0.5" style={{ color: "var(--text-muted)" }}>Keep this machine awake</p>
      </div>
      <select
        value={mode || "never"}
        onChange={(e) => onChange?.(e.target.value)}
        className="text-xs px-3 py-1.5 rounded-lg flex-shrink-0"
        style={{ background: "var(--row-bg)", color: "var(--text-main)", border: "1px solid var(--border-subtle)", cursor: "pointer" }}
      >
        {presets.map((m) => <option key={m} value={m}>{sleepLabels[m] || m}</option>)}
      </select>
    </div>
  );
}

function Section({ title, count, first, children }) {
  return (
    <div className={first ? "" : "mt-10"}>
      <div
        className="flex items-center gap-2.5 font-mono text-[11px] uppercase tracking-[0.12em] pb-2.5 mb-1"
        style={{ color: "var(--text-subtle)", borderBottom: "1px solid var(--border-subtle)" }}
      >
        {title}
        {count != null && <span className="ml-auto tracking-normal" style={{ color: "var(--text-muted)" }}>{count}</span>}
      </div>
      {children}
    </div>
  );
}

/* ── Update banner ─────────────────────────────────────────────────────── */

const UPDATE_PHASES = {
  idle:       { icon: "system_update", spin: false, text: (v) => `Version ${v} available` },
  confirm:    { icon: "system_update", spin: false, text: () => "Update 9remote? Restarts connection (~1 min)" },
  updating:   { icon: "progress_activity", spin: true, text: (v, s) => `Updating… ${s}s` },
  restarting: { icon: "restart_alt", spin: true, text: (v, s) => `Updating 9remote… ${s}s` },
  ready:      { icon: "check_circle", spin: false, text: () => "Updated! Reloading…" },
  timeout:    { icon: "warning", spin: false, text: () => "Taking longer than expected" }
};

function UpdateBanner({ version, isUpdating = false }) {
  const [phase, setPhase] = useState(isUpdating ? "updating" : "idle");
  const [seconds, setSeconds] = useState(0);

  // An external "updating" signal flips the phase unless we're past it —
  // adjusted during render, not in an effect.
  const [seenUpdating, setSeenUpdating] = useState(isUpdating);
  if (seenUpdating !== isUpdating) {
    setSeenUpdating(isUpdating);
    if (isUpdating) setPhase((p) => (p === "restarting" || p === "ready" ? p : "updating"));
  }

  // Polls /api/ui/state: update dies → restarting, answers again → reload.
  useEffect(() => {
    if (phase !== "updating" && phase !== "restarting") return;
    const startedAt = Date.now();
    let diedOnce = false;
    const tick = setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    let poll;
    const startPoll = () => {
      poll = setInterval(async () => {
        if (Date.now() - startedAt > UPDATE_UI.timeoutMs) { setPhase("timeout"); clearInterval(poll); return; }
        try {
          const res = await fetch("/api/ui/state", { cache: "no-store" });
          if (!res.ok) throw new Error();
          if (diedOnce) { setPhase("ready"); clearInterval(poll); setTimeout(() => window.location.reload(), 600); }
        } catch {
          diedOnce = true;
          setPhase("restarting");
        }
      }, UPDATE_UI.pollMs);
    };
    const delay = setTimeout(startPoll, UPDATE_UI.startDelayMs);
    return () => { clearInterval(tick); clearInterval(poll); clearTimeout(delay); };
  }, [phase]);

  if (!version && !isUpdating && phase === "idle") return null;

  const handleConfirm = () => { setPhase("updating"); post("/api/update"); };
  const p = UPDATE_PHASES[phase];
  const busy = phase === "updating" || phase === "restarting" || phase === "ready";
  const progress = phase === "ready" ? 100 : Math.min((seconds * 1000 / UPDATE_UI.timeoutMs) * 100, 95);

  if (busy) {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center" style={{ background: "var(--bg-body)" }}>
        <div className="text-center mx-4" style={{ maxWidth: 320 }}>
          <span className={`material-symbols-outlined text-4xl inline-block ${p.spin ? "qr-spin" : ""}`} style={{ color: "var(--brand-400)" }}>{p.icon}</span>
          <div className="text-sm font-semibold mt-3" style={{ color: "var(--text-main)" }}>{p.text(version, seconds)}</div>
          <div className="mt-4 h-1.5 w-full rounded-full overflow-hidden" style={{ background: "var(--surface-2)" }}>
            <div className="h-full rounded-full transition-all duration-1000 ease-linear" style={{ width: `${progress}%`, background: "var(--brand-400)" }} />
          </div>
          <div className="text-xs mt-2" style={{ color: "var(--text-subtle)" }}>{seconds}s</div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative px-5 py-2 flex items-center gap-2 border-b" style={{ background: "rgba(var(--brand-rgb),0.08)", borderColor: "rgba(var(--brand-rgb),0.2)" }}>
      <span className={`material-symbols-outlined text-sm flex-shrink-0 ${p.spin ? "qr-spin" : ""}`} style={{ color: "var(--brand-400)" }}>{p.icon}</span>
      <span className="text-xs flex-1" style={{ color: "var(--brand-400)" }}>{p.text(version, seconds)}</span>
      {phase === "idle" && (
        <button onClick={() => setPhase("confirm")} className="flex-shrink-0 text-xs px-2 py-0.5 rounded font-medium" style={{ background: "rgba(var(--brand-rgb),0.15)", color: "var(--brand-400)" }}>Update</button>
      )}
      {phase === "confirm" && (
        <>
          <button onClick={handleConfirm} className="flex-shrink-0 text-xs px-2 py-0.5 rounded font-medium" style={{ background: "rgba(var(--brand-rgb),0.15)", color: "var(--brand-400)" }}>Confirm</button>
          <button onClick={() => setPhase("idle")} className="flex-shrink-0 text-xs px-2 py-0.5 rounded font-medium" style={{ background: "rgba(255,255,255,0.08)", color: "var(--text-muted)" }}>Cancel</button>
        </>
      )}
      {phase === "timeout" && (
        <button onClick={() => window.location.reload()} className="flex-shrink-0 text-xs px-2 py-0.5 rounded font-medium" style={{ background: "rgba(var(--brand-rgb),0.15)", color: "var(--brand-400)" }}>Reload</button>
      )}
    </div>
  );
}

/* ── Clients ───────────────────────────────────────────────────────────── */

function mergeClients(approvedDevices, connections, rejectedDevices = []) {
  const connByDevice = new Map();
  for (const c of connections) {
    if (!c.deviceId) continue;
    const existing = connByDevice.get(c.deviceId);
    if (!existing || (c.connectedAt && c.connectedAt < existing.connectedAt)) connByDevice.set(c.deviceId, c);
  }
  const approved = approvedDevices.map((d) => {
    const conn = connByDevice.get(d.deviceId);
    return {
      deviceId: d.deviceId,
      status: conn ? "online" : "offline",
      ip: conn?.ip || null,
      connectedAt: conn?.connectedAt || null,
      approvedAt: d.approvedAt || null,
      label: d.label || ""
    };
  });
  const pending = rejectedDevices.map((r) => ({
    deviceId: r.deviceId,
    status: "pending",
    ip: r.ip || null,
    connectedAt: null,
    approvedAt: null
  }));
  const rank = { online: 0, pending: 1, offline: 2 };
  return [...approved, ...pending].sort((a, b) => rank[a.status] - rank[b.status]);
}

const STATUS_META = {
  online:  { color: "var(--success)",     bg: "rgba(var(--success-rgb),0.14)", label: "Online" },
  offline: { color: "var(--text-subtle)", bg: "var(--row-bg)",                 label: "Offline" },
  pending: { color: "var(--warn)",        bg: "rgba(var(--warn-rgb),0.14)",    label: "Pending" }
};

const deviceIcon = (name) => (/mac|book|laptop|pc|windows|desktop|linux/i.test(name || "") ? "laptop_mac" : "smartphone");

function ClientItem({ client, onRemove, onApprove, onLabel }) {
  const shortId = `${client.deviceId.slice(0, 8)}...`;
  const name = client.label || shortId;
  const meta = STATUS_META[client.status] || STATUS_META.offline;
  const isPending = client.status === "pending";
  const timeLabel =
    client.status === "online"
      ? `${client.ip ? client.ip + " · " : ""}connected ${client.connectedAt ? new Date(client.connectedAt).toLocaleTimeString(undefined, { hour12: false }) : ""}`
      : isPending
        ? "Waiting for approval"
        : client.approvedAt
          ? `Approved ${new Date(client.approvedAt).toLocaleDateString()}`
          : "Offline";

  return (
    <div
      className={`row-hover flex items-center gap-4 py-3 px-3 -mx-3 rounded-xl ${isPending ? "border border-dashed" : ""}`}
      style={isPending ? { borderColor: "rgba(var(--warn-rgb),0.35)" } : {}}
    >
      <div className="w-[34px] h-[34px] rounded-[9px] flex items-center justify-center flex-shrink-0" style={{ background: "var(--row-bg)", border: "1px solid var(--border-subtle)" }}>
        <span className="material-symbols-outlined" style={{ fontSize: 18, color: "var(--text-muted)" }}>{deviceIcon(name)}</span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[13.5px] font-semibold flex items-center gap-2 min-w-0" style={{ color: "var(--text-main)" }}>
          <span className="truncate">{name}</span>
          <span className="flex items-center gap-1 text-[10.5px] font-semibold px-2 py-0.5 rounded-full flex-shrink-0" style={{ background: meta.bg, color: meta.color }}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: "currentColor" }} />{meta.label}
          </span>
          {!isPending && (
            <button
              onClick={() => onLabel?.(client)}
              className="material-symbols-outlined flex-shrink-0"
              style={{ fontSize: 14, color: "var(--text-muted)", cursor: "pointer" }}
              title="Rename this device"
            >
              edit
            </button>
          )}
        </div>
        <p className={`text-[11.5px] mt-0.5 truncate ${client.ip ? "font-mono" : ""}`} style={{ color: "var(--text-muted)" }}>{timeLabel}</p>
      </div>
      {isPending ? (
        <button onClick={() => onApprove?.(client)} className="flex-shrink-0 text-[12.5px] font-semibold px-3.5 py-2 rounded-lg btn-primary" title="Approve this device">
          Approve
        </button>
      ) : (
        <button onClick={() => onRemove(client)} className="glass-btn flex-shrink-0 text-[12px] font-semibold px-3.5 py-2 rounded-lg" style={{ color: "var(--text-muted)" }} title="Disconnect and remove this device">
          {client.status === "online" ? "Disconnect" : "Remove"}
        </button>
      )}
    </div>
  );
}

/* ── Status + tunnel steps ─────────────────────────────────────────────── */

function remoteStatus(step, transport) {
  const rtc = transport?.rtcPeers || 0;
  const ws = transport?.wsPeers || 0;
  if (step === 0) return { color: "var(--danger)", blink: false, text: "offline" };
  if (step >= 5) return { color: "var(--success)", blink: false, text: `online · rtc ${rtc} ws ${ws}` };
  return { color: "var(--warn)", blink: true, text: "connecting" };
}

const STEP_KEYS = ["Preparing", "Connecting", "Tunneling", "Verifying", "Ready"];

function TunnelSteps({ step, stepDesc }) {
  const activeIdx = Math.min(Math.max(step - 1, 0), STEP_KEYS.length - 1);
  return (
    <div className="relative z-[1] flex flex-col items-center gap-2 mb-4">
      <div className="flex items-center">
        {STEP_KEYS.map((label, i) => {
          const done = i < activeIdx;
          const active = i === activeIdx;
          return (
            <div key={label} className="flex items-center">
              <span
                className={`w-[9px] h-[9px] rounded-full ${active ? "chip-blink" : ""}`}
                style={{
                  background: done || active ? "var(--brand-500)" : "var(--row-hover)",
                  border: done || active ? "none" : "1px solid var(--border)",
                  boxShadow: active ? "0 0 8px rgba(var(--brand-rgb),0.7)" : undefined
                }}
              />
              {i < STEP_KEYS.length - 1 && <span className="w-5 h-px" style={{ background: done ? "var(--brand-500)" : "var(--border)" }} />}
            </div>
          );
        })}
      </div>
      <span className="text-[11px] font-mono text-center max-w-full truncate" style={{ color: "var(--text-subtle)" }}>
        {STEP_KEYS[activeIdx]}{stepDesc ? ` — ${stepDesc}` : ""}
      </span>
    </div>
  );
}

/* ── QR card (dashboard styling) ───────────────────────────────────────── */

function formatCountdown(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function DashboardQrCard({ qrUrl, oneTimeKey, oneTimeKeyExpiresAt, permanentKey, onGenerateOneTimeKey, onRegenerateKey }) {
  const canvasRef = useRef(null);
  const [now, setNow] = useState(() => Date.now());
  const [copiedKey, setCopiedKey] = useState(null);
  const [popup, setPopup] = useState(null); // "oneTime" | "regen" | null
  const [busy, setBusy] = useState(null);   // "oneTime" | "permanent" | null

  const countdown = oneTimeKeyExpiresAt != null ? oneTimeKeyExpiresAt - now : null;
  const expired = countdown !== null && countdown <= 0;

  useEffect(() => {
    if (!oneTimeKeyExpiresAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [oneTimeKeyExpiresAt]);

  useEffect(() => {
    if (!qrUrl || expired || !canvasRef.current) return;
    let cancelled = false;
    import("qrcode")
      .then(({ default: QRCode }) => !cancelled && QRCode.toCanvas(canvasRef.current, qrUrl, {
        width: 200,
        margin: 1,
        color: { dark: "#0f1923", light: "#ffffff" }
      }))
      .catch(() => {});
    return () => { cancelled = true; };
  }, [qrUrl, expired]);

  // Stop each spinner as soon as ITS value arrives — adjusted during render.
  const [prevOneTime, setPrevOneTime] = useState(oneTimeKey);
  const [prevPermanent, setPrevPermanent] = useState(permanentKey);
  if (prevOneTime !== oneTimeKey) { setPrevOneTime(oneTimeKey); setBusy((b) => (b === "oneTime" ? null : b)); }
  if (prevPermanent !== permanentKey) { setPrevPermanent(permanentKey); setBusy((b) => (b === "permanent" ? null : b)); }

  useEffect(() => {
    if (!busy) return;
    const id = setTimeout(() => setBusy(null), BUSY_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [busy]);

  const copy = (text, which) => {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopiedKey(which);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  return (
    <>
      <ConfirmDialog
        isOpen={popup === "oneTime"}
        onClose={() => setPopup(null)}
        onConfirm={() => { setPopup(null); setBusy("oneTime"); onGenerateOneTimeKey?.(); }}
        title="New one-time key?"
        message="Generate a new one-time key? The current one will expire immediately."
        confirmText="Generate"
      />
      <ConfirmDialog
        isOpen={popup === "regen"}
        onClose={() => setPopup(null)}
        onConfirm={() => { setPopup(null); setBusy("permanent"); onRegenerateKey?.(); }}
        title="Regenerate permanent key?"
        message="Regenerate permanent key? All existing sessions will be disconnected."
        confirmText="Regenerate"
      />
      <div className="relative z-[1] w-full max-w-[380px] flex flex-col items-center">
        <div className="bg-white p-3.5 rounded-[14px] flex items-center justify-center flex-shrink-0" style={{ boxShadow: "var(--qr-plate-shadow)" }}>
          {qrUrl && !expired ? (
            <canvas ref={canvasRef} />
          ) : (
            <div className="w-[200px] h-[200px] grid place-items-center">
              <span className="material-symbols-outlined" style={{ fontSize: 72, color: "#d4d4d8" }}>qr_code_2</span>
            </div>
          )}
        </div>

        <div className="flex flex-col items-center gap-1 mt-4 mb-9">
          <span className="text-[11.5px] leading-4" style={{ color: "var(--text-muted)" }}>Scan to sign in</span>
          <a href={LOGIN_URL} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 hover:underline transition-opacity">
            <span className="w-2 h-2 rounded-full bg-green-400 flex-shrink-0" />
            <span className="text-sm font-bold" style={{ color: "var(--brand-400)" }}>{LOGIN_URL.replace(/^https?:\/\//, "")}</span>
            <span className="material-symbols-outlined flex-shrink-0" style={{ fontSize: 14, color: "var(--brand-400)" }}>open_in_new</span>
          </a>
        </div>

        <div className="w-full flex flex-col gap-1.5">
          <span className="text-xs font-medium px-0.5" style={{ color: "var(--text-muted)" }}>One-Time Key</span>
          <div className="w-full flex items-center gap-2 px-3 py-2.5 rounded-[10px]" style={{ background: "var(--row-bg)", border: "1px solid var(--border-subtle)" }}>
            <span className="material-symbols-outlined flex-shrink-0" style={{ fontSize: 16, color: "var(--text-muted)" }}>timer</span>
            <span
              className="flex-1 font-mono font-bold tracking-[0.18em] text-base truncate"
              style={{ color: oneTimeKey && !expired ? "var(--brand-400)" : "var(--border)" }}
            >
              {oneTimeKey && !expired ? oneTimeKey : "• • • • • •"}
            </span>
            {countdown !== null && (
              <span className={`text-xs font-mono flex-shrink-0 ${countdown <= 0 ? "text-red-400" : ""}`} style={countdown > 0 ? { color: "var(--text-muted)" } : {}}>
                {countdown <= 0 ? "Expired" : formatCountdown(countdown)}
              </span>
            )}
            {oneTimeKey && !expired && (
              <IconBtn icon={copiedKey === "oneTime" ? "check" : "content_copy"} onClick={() => copy(oneTimeKey, "oneTime")} title="Copy one-time key" />
            )}
            <IconBtn icon="refresh" onClick={() => setPopup("oneTime")} title="New one-time key" busy={busy === "oneTime"} />
          </div>
        </div>

        <div className="w-full flex flex-col gap-1.5 mt-2">
          <span className="text-xs font-medium px-0.5" style={{ color: "var(--text-muted)" }}>Permanent Key</span>
          <div className="w-full flex items-center gap-2 px-3 py-2.5 rounded-[10px]" style={{ background: "var(--row-bg)", border: "1px solid var(--border-subtle)" }}>
            <span className="material-symbols-outlined flex-shrink-0" style={{ fontSize: 16, color: "var(--text-muted)" }}>key</span>
            <span className="flex-1 font-mono text-xs truncate" style={{ color: "var(--text-main)" }}>
              {permanentKey || "— not set —"}
            </span>
            {permanentKey && (
              <IconBtn icon={copiedKey === "permanent" ? "check" : "content_copy"} onClick={() => copy(permanentKey, "permanent")} title="Copy permanent key" />
            )}
            <IconBtn icon="autorenew" onClick={() => setPopup("regen")} title="Regenerate permanent key" danger busy={busy === "permanent"} />
          </div>
        </div>
      </div>
    </>
  );
}

/* ── Main view ─────────────────────────────────────────────────────────── */

export default function AgentDashboardView() {
  const pushView = useTerminalStore((s) => s.pushView);

  const [main, setMain] = useState({
    step: 0, stepDesc: "", tunnelUrl: "",
    oneTimeKey: "", oneTimeKeyExpiresAt: null, pairingUsed: false,
    permanentKey: "", qrUrl: ""
  });
  const [permissions, setPermissions] = useState({ screenRecording: false, accessibility: false });
  const [transport, setTransport] = useState(null);
  const [desktopEnabled, setDesktopEnabled] = useState(false);
  const [version, setVersion] = useState("");
  const [agentReachable, setAgentReachable] = useState(true);
  const [updateVersion, setUpdateVersion] = useState("");
  const [isUpdating, setIsUpdating] = useState(false);
  const [connections, setConnections] = useState([]);
  const [approvedDevices, setApprovedDevices] = useState([]);
  const [rejectedDevices, setRejectedDevices] = useState([]);
  const [pendingDevice, setPendingDevice] = useState(null);
  const [autoApprove, setAutoApprove] = useState(false);
  const [sleepInhibitMode, setSleepInhibitMode] = useState("never");
  const [sleepPresets, setSleepPresets] = useState([]);
  const [remoteEnabled, setRemoteEnabled] = useState(true);

  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
  const [showRemoteOffConfirm, setShowRemoteOffConfirm] = useState(false);
  const [showShutdownConfirm, setShowShutdownConfirm] = useState(false);
  const [deviceToRemove, setDeviceToRemove] = useState(null);
  const [deviceToLabel, setDeviceToLabel] = useState(null);

  const versionRef = useRef("");
  const pendingRef = useRef(null);

  const fetchDevices = useCallback(async () => {
    try {
      const [aRes, rRes] = await Promise.all([fetch("/api/device/approved"), fetch("/api/device/rejected")]);
      if (aRes.ok) { const d = await aRes.json(); setApprovedDevices(d.devices || []); }
      if (rRes.ok) { const d = await rRes.json(); setRejectedDevices(d.rejected || []); }
    } catch {}
  }, []);

  const checkVersion = useCallback(() => {
    fetch("/api/version", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        const v = d.version ?? "";
        if (!v) return;
        if (versionRef.current && versionRef.current !== v) { window.location.reload(); return; }
        versionRef.current = v;
        setVersion(v);
      })
      .catch(() => {});
  }, []);

  // Initial state + SSE stream — the agent's local event bus.
  useEffect(() => {
    if (!isAgentEnvironment()) return;
    let alive = true;

    fetch("/api/ui/state", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        if (!alive || !data) return;
        setAgentReachable(true);
        setMain({
          step: data.step ?? 0,
          stepDesc: data.stepDesc ?? "",
          tunnelUrl: data.tunnelUrl ?? "",
          oneTimeKey: data.oneTimeKey ?? "",
          oneTimeKeyExpiresAt: data.oneTimeKeyExpiresAt ?? null,
          pairingUsed: data.pairingUsed ?? false,
          permanentKey: data.permanentKey ?? "",
          qrUrl: data.qrUrl ?? ""
        });
        setPermissions({ screenRecording: data.screenRecording ?? false, accessibility: data.accessibility ?? false });
        if (data.transport) setTransport(data.transport);
        if (data.desktopEnabled !== undefined) setDesktopEnabled(data.desktopEnabled);
      })
      .catch(() => alive && setAgentReachable(false));

    fetch("/api/connections", { cache: "no-store" }).then((r) => r.json())
      .then((d) => alive && setConnections(d.connections ?? [])).catch(() => {});
    Promise.resolve().then(fetchDevices); // deferred: async like the fetches above

    fetch("/api/device/auto-approve").then((r) => r.json()).then((d) => alive && setAutoApprove(!!d?.enabled)).catch(() => {});
    fetch("/api/sleep-inhibit").then((r) => r.json()).then((d) => {
      if (!alive) return;
      if (d?.mode) setSleepInhibitMode(d.mode);
      if (Array.isArray(d?.presets)) setSleepPresets(d.presets);
    }).catch(() => {});
    fetch("/api/remote/enabled").then((r) => r.json())
      .then((d) => alive && typeof d?.enabled === "boolean" && setRemoteEnabled(d.enabled)).catch(() => {});

    const es = new EventSource("/api/ui/events");
    es.onmessage = (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      setAgentReachable(true);
      if (data.type === "state") {
        checkVersion();
        setMain({
          step: data.step ?? 0,
          stepDesc: data.stepDesc ?? "",
          tunnelUrl: data.tunnelUrl ?? "",
          oneTimeKey: data.oneTimeKey ?? "",
          oneTimeKeyExpiresAt: data.oneTimeKeyExpiresAt ?? null,
          pairingUsed: data.pairingUsed ?? false,
          permanentKey: data.permanentKey ?? "",
          qrUrl: data.qrUrl ?? ""
        });
      } else if (data.type === "updateAvailable") {
        setUpdateVersion(data.version);
      } else if (data.type === "updating") {
        setIsUpdating(true);
      } else if (data.type === "permissions") {
        setPermissions({ screenRecording: data.screenRecording, accessibility: data.accessibility });
        if (data.desktopEnabled !== undefined) setDesktopEnabled(data.desktopEnabled);
      } else if (data.type === "transport") {
        setTransport({ signaling: data.signaling, rtcPeers: data.rtcPeers, wsPeers: data.wsPeers, rtcDisabled: data.rtcDisabled });
      } else if (data.type === "connections") {
        setConnections(data.connections ?? []);
        fetchDevices(); // online/offline stays in sync with the new list
      } else if (data.type === "deviceApproval" && data.action === "pending") {
        setPendingDevice({ socketId: data.socketId, deviceId: data.deviceId, ip: data.ip });
      } else if (data.type === "deviceApproval" && data.action === "refresh") {
        fetchDevices();
      } else if (data.type === "autostart") {
        // handled by the settings dialog; nothing here
      } else if (data.type === "sleepInhibit") {
        if (data.mode) setSleepInhibitMode(data.mode);
        if (Array.isArray(data.presets)) setSleepPresets(data.presets);
      } else if (data.type === "remote") {
        setRemoteEnabled(!!data.enabled);
      }
    };
    es.onerror = () => setAgentReachable(false);
    es.onopen = () => { setAgentReachable(true); checkVersion(); };

    // Fallback poll: recover a pending approval if its SSE event was missed.
    const pollId = setInterval(async () => {
      if (pendingRef.current) return;
      try {
        const r = await fetch("/api/device/pending");
        if (!r.ok) return;
        const d = await r.json();
        const first = d?.pending?.[0];
        if (first) setPendingDevice((cur) => cur ?? { socketId: first.socketId, deviceId: first.deviceId, ip: first.ip });
      } catch {}
    }, PENDING_POLL_MS);

    return () => { alive = false; clearInterval(pollId); es.close(); };
  }, [fetchDevices, checkVersion]);

  useEffect(() => { pendingRef.current = pendingDevice; }, [pendingDevice]);

  // Auto-mint a one-time key so the QR renders immediately (dashboard parity).
  const autoKeyRef = useRef(false);
  useEffect(() => {
    if (autoKeyRef.current) return;
    if (!main.permanentKey || main.oneTimeKey || main.qrUrl || main.pairingUsed) return;
    if (main.step !== STEP_READY) return;
    autoKeyRef.current = true;
    post("/api/key/one-time");
  }, [main.permanentKey, main.oneTimeKey, main.qrUrl, main.pairingUsed, main.step]);

  /* ── actions ── */
  const handleRequestPermission = (type) => post("/api/permissions/request", { type });
  const handleDesktopToggle = async () => {
    const next = !desktopEnabled;
    setDesktopEnabled(next);
    await post("/api/desktop/toggle", { enabled: next });
  };
  const handleGenerateOneTimeKey = async () => {
    const res = await post("/api/key/one-time");
    if (!res?.ok) return;
    const data = await res.json().catch(() => null);
    if (data?.oneTimeKey) {
      setMain((prev) => ({
        ...prev,
        oneTimeKey: data.oneTimeKey,
        oneTimeKeyExpiresAt: data.expiresAt,
        qrUrl: data.qrUrl ?? prev.qrUrl
      }));
    }
  };
  const handleRegenerateKey = async () => {
    const res = await post("/api/key/regenerate");
    if (!res?.ok) return;
    const data = await res.json().catch(() => null);
    if (data?.permanentKey) setMain((prev) => ({ ...prev, permanentKey: data.permanentKey }));
  };
  const handleDeviceRemove = async (client) => {
    const endpoint = client.status === "pending" ? "/api/device/clear-rejected" : "/api/device/remove";
    await post(endpoint, { deviceId: client.deviceId });
    fetchDevices();
  };
  const handleDeviceApprove = async () => {
    if (!pendingDevice) return;
    await post("/api/device/approve", { socketId: pendingDevice.socketId });
    setPendingDevice(null);
    fetchDevices();
  };
  const handleDeviceReject = async () => {
    if (!pendingDevice) return;
    await post("/api/device/reject", { socketId: pendingDevice.socketId });
    setPendingDevice(null);
    fetchDevices();
  };
  const handleAutoApproveToggle = async () => {
    const next = !autoApprove;
    setAutoApprove(next);
    const r = await post("/api/device/auto-approve", { enabled: next });
    const d = await r?.json().catch(() => null);
    if (d && typeof d.enabled === "boolean") setAutoApprove(d.enabled);
  };
  const handleDeviceApproveRejected = async (deviceId) => {
    await post("/api/device/approve-rejected", { deviceId });
    fetchDevices();
  };
  const handleDeviceLabel = async (deviceId, label) => {
    await post("/api/device/label", { deviceId, label });
    fetchDevices();
  };
  const handleRemoteToggle = async () => {
    const next = !remoteEnabled;
    setRemoteEnabled(next);
    const r = await post("/api/remote/enabled", { enabled: next });
    const d = await r?.json().catch(() => null);
    if (typeof d?.enabled === "boolean") setRemoteEnabled(d.enabled);
  };
  const handleSleepInhibitChange = async (mode) => {
    const prev = sleepInhibitMode;
    setSleepInhibitMode(mode);
    const r = await post("/api/sleep-inhibit", { mode });
    const d = await r?.json().catch(() => null);
    if (!d?.mode) setSleepInhibitMode(prev);
  };

  // Keyboard nav for the pending-device modal: Enter approves, Escape rejects.
  useEffect(() => {
    if (!pendingDevice) return;
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); handleDeviceReject(); }
      else if (e.key === "Enter") { e.preventDefault(); handleDeviceApprove(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /* ── non-agent env: nothing to show ── */
  if (!isAgentEnvironment()) {
    return (
      <div className="h-full grid place-items-center p-6">
        <p className="text-sm text-text-muted text-center">Device pairing is only available in the agent&apos;s local view.</p>
      </div>
    );
  }

  const status = remoteStatus(main.step, transport);
  const clients = mergeClients(approvedDevices, connections, rejectedDevices);
  const onlineCount = clients.filter((c) => c.status === "online").length;

  return (
    <div className="agent-dashboard h-full w-full relative flex overflow-hidden isolate" style={{ background: "var(--bg-body)" }}>
      {/* Background — square grid + drifting light (login parity) */}
      <div className="bg-sq-grid absolute inset-0 pointer-events-none z-[-3]" aria-hidden="true" />
      <div className="bg-light-drift absolute inset-0 pointer-events-none z-[-2]" aria-hidden="true" />

      {/* 50/50 split — pairing left, manage right. Narrow: single column. */}
      <main className="flex-1 min-w-0 grid grid-cols-1 lg:grid-cols-2 overflow-y-auto lg:overflow-hidden">
        {!agentReachable && (
          <div className="col-span-full px-4 py-2 text-center text-xs font-medium" style={{ background: "var(--danger)", color: "#fff" }}>
            Agent unreachable — is the server still running?
          </div>
        )}

        {/* ═══ LEFT — pairing ═══ */}
        <section className="relative flex flex-col p-6 lg:p-10 min-w-0 lg:overflow-y-auto">
          <div className="pane-hero-glow" aria-hidden="true" />
          <div className="relative z-[1] flex flex-col items-center my-auto">
            {remoteEnabled ? (
              <>
                <h1 className="brand-grad-text text-[30px] lg:text-[34px] font-bold tracking-[-0.03em] leading-[1.05] text-center mb-5">
                  Pair Device
                </h1>
                {main.step > 0 && main.step < 5 && <TunnelSteps step={main.step} stepDesc={main.stepDesc} />}
                <DashboardQrCard
                  qrUrl={main.qrUrl}
                  oneTimeKey={main.oneTimeKey}
                  oneTimeKeyExpiresAt={main.oneTimeKeyExpiresAt}
                  permanentKey={main.permanentKey}
                  onGenerateOneTimeKey={handleGenerateOneTimeKey}
                  onRegenerateKey={handleRegenerateKey}
                />
              </>
            ) : (
              <div className="glass-card w-full max-w-[380px] flex flex-col items-center gap-2.5 py-10 px-6">
                <span className="material-symbols-outlined" style={{ fontSize: 40, color: "var(--text-subtle)" }}>cloud_off</span>
                <p className="text-[13.5px] font-semibold text-center" style={{ color: "var(--text-main)" }}>Remote is off</p>
                <p className="text-xs leading-relaxed text-center" style={{ color: "var(--text-muted)" }}>
                  Turn remote access back on to pair devices.
                </p>
              </div>
            )}
          </div>

          {/* Remote master switch — pinned to the bottom of the pairing pane */}
          <div
            className="hero-card group relative z-[1] mt-6 w-full p-4 flex items-center gap-3 flex-shrink-0 cursor-pointer"
            onClick={() => (remoteEnabled ? setShowRemoteOffConfirm(true) : handleRemoteToggle())}
          >
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 relative z-[1] transition-transform group-hover:scale-105"
              style={{ background: "var(--surface-2)", border: "1px solid var(--border-subtle)", color: remoteEnabled ? "var(--success)" : "var(--text-muted)" }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 22 }}>{remoteEnabled ? "cloud_done" : "cloud_off"}</span>
            </div>
            <div className="flex-1 min-w-0 relative z-[1]">
              <h3 className="text-[15px] font-bold tracking-tight" style={{ color: "var(--text-main)" }}>
                {remoteEnabled ? "Remote is on" : "Remote is off"}
              </h3>
              <p className="text-xs mt-0.5 font-normal line-clamp-1 flex items-center gap-1.5" style={{ color: "var(--text-muted)" }}>
                {remoteEnabled ? (
                  <>
                    <span
                      className={`w-[6px] h-[6px] rounded-full flex-shrink-0 ${status.blink ? "chip-blink" : ""}`}
                      style={{ background: status.color, boxShadow: status.color === "var(--success)" ? "0 0 8px rgba(var(--success-rgb),0.9)" : undefined }}
                    />
                    <span className="font-mono truncate">{status.text}</span>
                  </>
                ) : (
                  <span className="truncate">Turn remote access back on to pair devices.</span>
                )}
              </p>
            </div>
            <span
              className="flex-shrink-0 relative z-[1] px-3.5 py-2 rounded-xl text-xs font-semibold transition-all"
              style={{
                background: remoteEnabled ? "var(--surface-2)" : "var(--brand-500)",
                color: remoteEnabled ? "var(--text-main)" : "#fff",
                border: remoteEnabled ? "1px solid var(--border-subtle)" : "none"
              }}
            >
              {remoteEnabled ? "Turn off" : "Turn on"}
            </span>
            {remoteEnabled && main.step === 0 && (
              <span
                role="button"
                title="Retry remote connection"
                onClick={(e) => { e.stopPropagation(); post("/api/ui/start"); }}
                className="flex-shrink-0 relative z-[1] w-9 h-9 grid place-items-center rounded-xl card-act"
                style={{ background: "var(--surface-2)", border: "1px solid var(--border-subtle)", color: "var(--text-main)" }}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 18 }}>refresh</span>
              </span>
            )}
          </div>
        </section>

        {/* ═══ RIGHT — manage ═══ */}
        <section className="relative min-w-0 pt-10 pb-11 pr-8 pl-6 lg:pl-14 lg:pr-12 lg:overflow-y-auto" style={{ background: "var(--pane-right-bg)" }}>
          {/* Brand row — logo + version */}
          <div className="flex items-center gap-3 mb-8">
            <div className="logo-glass w-10 h-10 rounded-[11px] grid place-items-center flex-shrink-0">
              <span className="material-symbols-outlined" style={{ fontSize: 21, color: "var(--text-main)" }}>terminal</span>
            </div>
            <div className="flex flex-col leading-none min-w-0">
              <span className="brand-grad-text text-[20px] font-bold tracking-[-0.02em]">9Remote</span>
              {version && <span className="font-mono text-[11px] mt-[5px]" style={{ color: "var(--text-subtle)" }}>v{version}</span>}
            </div>
            <div className="flex-1" />
            {/* Power actions — settings lives in the workspace settings modal */}
            <IconBtn icon="restart_alt" title="Restart agent" onClick={() => post("/api/ui/stop")} />
            <IconBtn icon="power_settings_new" title="Shutdown agent" danger onClick={() => setShowShutdownConfirm(true)} />
          </div>

          <UpdateBanner version={updateVersion} isUpdating={isUpdating} />

          {/* Hero Workspace Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 mb-8">
            <button onClick={() => pushView({ type: "workspaces" })} className="hero-card group text-left p-4 flex flex-col justify-between">
              <div className="flex items-start justify-between w-full mb-3 relative z-[1]">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center transition-transform group-hover:scale-105" style={{ background: "var(--surface-2)", color: "var(--text-main)", border: "1px solid var(--border-subtle)" }}>
                  <span className="material-symbols-outlined" style={{ fontSize: 22 }}>computer</span>
                </div>
                <span className="material-symbols-outlined opacity-60 group-hover:opacity-100 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-all" style={{ fontSize: 16, color: "var(--text-muted)" }}>open_in_new</span>
              </div>
              <div className="relative z-[1]">
                <h3 className="text-[15px] font-bold tracking-tight" style={{ color: "var(--text-main)" }}>This Workspace</h3>
                <p className="text-xs mt-0.5 font-normal line-clamp-1" style={{ color: "var(--text-muted)" }}>Terminal & files on this machine</p>
              </div>
            </button>

            <button
              onClick={() => {
                try { sessionStorage.setItem("9remote_manual_disconnect", "1"); } catch {}
                const url = "/login?mode=remote";
                if (window.__TAURI__) { window.location.href = url; return; }
                window.open(url, "_blank");
              }}
              className="hero-card group text-left p-4 flex flex-col justify-between"
            >
              <div className="flex items-start justify-between w-full mb-3 relative z-[1]">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center transition-transform group-hover:scale-105" style={{ background: "var(--surface-2)", color: "var(--text-main)", border: "1px solid var(--border-subtle)" }}>
                  <span className="material-symbols-outlined" style={{ fontSize: 22 }}>hub</span>
                </div>
                <span className="material-symbols-outlined opacity-60 group-hover:opacity-100 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-all" style={{ fontSize: 16, color: "var(--text-muted)" }}>open_in_new</span>
              </div>
              <div className="relative z-[1]">
                <h3 className="text-[15px] font-bold tracking-tight" style={{ color: "var(--text-main)" }}>Remote Workspace</h3>
                <p className="text-xs mt-0.5 font-normal line-clamp-1" style={{ color: "var(--text-muted)" }}>Connect to a remote agent</p>
              </div>
            </button>
          </div>

          {/* Services */}
          <Section title="Services" first>
            <RemoteDesktopRow
              desktopEnabled={desktopEnabled}
              onDesktopToggle={handleDesktopToggle}
              permissions={permissions}
              onRequestPermission={handleRequestPermission}
            />
            <SleepInhibitRow mode={sleepInhibitMode} presets={sleepPresets} onChange={handleSleepInhibitChange} />
          </Section>

          {/* Clients */}
          <Section title="Clients" count={clients.length > 0 ? `${onlineCount}/${clients.length}` : null}>
            <div className="row-hover flex items-center gap-4 py-3 px-3 -mx-3 rounded-xl">
              <span className="material-symbols-outlined flex-shrink-0" style={{ fontSize: 19, color: autoApprove ? "var(--brand-400)" : "var(--text-muted)" }}>
                {autoApprove ? "lock_open" : "lock"}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-[13.5px] font-semibold" style={{ color: "var(--text-main)" }}>Auto-approve new devices</p>
              </div>
              <Toggle on={autoApprove} onClick={handleAutoApproveToggle} title={autoApprove ? "Disable auto-approve" : "Enable auto-approve"} />
            </div>

            {clients.length === 0 ? (
              <p className="text-xs text-center py-4" style={{ color: "var(--text-muted)" }}>No clients yet</p>
            ) : (
              clients.map((c) => (
                <ClientItem
                  key={c.deviceId}
                  client={c}
                  onRemove={setDeviceToRemove}
                  onApprove={(cl) => handleDeviceApproveRejected(cl.deviceId)}
                  onLabel={(cl) => setDeviceToLabel({ ...cl, draft: cl.label || "" })}
                />
              ))
            )}
          </Section>
        </section>
      </main>

      {/* Confirms */}
      <ConfirmDialog
        isOpen={showDisconnectConfirm}
        onClose={() => setShowDisconnectConfirm(false)}
        onConfirm={() => { setShowDisconnectConfirm(false); post("/api/ui/stop"); }}
        title="Reset connection?"
        message="Reset and stop the tunnel? Remote clients will be disconnected."
        confirmText="Reset"
      />
      <ConfirmDialog
        isOpen={showRemoteOffConfirm}
        onClose={() => setShowRemoteOffConfirm(false)}
        onConfirm={() => { setShowRemoteOffConfirm(false); handleRemoteToggle(); }}
        title="Turn off remote access?"
        message="Turn off remote access? Connected devices will be disconnected immediately."
        confirmText="Turn off"
      />
      <ConfirmDialog
        isOpen={showShutdownConfirm}
        onClose={() => setShowShutdownConfirm(false)}
        onConfirm={() => { setShowShutdownConfirm(false); post("/api/ui/shutdown"); }}
        title="Shutdown 9Remote?"
        message="Shutdown 9Remote completely? This will stop the server, close the tunnel and quit the app."
        confirmText="Shutdown"
      />
      <ConfirmDialog
        isOpen={!!deviceToRemove}
        onClose={() => setDeviceToRemove(null)}
        onConfirm={() => { handleDeviceRemove(deviceToRemove); setDeviceToRemove(null); }}
        title="Remove device?"
        message={deviceToRemove
          ? (deviceToRemove.status === "online"
            ? `Disconnect and remove device ${deviceToRemove.deviceId.slice(0, 8)}...? The client will be disconnected and need approval again next time.`
            : deviceToRemove.status === "pending"
              ? `Remove pending device ${deviceToRemove.deviceId.slice(0, 8)}...? It will need a fresh approval request to connect again.`
              : `Remove device ${deviceToRemove.deviceId.slice(0, 8)}...? It will need approval again next time.`)
          : ""}
        confirmText={deviceToRemove?.status === "online" ? "Disconnect & Remove" : "Remove"}
      />
      {deviceToLabel && (
        <PromptDialog
          title="Rename device"
          placeholder={`Name for device ${deviceToLabel.deviceId.slice(0, 8)}...`}
          value={deviceToLabel.draft}
          onChange={(value) => setDeviceToLabel((d) => (d ? { ...d, draft: value } : d))}
          onSubmit={() => { handleDeviceLabel(deviceToLabel.deviceId, (deviceToLabel.draft || "").trim()); setDeviceToLabel(null); }}
          onClose={() => setDeviceToLabel(null)}
        />
      )}

      {/* Pending device approval modal */}
      {pendingDevice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.6)" }}>
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
              <button onClick={handleDeviceReject} className="glass-btn flex-1 py-2 text-sm flex items-center justify-center gap-1.5" style={{ color: "var(--text-muted)" }}>
                <span>Reject</span>
                <kbd className="text-[10px] font-mono px-1 py-0.5 rounded opacity-70 leading-none" style={{ background: "var(--glass-bg)" }}>Esc</kbd>
              </button>
              <button
                onClick={handleDeviceApprove}
                className="flex-1 py-2 text-sm font-semibold rounded-lg flex items-center justify-center gap-1.5"
                style={{ background: "var(--brand-500)", color: "#fff" }}
              >
                <span>Approve</span>
                <kbd className="text-[10px] font-mono px-1 py-0.5 rounded bg-white/20 text-white leading-none">↵</kbd>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
