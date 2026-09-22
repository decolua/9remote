import { useState, useEffect, useRef } from "preact/hooks";
import QRCard from "../components/QRCard";
import ConfirmPopup from "../components/ConfirmPopup";
import SettingsMenu from "../components/SettingsMenu";
import { useI18n } from "../i18n";
import { UPDATE_UI } from "../lib/constants";

const getPermissionMeta = (t) => ({
  screenRecording: { label: t("remote.screenRecording"), icon: "screenshot_monitor", desc: t("remote.captureScreen") },
  accessibility:   { label: t("remote.accessibility"),    icon: "accessibility_new",  desc: t("remote.controlMouseKeyboard") },
});

/** Reusable pill switch — single source for all on/off toggles */
function Toggle({ on, onClick, activeColor = "linear-gradient(135deg, var(--brand-500), var(--brand-400))", title, disabled }) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={title}
      className="flex-shrink-0 w-[46px] h-[26px] rounded-full transition-all relative"
      style={{ background: on ? activeColor : "rgba(140,145,160,0.35)", border: on ? "1px solid transparent" : "1px solid rgba(140,145,160,0.55)", opacity: disabled ? 0.5 : 1, cursor: disabled ? "not-allowed" : "pointer" }}
    >
      <span className="absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all"
        style={{ left: on ? "calc(100% - 22px)" : "2px", boxShadow: "0 2px 6px rgba(0,0,0,0.4)" }} />
    </button>
  );
}

/** Permission chip — click to request when missing */
function PermChip({ granted, label, onRequest }) {
  return (
    <button
      onClick={granted ? undefined : onRequest}
      className="flex items-center gap-1.5 text-[11.5px] px-2.5 py-1 rounded-lg"
      style={{ background: "var(--row-bg)", border: "1px solid var(--border-subtle)", color: granted ? "var(--success)" : "var(--text-muted)", cursor: granted ? "default" : "pointer" }}
      title={granted ? "" : "Click to grant permission"}
    >
      {granted && <span className="material-symbols-outlined" style={{ fontSize: 15 }}>check_circle</span>}
      {label}
      {!granted && <span className="material-symbols-outlined" style={{ fontSize: 19, color: "var(--text-subtle)" }}>toggle_off</span>}
    </button>
  );
}

/** Remote Desktop row — flat setting row inside Services section */
function RemoteDesktopRow({ desktopEnabled, onDesktopToggle, permissions, onRequestPermission, t }) {
  const permEntries = Object.entries(getPermissionMeta(t));
  const canEnableDesktop = permEntries.every(([type]) => !!permissions?.[type]);
  const toggleDisabled = !canEnableDesktop && !desktopEnabled;

  return (
    <div className="row-hover flex items-start gap-4 py-3.5 px-3 -mx-3 rounded-xl">
      <div
        className="w-[34px] h-[34px] rounded-[9px] flex items-center justify-center flex-shrink-0 mt-0.5"
        style={{
          background: !canEnableDesktop ? "rgba(var(--warn-rgb),0.12)" : desktopEnabled ? "rgba(var(--brand-rgb),0.08)" : "var(--row-bg)",
          border: `1px solid ${!canEnableDesktop ? "rgba(var(--warn-rgb),0.3)" : desktopEnabled ? "rgba(var(--brand-rgb),0.25)" : "var(--border-subtle)"}`,
          color: !canEnableDesktop ? "var(--warn)" : desktopEnabled ? "var(--brand-400)" : "var(--text-muted)",
        }}
      >
        <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
          {!canEnableDesktop ? "warning" : "desktop_windows"}
        </span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-[13.5px] font-semibold" style={{ color: "var(--text-main)" }}>
            {t("remote.remoteDesktop")}
          </p>
          {!canEnableDesktop ? (
            <span className="text-[10.5px] font-semibold px-2 py-0.5 rounded-full flex-shrink-0" style={{ background: "rgba(var(--warn-rgb), 0.15)", color: "var(--warn)" }}>
              Permission needed
            </span>
          ) : null}
        </div>
        <p className="text-[11.5px] mt-0.5" style={{ color: "var(--text-muted)" }}>
          {!canEnableDesktop
            ? "Grant permissions to allow screen & control access"
            : t("remote.controlScreen") || "Control screen, mouse & keyboard"}
        </p>
        {permEntries.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 mt-2.5">
            {permEntries.map(([type, meta]) => (
              <PermChip
                key={type}
                granted={!!permissions?.[type]}
                label={meta.label}
                onRequest={() => onRequestPermission(type)}
              />
            ))}
          </div>
        )}
      </div>
      <Toggle
        on={desktopEnabled}
        onClick={onDesktopToggle}
        disabled={toggleDisabled}
        title={toggleDisabled ? t("dialogs.grantPermissions") : ""}
      />
    </div>
  );
}

/** Section — mono uppercase label + hairline, content rows below (login parity) */
function Section({ title, count, first, children }) {
  return (
    <div className={first ? "" : "mt-10"}>
      <div
        className="flex items-center gap-2.5 font-mono text-[11px] uppercase tracking-[0.12em] pb-2.5 mb-1"
        style={{ color: "var(--text-subtle)", borderBottom: "1px solid var(--border-subtle)" }}
      >
        {title}
        {count != null && (
          <span className="ml-auto tracking-normal" style={{ color: "var(--text-muted)" }}>{count}</span>
        )}
      </div>
      {children}
    </div>
  );
}

// Phase → { text builder, icon, spinning } — config-driven UI states
const UPDATE_PHASES = {
  idle:       { icon: "system_update", spin: false, text: (v) => `Version ${v} available` },
  confirm:    { icon: "system_update", spin: false, text: () => "Update 9remote? Restarts connection (~1 min)" },
  updating:   { icon: "progress_activity", spin: true, text: (v, s) => `Updating… ${s}s` },
  restarting: { icon: "restart_alt", spin: true, text: (v, s) => `Updating 9remote… ${s}s` },
  ready:      { icon: "check_circle", spin: false, text: () => "Updated! Reloading…" },
  timeout:    { icon: "warning", spin: false, text: () => "Taking longer than expected" },
};

function UpdateBanner({ version }) {
  const [phase, setPhase] = useState("idle");
  const [seconds, setSeconds] = useState(0);

  // Drives elapsed counter + polls /api/state to detect agent restart, then reloads.
  // Transition: updating → (fetch fails = agent died) restarting → (fetch ok again) ready → reload
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
          if (diedOnce) { setPhase("ready"); clearInterval(poll); setTimeout(() => location.reload(), 600); }
        } catch {
          diedOnce = true;
          setPhase("restarting");
        }
      }, UPDATE_UI.pollMs);
    };
    const delay = setTimeout(startPoll, UPDATE_UI.startDelayMs);
    return () => { clearInterval(tick); clearInterval(poll); clearTimeout(delay); };
  }, [phase === "updating" || phase === "restarting"]);

  if (!version) return null;

  const handleConfirm = () => {
    setPhase("updating");
    fetch("/api/update", { method: "POST" }).catch(() => {});
  };

  const p = UPDATE_PHASES[phase];
  const busy = phase !== "idle" && phase !== "timeout";
  // Time-estimated progress (update runs detached → no real %)
  const progress = phase === "ready" ? 100 : Math.min((seconds * 1000 / UPDATE_UI.timeoutMs) * 100, 95);

  // Full-screen wait overlay while the detached update script reinstalls the agent —
  // mirrors web's UpdateModal so the Tauri webview never sits on a dead page.
  if (busy) {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center" style={{ background: "var(--bg-main)" }}>
        <div className="text-center mx-4" style={{ maxWidth: 320 }}>
          <span className={`material-symbols-outlined text-4xl ${p.spin ? "animate-spin" : ""}`} style={{ color: "var(--brand-400)" }}>{p.icon}</span>
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
      <span className={`material-symbols-outlined text-sm flex-shrink-0 ${p.spin ? "animate-spin" : ""}`} style={{ color: "var(--brand-400)" }}>{p.icon}</span>
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
        <button onClick={() => location.reload()} className="flex-shrink-0 text-xs px-2 py-0.5 rounded font-medium" style={{ background: "rgba(var(--brand-rgb),0.15)", color: "var(--brand-400)" }}>Reload</button>
      )}
    </div>
  );
}

/** Merge approved + rejected devices with active connections into 1 client = 1 device list.
 *  Same device may open multiple sockets — use earliest connectedAt. */
function mergeClients(approvedDevices, connections, rejectedDevices = []) {
  const connByDevice = new Map();
  for (const c of connections) {
    if (!c.deviceId) continue;
    const existing = connByDevice.get(c.deviceId);
    if (!existing || (c.connectedAt && c.connectedAt < existing.connectedAt)) {
      connByDevice.set(c.deviceId, c);
    }
  }

  const approved = approvedDevices.map((d) => {
    const conn = connByDevice.get(d.deviceId);
    return {
      deviceId: d.deviceId,
      status: conn ? "online" : "offline",
      ip: conn?.ip || null,
      connType: conn?.type || null,
      connectedAt: conn?.connectedAt || null,
      approvedAt: d.approvedAt || null,
      label: d.label || "",
    };
  });

  const pending = rejectedDevices.map((r) => ({
    deviceId: r.deviceId,
    status: "pending",
    ip: r.ip || null,
    connectedAt: null,
    approvedAt: null,
    rejectedAt: r.rejectedAt || null,
  }));

  const rank = { online: 0, pending: 1, offline: 2 };
  return [...approved, ...pending].sort((a, b) => rank[a.status] - rank[b.status]);
}

// Status pill styling — inline chip next to device name
const STATUS_META = {
  online:  { color: "var(--success)",     bg: "rgba(var(--success-rgb),0.14)", label: "Online" },
  offline: { color: "var(--text-subtle)", bg: "var(--row-bg)",                 label: "Offline" },
  pending: { color: "var(--warn)",        bg: "rgba(var(--warn-rgb),0.14)",    label: "Pending" },
};

// Rough device icon from label — laptop vs phone
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
      <div
        className="w-[34px] h-[34px] rounded-[9px] flex items-center justify-center flex-shrink-0"
        style={{ background: "var(--row-bg)", border: "1px solid var(--border-subtle)" }}
      >
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
        <button
          onClick={() => onApprove?.(client)}
          className="flex-shrink-0 text-[12.5px] font-semibold px-3.5 py-2 rounded-lg btn-primary"
          title="Approve this device"
        >
          Approve
        </button>
      ) : (
        <button
          onClick={() => onRemove(client)}
          className="glass-btn flex-shrink-0 text-[12px] font-semibold px-3.5 py-2 rounded-lg"
          style={{ color: "var(--text-muted)" }}
          title="Disconnect and remove this device"
        >
          {client.status === "online" ? "Disconnect" : "Remove"}
        </button>
      )}
    </div>
  );
}

/** Tunnel status chip — the single spot where tunnel state is visible. */
function TunnelChip({ step }) {
  // STEP enum: STOPPED=0, PREPARING=1 … READY=5
  const isStopped = step === 0;
  const isReady = step === 5;
  const dotColor = isReady ? "var(--success)" : isStopped ? "var(--danger)" : "var(--warn)";
  const label = isReady ? "tunnel · online" : isStopped ? "tunnel · offline" : "tunnel · connecting";
  // Read-only: it used to fire the restart action, so a tap meant to inspect the state
  // dropped every connected client. Restart lives in the settings menu behind a confirm.
  return (
    <div
      title={label}
      className="inline-flex items-center gap-2 font-mono text-xs px-3.5 py-[7px] rounded-full max-w-full"
      style={{ border: "1px solid var(--border-subtle)", background: "var(--row-bg)", color: isReady ? "var(--text-main)" : "var(--text-muted)" }}
    >
      <span
        className={`w-[7px] h-[7px] rounded-full flex-shrink-0 ${!isStopped && !isReady ? "chip-blink" : ""}`}
        style={{ background: dotColor, boxShadow: isReady ? "0 0 10px rgba(var(--success-rgb),0.9)" : undefined }}
      />
      <span className="truncate">{label}</span>
    </div>
  );
}

/** RTC/WS peer counts — live transport status beside the tunnel chip */
function RtcChip({ transport }) {
  const rtc = transport?.rtcPeers || 0;
  const ws = transport?.wsPeers || 0;
  const alive = rtc > 0 || ws > 0;
  return (
    <div
      className="inline-flex items-center gap-2 font-mono text-xs px-3.5 py-[7px] rounded-full"
      style={{ border: "1px solid var(--border-subtle)", background: "var(--row-bg)", color: alive ? "var(--text-main)" : "var(--text-subtle)" }}
    >
      <span
        className="w-[7px] h-[7px] rounded-full flex-shrink-0"
        style={{ background: alive ? "var(--success)" : "var(--text-subtle)", boxShadow: alive ? "0 0 10px rgba(var(--success-rgb),0.9)" : undefined }}
      />
      <span>{alive ? `rtc ${rtc} · ws ${ws}` : "rtc · idle"}</span>
    </div>
  );
}

// Setup steps shown as dots while connecting (labels shared with StepProgress)
const STEP_KEYS = ["steps.preparing", "steps.connecting", "steps.tunneling", "steps.verifying", "steps.ready"];

/** Step-by-step progress under the chips — only while connecting */
function TunnelSteps({ step, stepDesc, t }) {
  const activeIdx = Math.min(Math.max(step - 1, 0), STEP_KEYS.length - 1);
  return (
    <div className="relative z-[1] flex flex-col items-center gap-2 mb-4">
      <div className="flex items-center">
        {STEP_KEYS.map((key, i) => {
          const done = i < activeIdx;
          const active = i === activeIdx;
          return (
            <div key={key} className="flex items-center">
              <span
                className={`w-[9px] h-[9px] rounded-full ${active ? "chip-blink" : ""}`}
                style={{
                  background: done || active ? "var(--brand-500)" : "var(--row-hover)",
                  border: done || active ? "none" : "1px solid var(--border)",
                  boxShadow: active ? "0 0 8px rgba(var(--brand-rgb),0.7)" : undefined,
                }}
              />
              {i < STEP_KEYS.length - 1 && (
                <span className="w-5 h-px" style={{ background: done ? "var(--brand-500)" : "var(--border)" }} />
              )}
            </div>
          );
        })}
      </div>
      <span className="text-[11px] font-mono text-center max-w-full truncate" style={{ color: "var(--text-subtle)" }}>
        {t(STEP_KEYS[activeIdx])}{stepDesc ? ` — ${stepDesc}` : ""}
      </span>
    </div>
  );
}

export default function MainScreen({
  agentReachable = true,
  step, stepDesc = "", healthCheck, transport, tunnelUrl, oneTimeKey, oneTimeKeyExpiresAt, permanentKey, qrUrl,
  permissions, desktopEnabled, updateVersion, connections = [], version = "",
  onRequestPermission, onDesktopToggle, onStop, onShutdown, onGenerateOneTimeKey, onRegenerateKey, logs = [], onClearLogs,
  theme, onToggleTheme,
  pendingDevice, onDeviceApprove, onDeviceReject,
  approvedDevices = [], rejectedDevices = [], onDeviceRemove, onFetchDevices, onDeviceApproveRejected, onDeviceLabel,
  autoApprove = false, onAutoApproveToggle,
  autoStart = false, onAutoStartToggle,
  sleepInhibitMode = "never", sleepInhibitPresets = [], onSleepInhibitChange,
  unlockStatus = null, onRequestUnlockInstall, onRequestUnlockUninstall,
}) {
  const { t } = useI18n();
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
  const [showShutdownConfirm, setShowShutdownConfirm] = useState(false);
  const [deviceToRemove, setDeviceToRemove] = useState(null);
  const [deviceToLabel, setDeviceToLabel] = useState(null);
  const [labelInput, setLabelInput] = useState("");
  const rejectBtnRef = useRef(null);

  // Open the embedded web terminal workspace directly on localhost.
  // No key in the URL: the loopback bootstrap fetches it from /api/ui/state
  // (localhost-only endpoint), so nothing secret ever lands in history.
  const openWebTerminal = () => {
    const targetUrl = window.location.port === "5173"
      ? `${window.location.protocol}//${window.location.hostname}:2208/workspace`
      : "/workspace";
    // The Tauri shell's WKWebView blocks window.open — navigate this window
    // instead (the app window becomes the workspace).
    if (window.__TAURI__) { window.location.href = targetUrl; return; }
    window.open(targetUrl, "_blank");
  };

  const openRemoteConnect = () => {
    try { sessionStorage.setItem("9remote_manual_disconnect", "1"); } catch {}
    const targetUrl = window.location.port === "5173"
      ? `${window.location.protocol}//${window.location.hostname}:2208/login?mode=remote`
      : "/login?mode=remote";
    if (window.__TAURI__) { window.location.href = targetUrl; return; }
    window.open(targetUrl, "_blank");
  };

  // Refresh devices list whenever connections update (so offline/online stays in sync)
  useEffect(() => { onFetchDevices?.(); }, [connections.length]);

  // Keyboard navigation for pending device modal: Enter to approve, Escape to reject
  useEffect(() => {
    if (!pendingDevice) return;
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); onDeviceReject?.(); }
      else if (e.key === "Enter") {
        if (rejectBtnRef.current && document.activeElement === rejectBtnRef.current) return;
        e.preventDefault();
        onDeviceApprove?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pendingDevice, onDeviceReject, onDeviceApprove]);

  const clients = mergeClients(approvedDevices, connections, rejectedDevices);
  const onlineCount = clients.filter((c) => c.status === "online").length;

  return (
    <div className="h-full w-full flex overflow-hidden isolate" style={{ background: "var(--bg-body)" }}>
      {/* Background — square grid + drifting white light (login parity) */}
      <div className="bg-sq-grid fixed inset-0 pointer-events-none" style={{ zIndex: -3 }} aria-hidden="true" />
      <div className="bg-light-drift fixed inset-0 pointer-events-none" style={{ zIndex: -2 }} aria-hidden="true" />

      {/* Full-bleed 50/50 split — pairing left, manage right.
          Mobile: single column, whole page scrolls; panes get own scroll from lg. */}
      <main className="flex-1 min-w-0 grid grid-cols-1 lg:grid-cols-2 overflow-y-auto lg:overflow-hidden">
        {/* Every chip below keeps its last value when the agent process dies, so without
            this the page keeps claiming a healthy tunnel over a dead server. */}
        {!agentReachable && (
          <div
            className="col-span-full px-4 py-2 text-center text-xs font-medium"
            style={{ background: "var(--danger)", color: "#fff" }}
          >
            {t("connection.agentUnreachable")}
          </div>
        )}

        {/* ═══ LEFT — pairing ═══ */}
        <section className="relative flex flex-col p-6 lg:p-10 min-w-0 lg:overflow-y-auto">
          <div className="pane-hero-glow" aria-hidden="true" />

          {/* my-auto centers when room, collapses when overflowing (justify-center would clip the top) */}
          <div className="relative z-[1] flex flex-col items-center my-auto">
            <div className="flex flex-wrap items-center justify-center gap-2 mb-3">
              <TunnelChip step={step} />
              <RtcChip transport={transport} />
            </div>
            {step > 0 && step < 5 ? (
              <TunnelSteps step={step} stepDesc={stepDesc} t={t} />
            ) : (
              <div className="h-2" />
            )}

            <h1 className="brand-grad-text text-[30px] lg:text-[34px] font-bold tracking-[-0.03em] leading-[1.05] text-center mb-5">
              {t("connection.pairDevice")}
            </h1>

            <QRCard
              qrUrl={qrUrl}
              oneTimeKey={oneTimeKey}
              oneTimeKeyExpiresAt={oneTimeKeyExpiresAt}
              permanentKey={permanentKey}
              onGenerateOneTimeKey={onGenerateOneTimeKey}
              onRegenerateKey={onRegenerateKey}
            />
          </div>
        </section>

        {/* ═══ RIGHT — manage (translucent pane, light passes through) ═══ */}
        <section
          className="relative min-w-0 pt-10 pb-11 pr-8 pl-6 lg:pl-14 lg:pr-12 lg:overflow-y-auto"
          style={{ background: "var(--pane-right-bg)" }}
        >
          {/* Brand row — logo + actions (login header parity) */}
          <div className="flex items-center gap-3 mb-8">
            <div className="logo-glass w-10 h-10 rounded-[11px] grid place-items-center flex-shrink-0">
              <span className="material-symbols-outlined" style={{ fontSize: 21, color: "var(--text-main)" }}>terminal</span>
            </div>
            <div className="flex flex-col leading-none min-w-0">
              <span className="brand-grad-text text-[20px] font-bold tracking-[-0.02em]">9Remote</span>
              {version && <span className="font-mono text-[11px] mt-[5px]" style={{ color: "var(--text-subtle)" }}>v{version}</span>}
            </div>
            <div className="flex-1" />
            <SettingsMenu
              variant="hdr"
              theme={theme}
              onToggleTheme={onToggleTheme}
              isStopped={step === 0}
              onStop={() => setShowDisconnectConfirm(true)}
              onShutdown={() => setShowShutdownConfirm(true)}
              logs={logs}
              onClearLogs={onClearLogs}
              autoStart={autoStart}
              onAutoStartToggle={onAutoStartToggle}
              sleepInhibitMode={sleepInhibitMode}
              sleepInhibitPresets={sleepInhibitPresets}
              onSleepInhibitChange={onSleepInhibitChange}
              unlockStatus={unlockStatus}
              onRequestUnlockInstall={onRequestUnlockInstall}
              onRequestUnlockUninstall={onRequestUnlockUninstall}
              version={version}
            />
          </div>

          <UpdateBanner version={updateVersion} />

          {/* Hero Workspace Cards — primary user actions */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 mb-8">
            {/* This Workspace - Local */}
            <button
              onClick={openWebTerminal}
              className="hero-card group text-left p-4 flex flex-col justify-between"
            >
              <div className="flex items-start justify-between w-full mb-3 relative z-[1]">
                <div
                  className="w-10 h-10 rounded-xl flex items-center justify-center transition-transform group-hover:scale-105"
                  style={{ background: "var(--surface-2)", color: "var(--text-main)", border: "1px solid var(--border-subtle)" }}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 22 }}>computer</span>
                </div>
                <span className="material-symbols-outlined text-text-muted opacity-60 group-hover:opacity-100 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-all" style={{ fontSize: 16 }}>
                  open_in_new
                </span>
              </div>
              <div className="relative z-[1]">
                <h3 className="text-[15px] font-bold tracking-tight" style={{ color: "var(--text-main)" }}>
                  This Workspace
                </h3>
                <p className="text-xs mt-0.5 font-normal line-clamp-1" style={{ color: "var(--text-muted)" }}>
                  Terminal & files on this machine
                </p>
              </div>
            </button>

            {/* Remote Workspace */}
            <button
              onClick={openRemoteConnect}
              className="hero-card group text-left p-4 flex flex-col justify-between"
            >
              <div className="flex items-start justify-between w-full mb-3 relative z-[1]">
                <div
                  className="w-10 h-10 rounded-xl flex items-center justify-center transition-transform group-hover:scale-105"
                  style={{ background: "var(--surface-2)", color: "var(--text-main)", border: "1px solid var(--border-subtle)" }}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 22 }}>hub</span>
                </div>
                <span className="material-symbols-outlined text-text-muted opacity-60 group-hover:opacity-100 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-all" style={{ fontSize: 16 }}>
                  open_in_new
                </span>
              </div>
              <div className="relative z-[1]">
                <h3 className="text-[15px] font-bold tracking-tight" style={{ color: "var(--text-main)" }}>
                  Remote Workspace
                </h3>
                <p className="text-xs mt-0.5 font-normal line-clamp-1" style={{ color: "var(--text-muted)" }}>
                  Connect to a remote agent
                </p>
              </div>
            </button>
          </div>

          {/* Services - Remote Desktop */}
          <Section title="Services" first>
            <RemoteDesktopRow
              desktopEnabled={desktopEnabled}
              onDesktopToggle={onDesktopToggle}
              permissions={permissions}
              onRequestPermission={onRequestPermission}
              t={t}
            />
          </Section>

          {/* Clients */}
          <Section title="Clients" count={clients.length > 0 ? `${onlineCount}/${clients.length}` : null}>
            <div className="row-hover flex items-center gap-4 py-3 px-3 -mx-3 rounded-xl">
              <span className="material-symbols-outlined flex-shrink-0" style={{ fontSize: 19, color: autoApprove ? "var(--brand-400)" : "var(--text-muted)" }}>
                {autoApprove ? "lock_open" : "lock"}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-[13.5px] font-semibold" style={{ color: "var(--text-main)" }}>{t("clients.autoApprove")}</p>
              </div>
              <Toggle on={autoApprove} onClick={onAutoApproveToggle} title={autoApprove ? "Disable auto-approve" : "Enable auto-approve"} />
            </div>

            {clients.length === 0 ? (
              <p className="text-xs text-center py-4" style={{ color: "var(--text-muted)" }}>No clients yet</p>
            ) : (
              clients.map((c) => (
                <ClientItem
                  key={c.deviceId}
                  client={c}
                  onRemove={setDeviceToRemove}
                  onApprove={(cl) => onDeviceApproveRejected?.(cl.deviceId)}
                  onLabel={(cl) => { setDeviceToLabel(cl); setLabelInput(cl.label || ""); }}
                />
              ))
            )}
          </Section>
        </section>
      </main>

      {showDisconnectConfirm && (
        <ConfirmPopup
          message="Reset and stop the tunnel? Remote clients will be disconnected."
          confirmLabel="Reset"
          onConfirm={() => { setShowDisconnectConfirm(false); onStop?.(); }}
          onCancel={() => setShowDisconnectConfirm(false)}
        />
      )}

      {showShutdownConfirm && (
        <ConfirmPopup
          message="Shutdown 9Remote completely? This will stop the server, close the tunnel and quit the app."
          confirmLabel="Shutdown"
          confirmDanger
          onConfirm={() => { setShowShutdownConfirm(false); onShutdown?.(); }}
          onCancel={() => setShowShutdownConfirm(false)}
        />
      )}

      {deviceToRemove && (
        <ConfirmPopup
          message={deviceToRemove.status === "online"
            ? `Disconnect and remove device ${deviceToRemove.deviceId.slice(0, 8)}...? The client will be disconnected and need approval again next time.`
            : deviceToRemove.status === "pending"
              ? `Remove pending device ${deviceToRemove.deviceId.slice(0, 8)}...? It will need a fresh approval request to connect again.`
              : `Remove device ${deviceToRemove.deviceId.slice(0, 8)}...? It will need approval again next time.`}
          confirmLabel={deviceToRemove.status === "online" ? "Disconnect & Remove" : "Remove"}
          confirmDanger
          onConfirm={() => { onDeviceRemove?.(deviceToRemove); setDeviceToRemove(null); }}
          onCancel={() => setDeviceToRemove(null)}
        />
      )}

      {deviceToLabel && (
        <ConfirmPopup
          message={`Name for device ${deviceToLabel.deviceId.slice(0, 8)}...`}
          confirmLabel="Save"
          inputValue={labelInput}
          inputPlaceholder="e.g. My MacBook"
          onInput={setLabelInput}
          onConfirm={() => { onDeviceLabel?.(deviceToLabel.deviceId, labelInput.trim()); setDeviceToLabel(null); }}
          onCancel={() => setDeviceToLabel(null)}
        />
      )}

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
              <button ref={rejectBtnRef} onClick={onDeviceReject} className="glass-btn flex-1 py-2 text-sm flex items-center justify-center gap-1.5" style={{ color: "var(--text-muted)" }}>
                <span>Reject</span>
                <kbd className="text-[10px] font-mono px-1 py-0.5 rounded opacity-70 leading-none" style={{ background: "var(--glass-bg)" }}>Esc</kbd>
              </button>
              <button
                onClick={onDeviceApprove}
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
