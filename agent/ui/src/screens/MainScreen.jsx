import { useState, useRef, useEffect } from "preact/hooks";
import StepProgress from "../components/StepProgress";
import QRCard from "../components/QRCard";
import ConfirmPopup from "../components/ConfirmPopup";
import SettingsMenu from "../components/SettingsMenu";
import SystemPane from "../components/SystemPane";
import { useI18n } from "../i18n";
import { UPDATE_UI } from "../lib/constants";

// Left menu — config-driven nav + per-menu header meta (9router pattern)
const MENU = [
  { id: "connection", label: "Connection", icon: "hub", desc: "Pair devices and manage your secure tunnel" },
  { id: "terminals", label: "Terminal", icon: "open_in_new", desc: "Open the web terminal" },
  { id: "logs", label: "Logs", icon: "description", desc: "Server activity and diagnostics" },
];

const DEFAULT_MENU = "connection";
const TERMINALS_MENU = "terminals";

// Parse URL pathname → { menu }
const parsePath = () => {
  const [seg] = window.location.pathname.replace(/^\/+/, "").split("/");
  return { menu: MENU.some((m) => m.id === seg) ? seg : DEFAULT_MENU };
};

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

/** Square feature icon — mockup .sic */
function Sic({ icon, active }) {
  return (
    <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
      style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
      <span className="material-symbols-outlined" style={{ fontSize: 20, color: active ? "var(--brand-400)" : "var(--text-muted)" }}>{icon}</span>
    </div>
  );
}

/** Permission chip — mockup .perm (click to request when missing) */
function PermChip({ granted, label, onRequest }) {
  return (
    <button
      onClick={granted ? undefined : onRequest}
      className="flex items-center gap-1.5 text-[11.5px] px-2.5 py-1 rounded-lg"
      style={{ background: "var(--surface-2)", border: "1px solid var(--border)", color: granted ? "var(--success)" : "var(--text-muted)", cursor: granted ? "default" : "pointer" }}
      title={granted ? "" : "Click to grant permission"}
    >
      {granted && <span className="material-symbols-outlined" style={{ fontSize: 15 }}>check_circle</span>}
      {label}
      {!granted && <span className="material-symbols-outlined" style={{ fontSize: 19, color: "var(--text-subtle)" }}>toggle_off</span>}
    </button>
  );
}

const getSleepModeLabels = (t) => ({
  "30m":   t("remote.sleepModes.30m"),
  "1h":    t("remote.sleepModes.1h"),
  "2h":    t("remote.sleepModes.2h"),
  "4h":    t("remote.sleepModes.4h"),
  "24h":   t("remote.sleepModes.24h"),
  "never": t("remote.sleepModes.never"),
});

/** Single service row — mockup .srv (square icon + body + right control) */
function SrvRow({ icon, active, name, desc, children, extra }) {
  return (
    <div className="flex items-center gap-3.5 py-3.5 border-t first:border-t-0 first:pt-0" style={{ borderColor: "var(--border)" }}>
      <Sic icon={icon} active={active} />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold" style={{ color: "var(--text-main)" }}>{name}</p>
        <p className="text-[11.5px] mt-0.5" style={{ color: "var(--text-muted)" }}>{desc}</p>
        {extra}
      </div>
      {children}
    </div>
  );
}

/** Remote Services card — Terminal (always on) + Desktop + startup rows (pro5 .srv pattern) */
function ServicesCard({ desktopEnabled, onDesktopToggle, permissions, onRequestPermission, autoStart, onAutoStartToggle, sleepInhibitMode, sleepInhibitPresets, onSleepInhibitChange, unlockStatus, onRequestUnlockInstall, onRequestUnlockUninstall, t }) {
  const permEntries = Object.entries(getPermissionMeta(t));
  // Desktop toggle requires all permissions granted
  const canEnableDesktop = permEntries.every(([type]) => !!permissions?.[type]);
  const toggleDisabled = !canEnableDesktop && !desktopEnabled;
  const sleepLabels = getSleepModeLabels(t);
  return (
    <div className="card-elev p-5">
      {/* Card header */}
      <div className="flex items-center gap-2.5 mb-1">
        <span className="material-symbols-outlined" style={{ fontSize: 20, color: "var(--brand-400)" }}>tune</span>
        <h3 className="text-[15px] font-semibold" style={{ color: "var(--text-main)" }}>Remote services</h3>
      </div>

      {/* Desktop — toggle + permission chips */}
      <SrvRow
        icon="desktop_windows"
        active={desktopEnabled}
        name={t("remote.remoteDesktop")}
        desc={t("remote.controlScreen")}
        extra={
          <div className="flex flex-wrap gap-2 mt-2">
            {permEntries.map(([type, meta]) => (
              <PermChip key={type} granted={!!permissions?.[type]} label={meta.label} onRequest={() => onRequestPermission(type)} />
            ))}
          </div>
        }
      >
        <Toggle on={desktopEnabled} onClick={onDesktopToggle} disabled={toggleDisabled} title={toggleDisabled ? t("dialogs.grantPermissions") : ""} />
      </SrvRow>

      {/* Auto-start on boot */}
      <SrvRow
        icon="rocket_launch"
        active={!!autoStart}
        name={t("remote.launchOnStartup")}
        desc={autoStart ? t("remote.launchDesc") : t("remote.disabledStart")}
      >
        <Toggle on={!!autoStart} onClick={onAutoStartToggle} />
      </SrvRow>

      {/* Keep awake */}
      <SrvRow
        icon="coffee"
        active={(sleepInhibitMode || "never") !== "never"}
        name={t("remote.preventSleep")}
        desc={t("remote.blockSleep")}
      >
        <select
          value={sleepInhibitMode || "never"}
          onChange={(e) => onSleepInhibitChange?.(e.target.value)}
          className="flex-shrink-0 text-[12.5px] px-3 py-2 rounded-xl"
          style={{ background: "var(--surface-2)", color: "var(--text-main)", border: "1px solid var(--border)", cursor: "pointer" }}
        >
          {(sleepInhibitPresets || []).map((m) => (
            <option key={m} value={m}>{sleepLabels[m] || m}</option>
          ))}
        </select>
      </SrvRow>

      {/* Remote unlock — toggle the Windows login-screen bridge. On = worker
          runs as SYSTEM + boot task; Off = stop worker + remove task (exe kept).
          Hidden on non-Windows. */}
      {unlockStatus?.supported && (
        <SrvRow
          icon="lock_open"
          active={!!unlockStatus.running}
          name={t("remote.remoteUnlock")}
          desc={
            unlockStatus.stale
              ? t("remote.remoteUnlockStale")
              : unlockStatus.running ? t("remote.remoteUnlockReady") : t("remote.remoteUnlockDesc")
          }
        >
          {/* Toggle follows `enabled` (persisted intent), not `running`: the worker
              can be briefly down (reboot, rebuild) without the switch flipping itself
              off. `active`/`desc` still show real liveness. */}
          <Toggle
            on={!!unlockStatus.enabled}
            disabled={!!unlockStatus.busy}
            onClick={() => (unlockStatus.enabled ? onRequestUnlockUninstall?.() : onRequestUnlockInstall?.())}
          />
        </SrvRow>
      )}
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
      {busy && <span className="text-xs flex-shrink-0" style={{ color: "var(--brand-400)", opacity: 0.6 }}>{seconds}s</span>}
      {busy && (
        <div className="absolute left-0 bottom-0 h-0.5 transition-all duration-1000 ease-linear" style={{ width: `${progress}%`, background: "var(--brand-400)" }} />
      )}
    </div>
  );
}

const getFeatures = (t) => [
  { icon: "terminal", label: t("connection.features.terminal"), desc: t("connection.features.fullShell") },
  { icon: "desktop_windows", label: t("connection.features.desktop"), desc: t("connection.features.remoteScreen") },
  { icon: "folder_open", label: t("connection.features.files"), desc: t("connection.features.browseEdit") },
];

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

// Status pill styling — mockup .st (inline chip next to device name)
const STATUS_META = {
  online:  { color: "var(--success)",     bg: "rgba(var(--success-rgb),0.14)", label: "Online" },
  offline: { color: "var(--text-subtle)", bg: "var(--surface-2)",              label: "Offline" },
  pending: { color: "var(--warn)",        bg: "rgba(var(--warn-rgb),0.14)",    label: "Pending" },
};

// Rough device icon from label — laptop vs phone (mockup .di)
const deviceIcon = (name) => (/mac|book|laptop|pc|windows|desktop|linux/i.test(name || "") ? "laptop_mac" : "smartphone");

function ClientItem({ client, onRemove, onApprove, onLabel }) {
  const shortId = `${client.deviceId.slice(0, 8)}...`;
  const name = client.label || shortId;
  const meta = STATUS_META[client.status] || STATUS_META.offline;
  const isPending = client.status === "pending";
  const timeLabel =
    client.status === "online"
      ? `${client.ip ? client.ip + " · " : ""}${client.connType ? client.connType.toUpperCase() + " · " : ""}connected ${client.connectedAt ? new Date(client.connectedAt).toLocaleTimeString(undefined, { hour12: false }) : ""}`
      : isPending
        ? "Waiting for approval"
        : client.approvedAt
          ? `Approved ${new Date(client.approvedAt).toLocaleDateString()}`
          : "Offline";

  return (
    <div
      className={`flex items-center gap-3.5 py-3 ${isPending ? "rounded-xl px-3 -mx-3" : "border-t first:border-t-0"}`}
      style={isPending ? { background: "linear-gradient(100deg, rgba(var(--warn-rgb),0.08), transparent)" } : { borderColor: "var(--border)" }}
    >
      <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
        <span className="material-symbols-outlined" style={{ fontSize: 20, color: "var(--text-muted)" }}>{deviceIcon(name)}</span>
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
          className="flex-shrink-0 text-[12.5px] font-semibold px-3.5 py-2 rounded-lg"
          style={{ background: "linear-gradient(135deg, var(--brand-500), var(--brand-400))", color: "#fff" }}
          title="Approve this device"
        >
          Approve
        </button>
      ) : (
        <button
          onClick={() => onRemove(client)}
          className="flex-shrink-0 text-[12.5px] font-semibold px-3.5 py-2 rounded-lg card-act"
          style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}
          title="Disconnect and remove this device"
        >
          {client.status === "online" ? "Disconnect" : "Remove"}
        </button>
      )}
    </div>
  );
}


/** Header icon-only button — uses native tooltip for clarity */
function HeaderIconBtn({ icon, title, danger, onClick }) {
  const btnClass = danger ? "btn-danger w-10 h-10 rounded-xl flex items-center justify-center" : "glass-btn w-10 h-10 rounded-xl flex items-center justify-center";
  return (
    <button onClick={onClick} title={title} className={btnClass} style={danger ? undefined : { color: "var(--text-muted)" }}>
      <span className="material-symbols-outlined text-xl">{icon}</span>
    </button>
  );
}

/** Connection empty-state shown in panel when tunnel offline — single Connect CTA */
function ConnectionEmpty({ onStart, t }) {
  const [connecting, setConnecting] = useState(false);
  const handleConnect = () => { setConnecting(true); onStart?.(); };
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-5 px-6 py-8 text-center max-w-lg w-full">
      <div className="w-16 h-16 rounded-2xl flex items-center justify-center" style={{ background: "var(--glass-bg)" }}>
        <span className="material-symbols-outlined" style={{ fontSize: 32, color: "var(--text-muted)" }}>cloud_off</span>
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-base font-semibold" style={{ color: "var(--text-main)" }}>{t("connection.tunnelOffline")}</p>
        <p className="text-xs leading-5" style={{ color: "var(--text-muted)" }}>{t("connection.startTunnel")}</p>
      </div>
      <button
        onClick={!connecting ? handleConnect : undefined}
        disabled={connecting}
        className="btn-primary w-full py-3 flex items-center justify-center gap-2 text-sm font-semibold"
        style={{ borderRadius: "var(--radius-brand)", opacity: connecting ? 0.7 : 1 }}
      >
        <span className="material-symbols-outlined text-base">play_arrow</span>
        {connecting ? t("connection.connecting") : t("connection.connect")}
      </button>
      <div className="grid grid-cols-3 gap-2 w-full">
        {getFeatures(t).map((f) => (
          <div key={f.label} className="dark-card flex flex-col items-center gap-1.5 py-3 px-1">
            <span className="material-symbols-outlined" style={{ fontSize: 20, color: "var(--brand-400)" }}>{f.icon}</span>
            <p className="text-[11px] font-semibold" style={{ color: "var(--text-main)" }}>{f.label}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Primary left navigation — logo top, menu mid, controls bottom (9router pattern) */
function Sidebar({ activeMenu, onSelect, version, isReady, transport, onTransportChange, onClose, notifications, sessions = [], onSelectSession, onDismissRecent }) {
  const { t } = useI18n();
  const handleSelect = (id) => { onSelect(id); onClose?.(); };
  const handleSelectSession = (id) => { onSelectSession?.(id); onClose?.(); };
  return (
    <aside className="flex flex-col sidebar w-[232px] xl:w-[264px] flex-shrink-0 h-full">
      {/* Brand */}
      <div className="flex items-center gap-3 px-5 py-5">
        <img src="/favicon.svg" alt="9Remote" className="w-10 h-10 rounded-xl flex-shrink-0" />
        <div className="flex flex-col leading-tight">
          <span className="brand-text text-xs">9Remote</span>
          {version && <span className="text-[10px] mt-0.5" style={{ color: "var(--text-muted)" }}>v{version}</span>}
        </div>
      </div>

      {isReady && (
        <div className="px-4 pb-3">
          <ConnectionStatus transport={transport} onTransportChange={onTransportChange} />
        </div>
      )}

      {/* Menu */}
      <nav className="flex-1 px-4 py-2 space-y-0.5 overflow-y-auto select-none">
        {MENU.map((m) => {
          const isActive = activeMenu === m.id;
          return (
            <button
              key={m.id}
              onClick={() => handleSelect(m.id)}
              className={`group relative w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all text-left ${isActive ? "" : "card-act"}`}
              style={isActive
                ? { background: "linear-gradient(100deg, var(--brand-tint), transparent)", color: "var(--brand-500)", border: "1px solid rgba(var(--brand-rgb),0.25)" }
                : { color: "var(--text-muted)" }}
            >
              {isActive && <span className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-5 rounded-full" style={{ background: "var(--brand-500)" }} />}
              <span className={`material-symbols-outlined text-[20px] flex-shrink-0 ${isActive ? "fill-1" : ""}`}>{m.icon}</span>
              <span className={`text-[13px] leading-tight ${isActive ? "font-semibold" : "font-medium"}`}>{t(`menu.${m.id}`)}</span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}

/** Content header — per-menu title/icon/desc + global actions (9router pattern) */
function PageHeader({ menu, isStopped, theme, onToggleTheme, onStop, onShutdown, onMenuClick }) {
  const { t } = useI18n();
  return (
    <header className="shrink-0 flex items-center justify-between gap-3 px-6 lg:px-10 pt-5 pb-1">
      <div className="flex items-center gap-3 min-w-0">
        <button onClick={onMenuClick} className="md:hidden glass-btn w-8 h-8 flex items-center justify-center flex-shrink-0" style={{ color: "var(--text-muted)" }} aria-label="Open menu">
          <span className="material-symbols-outlined text-lg">menu</span>
        </button>
        <span className="material-symbols-outlined text-[22px] flex items-center justify-center w-10 h-10 rounded-xl flex-shrink-0" style={{ color: "var(--brand-500)", background: "var(--brand-tint)" }}>{menu?.icon}</span>
        <div className="min-w-0">
          <h1 className="text-xl lg:text-2xl font-bold tracking-tight truncate" style={{ color: "var(--text-main)" }}>{menu ? t(`menu.${menu.id}`) : ""}</h1>
          {menu && <p className="hidden lg:block text-xs truncate mt-0.5" style={{ color: "var(--text-muted)" }}>{t(`menu.${menu.id}Desc`)}</p>}
        </div>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <HeaderIconBtn
          icon={theme === "dark" ? "light_mode" : "dark_mode"}
          title={theme === "dark" ? t("header.lightMode") : t("header.darkMode")}
          onClick={onToggleTheme}
        />
        <SettingsMenu isStopped={isStopped} onStop={onStop} onShutdown={onShutdown} />
      </div>
    </header>
  );
}

// One status line: green if RTC or Tunnel has peers, yellow if DO up but no peers, red if DO down.
function ConnectionStatus({ transport, onTransportChange }) {
  const sig = transport?.signaling || "off";
  const rtc = transport?.rtcPeers || 0;
  const ws = transport?.wsPeers || 0;
  const rtcDisabled = transport?.rtcDisabled;
  const alive = rtc > 0 || ws > 0;
  const dot = alive ? "var(--success)" : sig === "connected" ? "var(--warn)" : "var(--danger)";
  const label = alive ? "Connected" : sig === "connected" ? "Ready" : "Offline";
  const detail = alive ? `${rtc > 0 ? `RTC ${rtc}` : ""}${rtc > 0 && ws > 0 ? " · " : ""}${ws > 0 ? `WS ${ws}` : ""}`.trim() : "";

  const toggleRtc = async () => {
    const next = !rtcDisabled;
    onTransportChange?.({ ...transport, rtcDisabled: next });
    await fetch("/api/ui/rtc-toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disabled: next })
    }).catch(() => onTransportChange?.({ ...transport, rtcDisabled: !next }));
  };

  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-xl" style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${alive ? "health-dot" : ""}`} style={{ background: dot }} />
      <span className="text-[12.5px] font-medium" style={{ color: "var(--text-main)" }}>{label}</span>
      {detail && <span className="text-[11px] font-mono" style={{ color: "var(--text-muted)" }}>{detail}</span>}
      {/* Debug toggle — hidden behind long-press / title; not for end users */}
      <button
        onClick={toggleRtc}
        title={rtcDisabled ? "RTC OFF (debug) — click to enable" : "Disable RTC (debug)"}
        className="ml-auto flex-shrink-0 w-2.5 h-2.5 rounded-full transition-all"
        style={{ background: rtcDisabled ? "var(--danger)" : "transparent", border: rtcDisabled ? "none" : "1px solid var(--text-muted)", opacity: 0.4 }}
      />
    </div>
  );
}

export default function MainScreen({
  step, stepDesc = "", healthCheck, transport, onTransportChange, tunnelUrl, oneTimeKey, oneTimeKeyExpiresAt, permanentKey, qrUrl,
  permissions, desktopEnabled, updateVersion, connections = [], version = "",
  onRequestPermission, onDesktopToggle, onStop, onStart, onShutdown, onGenerateOneTimeKey,   onRegenerateKey, logs = [], onClearLogs,
  theme, onToggleTheme,
  pendingDevice, onDeviceApprove, onDeviceReject,
  approvedDevices = [], rejectedDevices = [], onDeviceRemove, onFetchDevices, onDeviceApproveRejected, onDeviceLabel,
  autoApprove = false, onAutoApproveToggle,
  autoStart = false, onAutoStartToggle,
  sleepInhibitMode = "never", sleepInhibitPresets = [], onSleepInhibitChange,
  unlockStatus = null, onRequestUnlockInstall, onRequestUnlockUninstall,
  onStopTunnel,
}) {
  const { t } = useI18n();
  const [activeMenu, setActiveMenu] = useState(() => parsePath().menu);
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
  const [showShutdownConfirm, setShowShutdownConfirm] = useState(false);
  const [deviceToRemove, setDeviceToRemove] = useState(null);
  const [deviceToLabel, setDeviceToLabel] = useState(null);
  const [labelInput, setLabelInput] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const logEndRef = useRef(null);
  const scrollRef = useRef(null);

  // Terminal is not a page — it launches the web app in a new tab.
  const navigateMenu = (id) => {
    if (id === TERMINALS_MENU) { openWebTerminal(); return; }
    setActiveMenu(id);
  };

  // Open the web app with auto-login via one-time key. Reuses the existing key if
  // still valid; creates a new one if expired or missing.
  const openWebTerminal = async () => {
    const expired = !oneTimeKeyExpiresAt || Date.now() > oneTimeKeyExpiresAt;
    if (!expired && qrUrl) { window.open(qrUrl, "_blank"); return; }
    // Need a new key — open blank tab first so the popup isn't blocked after the fetch.
    const win = window.open("", "_blank");
    if (!win) return;
    try {
      const res = await fetch("/api/key/one-time", { method: "POST" });
      if (res.ok) { const data = await res.json(); win.location.href = data.qrUrl; return; }
    } catch {}
    win.close();
  };

  // Sync state with browser back/forward
  useEffect(() => {
    const onPop = () => setActiveMenu(parsePath().menu);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Push URL whenever menu changes
  useEffect(() => {
    const next = `/${activeMenu}`;
    if (window.location.pathname !== next) window.history.pushState(null, "", next);
  }, [activeMenu]);

  // STEP enum: STOPPED=0, PREPARING=1, CONNECTING=2, TUNNELING=3, VERIFYING=4, READY=5
  const isReady = step === 5;
  const isStopped = step === 0;
  const isConnecting = step > 0 && step < 5;

  // Refresh devices list whenever tab active or state updates (so offline/online stays in sync)
  useEffect(() => {
    if (activeMenu === "logs" && logEndRef.current) logEndRef.current.scrollTop = logEndRef.current.scrollHeight;
    if (activeMenu === "connection") onFetchDevices?.();
  }, [logs, activeMenu, connections.length]);

  const clients = mergeClients(approvedDevices, connections, rejectedDevices);
  const onlineCount = clients.filter((c) => c.status === "online").length;

  const currentMenu = MENU.find((m) => m.id === activeMenu);

  return (
    <div className="h-full w-full flex overflow-hidden isolate" style={{ background: "var(--bg-body)" }}>
      {/* Background — flat base + brand grid (landing parity, fixed behind sidebar + main) */}
      <div className="dot-grid-bg fixed inset-0 pointer-events-none" style={{ zIndex: -4 }} aria-hidden="true" />
      <div className="landing-grid fixed inset-0 pointer-events-none" style={{ zIndex: -3 }} aria-hidden="true" />

      {/* Sidebar — desktop */}
      <div className="hidden md:flex">
        <Sidebar
          activeMenu={activeMenu}
          onSelect={navigateMenu}
          version={version}
          isReady={isReady}
          transport={transport}
          onTransportChange={onTransportChange}
          notifications={term.notifications}
          sessions={term.sessions}
          onSelectSession={openRecent}
          onDismissRecent={term.dismissRecent}
        />
      </div>

      {/* Sidebar — mobile overlay */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-40 bg-black/40 md:hidden" onClick={() => setSidebarOpen(false)} />
      )}
      <div className={`fixed inset-y-0 left-0 z-50 transform md:hidden transition-transform duration-300 ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}`}>
        <Sidebar
          activeMenu={activeMenu}
          onSelect={navigateMenu}
          version={version}
          isReady={isReady}
          transport={transport}
          onTransportChange={onTransportChange}
          onClose={() => setSidebarOpen(false)}
        />
      </div>

      {/* Main — whole pane scrolls, header flows with content (pro5 parity) */}
      <main ref={scrollRef} className="flex-1 min-w-0 h-full relative overflow-y-auto">
        <PageHeader
          menu={currentMenu}
          isStopped={isStopped}
          theme={theme}
          onToggleTheme={onToggleTheme}
          onStop={() => setShowDisconnectConfirm(true)}
          onShutdown={() => setShowShutdownConfirm(true)}
          onMenuClick={() => setSidebarOpen(true)}
        />
        {!isConnecting && <UpdateBanner version={updateVersion} />}
        <div className="px-6 lg:px-10 pb-6 lg:pb-10 pt-5">
          <div className="max-w-7xl mx-auto flex flex-col gap-4">
              {activeMenu === "connection" && isStopped && (
                <ConnectionEmpty onStart={onStart} t={t} />
              )}

              {activeMenu === "connection" && isConnecting && (
                <div className="flex-1 flex flex-col gap-4 max-w-2xl w-full">
                  <StepProgress currentStep={step} activeDesc={stepDesc} healthCheck={healthCheck} t={t} />
                </div>
              )}

              {activeMenu === "connection" && isReady && (
                <>
                  {/* QR (1fr) left + Config & Clients (1.7fr) right — pro5 ratio */}
                  <div className="grid grid-cols-1 lg:grid-cols-[minmax(300px,1fr)_1.7fr] gap-4 items-stretch">
                    <div>
                      <QRCard
                        qrUrl={qrUrl}
                        oneTimeKey={oneTimeKey}
                        oneTimeKeyExpiresAt={oneTimeKeyExpiresAt}
                        permanentKey={permanentKey}
                        onGenerateOneTimeKey={onGenerateOneTimeKey}
                        onRegenerateKey={onRegenerateKey}
                        onStopTunnel={onStopTunnel}
                      />
                    </div>
                    <div className="flex flex-col gap-4">
                      <ServicesCard
                        desktopEnabled={desktopEnabled}
                        onDesktopToggle={onDesktopToggle}
                        permissions={permissions}
                        onRequestPermission={onRequestPermission}
                        autoStart={autoStart}
                        onAutoStartToggle={onAutoStartToggle}
                        sleepInhibitMode={sleepInhibitMode}
                        sleepInhibitPresets={sleepInhibitPresets}
                        onSleepInhibitChange={onSleepInhibitChange}
                        unlockStatus={unlockStatus}
                        onRequestUnlockInstall={onRequestUnlockInstall}
                        onRequestUnlockUninstall={onRequestUnlockUninstall}
                        t={t}
                      />

                      {/* Clients (merged devices + live connections) */}
                      <div className="card-elev p-5 flex flex-col gap-1">
                      <div className="flex items-center gap-2.5 mb-2">
                        <span className="material-symbols-outlined flex-shrink-0" style={{ fontSize: 20, color: "var(--brand-400)" }}>devices</span>
                        <h3 className="text-[15px] font-semibold flex-1" style={{ color: "var(--text-main)" }}>Clients</h3>
                        {clients.length > 0 && (
                          <span className="text-[11px] font-mono" style={{ color: "var(--text-muted)" }}>
                            {onlineCount}/{clients.length} online
                          </span>
                        )}
                      </div>

                      {/* Auto-approve toggle */}
                      <div className="flex items-center gap-3 py-2.5">
                        <span className="material-symbols-outlined flex-shrink-0" style={{ fontSize: 18, color: autoApprove ? "var(--brand-400)" : "var(--text-muted)" }}>
                          {autoApprove ? "lock_open" : "lock"}
                        </span>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium" style={{ color: "var(--text-main)" }}>{t("clients.autoApprove")}</p>
                          <p className="text-[10px] leading-4" style={{ color: "var(--text-muted)" }}>
                            {autoApprove ? t("clients.anyDevice") : t("clients.requireManual")}
                          </p>
                        </div>
                        <Toggle on={autoApprove} onClick={onAutoApproveToggle} title={autoApprove ? "Disable auto-approve" : "Enable auto-approve"} />
                      </div>

                      {clients.length === 0 ? (
                        <p className="text-xs text-center py-3" style={{ color: "var(--text-muted)" }}>No clients yet</p>
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
                      </div>
                    </div>
                  </div>
                  </>
                )}

                {activeMenu === "logs" && (
                  <div className="flex-1 flex flex-col">
                    {logs.length > 0 && (
                      <div className="flex justify-end mb-2">
                        <button onClick={onClearLogs} title="Clear logs" className="glass-btn flex items-center gap-1.5 px-2.5 h-7 text-xs" style={{ color: "var(--text-muted)" }}>
                          <span className="material-symbols-outlined text-sm">delete_sweep</span> Clear
                        </button>
                      </div>
                    )}
                    {logs.length === 0 ? (
                      <p className="text-xs text-center mt-8" style={{ color: "var(--text-muted)" }}>No logs yet</p>
                    ) : (
                      <div ref={logEndRef} className="flex flex-col gap-0.5 overflow-y-auto max-h-[calc(100dvh-14rem)] pr-1">
                        {logs.map((line, i) => (
                          <p key={i} className="text-xs font-mono leading-5 break-all" style={{ color: "var(--text-muted)" }}>{line}</p>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {activeMenu === "system" && (
                  <div className="flex-1 flex flex-col">
                    <SystemPane />
                  </div>
                )}
          </div>
        </div>
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
              <button onClick={onDeviceReject} className="glass-btn flex-1 py-2 text-sm" style={{ color: "var(--text-muted)" }}>
                Reject
              </button>
              <button
                onClick={onDeviceApprove}
                className="flex-1 py-2 text-sm font-semibold rounded-xl"
                style={{ background: "var(--brand-500)", color: "#fff" }}
              >
                Approve
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
