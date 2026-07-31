import { useState, useRef, useEffect } from "preact/hooks";
import StepProgress from "../components/StepProgress";
import QRCard from "../components/QRCard";
import ConfirmPopup from "../components/ConfirmPopup";
import SessionList from "../components/SessionList";
import TerminalView from "../components/TerminalView";
import SettingsMenu from "../components/SettingsMenu";
import SystemPane from "../components/SystemPane";
import { useSessions } from "../lib/terminalSocket";
import { updateTitle } from "../lib/titleMarquee";
import { useI18n } from "../i18n";
import { UPDATE_UI } from "../lib/constants";
import { usePersistedState } from "../lib/usePersistedState";

// Left menu — config-driven nav + per-menu header meta (9router pattern)
const MENU = [
  { id: "connection", label: "Connection", icon: "hub", desc: "Pair devices and manage your secure tunnel" },
  { id: "terminals", label: "Terminals", icon: "terminal", desc: "Live terminal sessions running on this host" },
  { id: "logs", label: "Logs", icon: "description", desc: "Server activity and diagnostics" },
];

const DEFAULT_MENU = "connection";
const TERMINALS_MENU = "terminals";

// Recent activity — AI tool → brand logo svg (public/agents/). type "stop"=replied, else needs input
const AGENT_ICON = { claude: "/agents/claude.svg", codex: "/agents/codex.svg", gemini: "/agents/gemini.svg", opencode: "/agents/opencode.svg" };
const RECENT_LIMIT = 6;

// Compact relative time (e.g. "now", "3m", "2h", "1d")
const timeAgo = (ts) => {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

// Parse URL pathname → { menu, sessionId } (sessionId only under /terminals/:id)
const parsePath = () => {
  const [seg, sub] = window.location.pathname.replace(/^\/+/, "").split("/");
  const menu = MENU.some((m) => m.id === seg) ? seg : DEFAULT_MENU;
  const sessionId = menu === TERMINALS_MENU && sub ? decodeURIComponent(sub) : null;
  return { menu, sessionId };
};

// Build pathname from current menu + open terminal
const buildPath = (menu, sessionId) =>
  menu === TERMINALS_MENU && sessionId ? `/${menu}/${encodeURIComponent(sessionId)}` : `/${menu}`;

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
      ? `${client.ip ? client.ip + " · " : ""}connected ${client.connectedAt ? new Date(client.connectedAt).toLocaleTimeString() : ""}`
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

const TUNNEL_HEALTH_META = {
  healthy:     { color: "var(--success)",    label: "Tunnel healthy",  dot: "var(--success)" },
  unreachable: { color: "var(--danger)",     label: "Tunnel offline",  dot: "var(--danger)" },
  unknown:     { color: "var(--text-muted)", label: "Checking tunnel", dot: "var(--text-muted)" },
};

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
    <div className="flex-1 flex flex-col items-center justify-center gap-5 px-6 py-8 text-center max-w-md mx-auto w-full">
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

/** Language switcher — globe button + dropdown (header global action) */
/** Recent agent activity — sessions whose AI just finished/needs input (bottom of sidebar) */
function RecentActivity({ notifications, sessions, onSelect, onDismiss, t }) {
  const items = Object.values(notifications || {})
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, RECENT_LIMIT);
  const nameOf = (id) => sessions.find((s) => s.id === id)?.name || id.slice(0, 8);
  return (
    <div className="flex flex-col min-h-0 flex-shrink px-4 py-3 border-t select-none" style={{ borderColor: "var(--border-subtle)" }}>
      <p className="text-[10px] font-semibold uppercase tracking-wide px-1 mb-1.5 flex-shrink-0" style={{ color: "var(--text-muted)" }}>{t("recent.title")}</p>
      {!items.length ? (
        <p className="text-[11px] px-1 py-2" style={{ color: "var(--text-muted)" }}>{t("recent.empty")}</p>
      ) : (
      <div className="flex flex-col gap-0.5 min-h-0 overflow-y-auto">
        {items.map((n) => (
          <div
            key={n.sessionId}
            onClick={() => onSelect(n.sessionId)}
            className="group w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg transition-all text-left cursor-pointer"
            style={{ color: "var(--text-muted)" }}
            title={nameOf(n.sessionId)}
          >
            {AGENT_ICON[n.tool] ? (
              <img src={AGENT_ICON[n.tool]} alt={n.tool} className="w-4 h-4 flex-shrink-0" />
            ) : (
              <span className="material-symbols-outlined text-[16px] flex-shrink-0" style={{ color: "var(--brand-400)" }}>smart_toy</span>
            )}
            <span className="flex-1 min-w-0">
              <span className="block text-[12px] font-medium truncate" style={{ color: "var(--text-main)" }}>{nameOf(n.sessionId)}</span>
              <span className="block text-[10px] truncate">{n.type === "stop" ? t("recent.replied") : t("recent.needsInput")}</span>
            </span>
            <span className="text-[10px] flex-shrink-0 group-hover:hidden">{timeAgo(n.timestamp)}</span>
            <button
              onClick={(e) => { e.stopPropagation(); onDismiss(n.sessionId); }}
              title={t("recent.dismiss")}
              className="material-symbols-outlined text-[16px] flex-shrink-0 hidden group-hover:block"
              style={{ color: "var(--text-muted)" }}
            >
              close
            </button>
          </div>
        ))}
      </div>
      )}
    </div>
  );
}

/** Primary left navigation — logo top, menu mid, controls bottom (9router pattern) */
function Sidebar({ activeMenu, onSelect, version, isReady, tunnelHealth, onResetTunnel, onClose, notifications, sessions = [], onSelectSession, onDismissRecent }) {
  const { t } = useI18n();
  const handleSelect = (id) => { onSelect(id); onClose?.(); };
  const handleSelectSession = (id) => { onSelectSession?.(id); onClose?.(); };
  return (
    <aside className="flex flex-col sidebar w-[264px] flex-shrink-0 h-full">
      {/* Brand */}
      <div className="flex items-center gap-3 px-5 py-5">
        <img src="/favicon.svg" alt="9Remote" className="w-10 h-10 rounded-xl flex-shrink-0" />
        <div className="flex flex-col leading-tight">
          <span className="brand-text text-xs">9Remote</span>
          {version && <span className="text-[10px] mt-0.5" style={{ color: "var(--text-muted)" }}>v{version}</span>}
        </div>
      </div>

      {isReady && <div className="px-4 pb-3"><TunnelHealthBadge tunnelHealth={tunnelHealth} onResetTunnel={onResetTunnel} /></div>}

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

      <RecentActivity notifications={notifications} sessions={sessions} onSelect={handleSelectSession} onDismiss={onDismissRecent} t={t} />
    </aside>
  );
}

/** Content header — per-menu title/icon/desc + global actions (9router pattern) */
function PageHeader({ menu, isStopped, theme, onToggleTheme, onStop, onShutdown, onMenuClick, terminalFont, setTerminalFont, terminalTheme, setTerminalTheme, webglEnabled, setWebglEnabled, showFolderButton, setShowFolderButton, showGitButton, setShowGitButton, showNoteButton, setShowNoteButton }) {
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
        <SettingsMenu
          isStopped={isStopped}
          onStop={onStop}
          onShutdown={onShutdown}
          theme={theme}
          terminalFont={terminalFont}
          setTerminalFont={setTerminalFont}
          terminalThemeKey={terminalTheme}
          setTerminalTheme={setTerminalTheme}
          webglEnabled={webglEnabled}
          setWebglEnabled={setWebglEnabled}
          showFolderButton={showFolderButton}
          setShowFolderButton={setShowFolderButton}
          showGitButton={showGitButton}
          setShowGitButton={setShowGitButton}
          showNoteButton={showNoteButton}
          setShowNoteButton={setShowNoteButton}
        />
      </div>
    </header>
  );
}

function TunnelHealthBadge({ tunnelHealth, onResetTunnel }) {
  const meta = TUNNEL_HEALTH_META[tunnelHealth?.status] || TUNNEL_HEALTH_META.unknown;
  const time = tunnelHealth?.checkedAt ? new Date(tunnelHealth.checkedAt).toLocaleTimeString() : "--:--:--";
  const isHealthy = tunnelHealth?.status === "healthy";
  return (
    <button
      onClick={onResetTunnel}
      className="w-full flex items-center gap-2 px-3 py-2.5 rounded-xl card-act"
      style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}
      title={`${meta.label} · last check ${time}`}
    >
      <span className={`w-2 h-2 rounded-full ${isHealthy ? "health-dot" : ""}`} style={{ background: meta.dot }} />
      <span className="text-[12.5px] font-medium" style={{ color: "var(--text-main)" }}>{meta.label}</span>
      <span className="ml-auto text-[11px] font-mono" style={{ color: "var(--text-muted)" }}>{time}</span>
    </button>
  );
}

export default function MainScreen({
  step, stepDesc = "", healthCheck, tunnelHealth, tunnelUrl, oneTimeKey, oneTimeKeyExpiresAt, permanentKey, qrUrl,
  permissions, desktopEnabled, updateVersion, connections = [], version = "",
  onRequestPermission, onDesktopToggle, onStop, onStart, onShutdown, onGenerateOneTimeKey,   onRegenerateKey, logs = [], onClearLogs,
  theme, onToggleTheme,
  pendingDevice, onDeviceApprove, onDeviceReject,
  approvedDevices = [], rejectedDevices = [], onDeviceRemove, onFetchDevices, onDeviceApproveRejected, onDeviceLabel,
  autoApprove = false, onAutoApproveToggle,
  autoStart = false, onAutoStartToggle,
  sleepInhibitMode = "never", sleepInhibitPresets = [], onSleepInhibitChange,
  unlockStatus = null, onRequestUnlockInstall, onRequestUnlockUninstall,
  sessions = [], onSessionDelete, onSessionRefresh,
  onStopTunnel,
}) {
  const { t } = useI18n();
  const [activeMenu, setActiveMenu] = useState(() => parsePath().menu);
  // Terminal appearance prefs — shared with web's terminalStore keys for parity.
  const [terminalFont, setTerminalFont] = usePersistedState("term.fontSize", null);
  const [terminalTheme, setTerminalTheme] = usePersistedState("term.theme", "default");
  const [webglEnabled, setWebglEnabled] = usePersistedState("term.webgl", true);
  const [showFolderButton, setShowFolderButton] = usePersistedState("term.showFolder", true);
  const [showGitButton, setShowGitButton] = usePersistedState("term.showGit", true);
  const [showNoteButton, setShowNoteButton] = usePersistedState("term.showNote", true);
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
  const [showShutdownConfirm, setShowShutdownConfirm] = useState(false);
  const [deviceToRemove, setDeviceToRemove] = useState(null);
  const [deviceToLabel, setDeviceToLabel] = useState(null);
  const [labelInput, setLabelInput] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [openedIds, setOpenedIds] = useState([]);
  const logEndRef = useRef(null);
  const scrollRef = useRef(null);
  const term = useSessions();

  // Navigate menu → leaving terminals also closes any open terminal
  const navigateMenu = (id) => {
    setActiveMenu(id);
    if (id !== TERMINALS_MENU) setActiveSessionId(null);
  };

  // Sync state with browser back/forward
  useEffect(() => {
    const onPop = () => {
      const { menu, sessionId } = parsePath();
      setActiveMenu(menu);
      setActiveSessionId(sessionId);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Single source of truth: push URL whenever menu / open terminal changes.
  // Gate the very first run so a deep-linked :id isn't wiped before reopen kicks in;
  // once unlocked, closing a terminal correctly drops the :id from the URL.
  const routeReadyRef = useRef(false);
  useEffect(() => {
    if (!routeReadyRef.current) {
      if (!activeSessionId && parsePath().sessionId) return; // wait for reopen
      routeReadyRef.current = true;
    }
    const next = buildPath(activeMenu, activeSessionId);
    if (window.location.pathname !== next) window.history.pushState(null, "", next);
  }, [activeMenu, activeSessionId]);

  // Clear badge only when SWITCHING into a terminal (B); a badge arriving while already focused stays until input (A)
  useEffect(() => { if (activeSessionId) term.clearFinished(activeSessionId); }, [activeSessionId]);

  // Reflect unseen finished-terminal count in document title (marquee)
  useEffect(() => { updateTitle(term.finishedIds.size); return () => updateTitle(0); }, [term.finishedIds]);

  // Open a session → also open all sessions in its group as split panes (web parity)
  const openSession = (sessionId) => {
    const sel = term.sessions.find((s) => s.id === sessionId);
    const gid = sel?.groupId || null;
    const groupIds = term.sessions.filter((s) => (s.groupId || null) === gid).map((s) => s.id);
    setOpenedIds((prev) => Array.from(new Set([...prev, ...groupIds, sessionId])));
    setActiveSessionId(sessionId);
  };

  // Reopen terminal from deep-link URL once its session has loaded.
  // If the id no longer exists after sessions load, drop it from the URL.
  useEffect(() => {
    const { menu, sessionId } = parsePath();
    if (!sessionId || activeSessionId) return;
    if (term.sessions.some((s) => s.id === sessionId)) openSession(sessionId);
    else if (term.sessions.length) window.history.replaceState(null, "", `/${menu}`);
  }, [term.sessions]);

  // Prune opened list to existing sessions (don't touch activeSessionId — avoids race on create)
  useEffect(() => {
    const ids = term.sessions.map((s) => s.id);
    setOpenedIds((prev) => prev.filter((id) => ids.includes(id)));
  }, [term.sessions]);

  // Close overlay only when the active session is actually closed (sessionClosed event)
  useEffect(() => {
    const onClosed = (id) => { if (id === activeSessionId) setActiveSessionId(null); };
    term.socket.on("sessionClosed", onClosed);
    return () => term.socket.off("sessionClosed", onClosed);
  }, [activeSessionId, term.socket]);
  // STEP enum: STOPPED=0, PREPARING=1, CONNECTING=2, TUNNELING=3, VERIFYING=4, READY=5
  const isReady = step === 5;
  const isStopped = step === 0;
  const isConnecting = step > 0 && step < 5;

  // Refresh devices list whenever tab active or state updates (so offline/online stays in sync)
  useEffect(() => {
    // Scroll the logs list itself (bounded height, internal scroll) to bottom
    if (activeMenu === "logs" && logEndRef.current) logEndRef.current.scrollTop = logEndRef.current.scrollHeight;
    if (activeMenu === "connection") onFetchDevices?.();
    if (activeMenu === "terminals") term.refresh();
  }, [logs, activeMenu, connections.length]);

  // Retry fetching sessions once after 1s if still empty in terminals view
  // (guards against rare race where terminal:ready reply arrives too late)
  useEffect(() => {
    if (activeMenu !== "terminals") return;
    if (term.sessions.length || term.groups.length) return;
    const timer = setTimeout(() => term.refresh(), 1000);
    return () => clearTimeout(timer);
  }, [activeMenu, term.sessions.length, term.groups.length]);

  const clients = mergeClients(approvedDevices, connections, rejectedDevices);
  const onlineCount = clients.filter((c) => c.status === "online").length;

  const currentMenu = MENU.find((m) => m.id === activeMenu);

  // Recent activity click → jump to terminals, open that session, clear its badge
  const openRecent = (sessionId) => { navigateMenu(TERMINALS_MENU); term.clearFinished(sessionId); openSession(sessionId); };

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
          tunnelHealth={tunnelHealth}
          onResetTunnel={() => setShowDisconnectConfirm(true)}
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
          tunnelHealth={tunnelHealth}
          onResetTunnel={() => setShowDisconnectConfirm(true)}
          onClose={() => setSidebarOpen(false)}
          notifications={term.notifications}
          sessions={term.sessions}
          onSelectSession={openRecent}
          onDismissRecent={term.dismissRecent}
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
          terminalFont={terminalFont}
          setTerminalFont={setTerminalFont}
          terminalTheme={terminalTheme}
          setTerminalTheme={setTerminalTheme}
          webglEnabled={webglEnabled}
          setWebglEnabled={setWebglEnabled}
          showFolderButton={showFolderButton}
          setShowFolderButton={setShowFolderButton}
          showGitButton={showGitButton}
          setShowGitButton={setShowGitButton}
          showNoteButton={showNoteButton}
          setShowNoteButton={setShowNoteButton}
        />
        {!isConnecting && <UpdateBanner version={updateVersion} />}
        <div className="px-6 lg:px-10 pb-6 lg:pb-10 pt-5">
          <div className="max-w-7xl mx-auto flex flex-col gap-4">
              {activeMenu === "connection" && isStopped && (
                <ConnectionEmpty onStart={onStart} t={t} />
              )}

              {activeMenu === "connection" && isConnecting && (
                <div className="flex-1 flex flex-col gap-4 max-w-2xl mx-auto w-full">
                  <StepProgress currentStep={step} activeDesc={stepDesc} healthCheck={healthCheck} t={t} />
                </div>
              )}

              {activeMenu === "connection" && isReady && (
                <>
                  {/* QR (1fr) left + Config & Clients (1.7fr) right — pro5 ratio */}
                  <div className="grid grid-cols-1 md:grid-cols-[1fr_1.7fr] gap-4 items-stretch">
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

                {activeMenu === "terminals" && (
                  <SessionList
                    sessions={term.sessions}
                    groups={term.groups}
                    connected={term.connected}
                    finishedIds={term.finishedIds}
                    sessionStatus={term.sessionStatus}
                    onSelect={(s) => { term.clearFinished(s.id); openSession(s.id); }}
                    onCreate={(groupId) => term.createSession(groupId)}
                    onCreateNamed={(groupId, name) => term.createSession(groupId, undefined, name)}
                    onDelete={(id) => term.deleteSession(id)}
                    onRename={(id, name) => term.renameSession(id, name)}
                    onCreateGroup={(name, cb) => term.createGroup(name, cb)}
                    onRenameGroup={(id, name) => term.renameGroup(id, name)}
                    onDeleteGroup={(id) => term.deleteGroup(id)}
                  />
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

      {/* Full-screen terminal overlay (mirrors web) */}
      {activeSessionId && (
        <TerminalView
          socket={term.socket}
          sessions={term.sessions}
          openedIds={openedIds}
          activeId={activeSessionId}
          connected={term.connected}
          theme={theme}
          terminalFont={terminalFont}
          terminalThemeKey={terminalTheme}
          showFolderButton={showFolderButton}
          showGitButton={showGitButton}
          showNoteButton={showNoteButton}
          groups={term.groups}
          finishedIds={term.finishedIds}
          sessionStatus={term.sessionStatus}
          clearFinished={term.clearFinished}
          updateCwd={term.updateCwd}
          onSwitch={(id) => { term.clearFinished(id); setActiveSessionId(id); }}
          onSelectGroup={(gid) => {
            const groupIds = term.sessions.filter((s) => (s.groupId || null) === gid).map((s) => s.id);
            setOpenedIds((prev) => Array.from(new Set([...prev, ...groupIds])));
            if (groupIds[0]) setActiveSessionId(groupIds[0]);
          }}
          onCreate={(groupId) => term.createSession(groupId, (r) => {
            if (r?.success && r.sessionId) {
              setOpenedIds((prev) => Array.from(new Set([...prev, r.sessionId])));
              setActiveSessionId(r.sessionId);
            }
          })}
          onCreateNamed={(groupId, name) => term.createSession(groupId, (r) => {
            if (r?.success && r.sessionId) {
              setOpenedIds((prev) => Array.from(new Set([...prev, r.sessionId])));
              setActiveSessionId(r.sessionId);
            }
          }, name)}
          onRename={(id, name) => term.renameSession(id, name)}
          onDelete={(id) => term.deleteSession(id)}
          onBack={() => setActiveSessionId(null)}
          onStop={() => setShowDisconnectConfirm(true)}
          onShutdown={() => setShowShutdownConfirm(true)}
          webglEnabled={webglEnabled}
          onSetWebgl={setWebglEnabled}
          onSetShowFolder={setShowFolderButton}
          onSetShowGit={setShowGitButton}
          onSetShowNote={setShowNoteButton}
          onSetTerminalFont={setTerminalFont}
          onSetTerminalTheme={setTerminalTheme}
        />
      )}
    </div>
  );
}
