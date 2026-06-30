import { useState, useRef, useEffect } from "preact/hooks";
import StepProgress from "../components/StepProgress";
import QRCard from "../components/QRCard";
import ConfirmPopup from "../components/ConfirmPopup";
import SessionList from "../components/SessionList";
import TerminalView from "../components/TerminalView";
import { useSessions } from "../lib/terminalSocket";
import { updateTitle } from "../lib/titleMarquee";
import { useI18n } from "../i18n";
import { SUPPORTED_LOCALES } from "../i18n/config";

const HELP_URL = "https://docs.9remote.cc/";

// Left menu — config-driven nav + per-menu header meta (9router pattern)
const MENU = [
  { id: "connection", label: "Connection", icon: "hub", desc: "Pair devices and manage your secure tunnel" },
  { id: "terminals", label: "Terminals", icon: "terminal", desc: "Live terminal sessions running on this host" },
  { id: "logs", label: "Logs", icon: "description", desc: "Server activity and diagnostics" },
];

const DEFAULT_MENU = "connection";
const TERMINALS_MENU = "terminals";

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

const PERMISSION_META = {
  screenRecording: { label: "Screen Recording", icon: "screenshot_monitor", desc: "Capture screen content" },
  accessibility:   { label: "Accessibility",    icon: "accessibility_new",  desc: "Control mouse & keyboard" },
};

/** Single permission row */
function PermissionRow({ type, granted, onRequest }) {
  const meta = PERMISSION_META[type] || { label: type, icon: "security", desc: "" };
  return (
    <div className="flex items-center gap-2 py-2">
      <span className={`material-symbols-outlined flex-shrink-0 ${granted ? "text-green-400" : ""}`} style={{ fontSize: 18, color: granted ? undefined : "var(--text-muted)" }}>
        {granted ? "check_circle" : "cancel"}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium" style={{ color: granted ? "var(--text-main)" : "var(--text-muted)" }}>{meta.label}</p>
        <p className="text-[10px] leading-4" style={{ color: "var(--text-muted)" }}>{meta.desc}</p>
      </div>
      {!granted && (
        <button
          onClick={() => onRequest(type)}
          title="Click to grant permission"
          className="flex-shrink-0 w-11 h-6 rounded-full transition-all relative"
          style={{ background: "var(--border)", cursor: "pointer" }}
        >
          <span className="absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all"
            style={{ left: "2px", boxShadow: "0 1px 3px rgba(0,0,0,0.3)" }} />
        </button>
      )}
    </div>
  );
}

const SLEEP_MODE_LABELS = {
  "30m":   "Off after 30 min idle",
  "1h":    "Off after 1 hour idle",
  "2h":    "Off after 2 hours idle",
  "4h":    "Off after 4 hours idle",
  "24h":   "Off after 24 hours idle",
  "never": "Never off",
};

/** Reusable dropdown row — for enum settings (mode picker etc.) */
function SelectRow({ icon, label, desc, value, options, onChange }) {
  return (
    <div className="flex items-center gap-3 py-2 border-b last:border-0" style={{ borderColor: "var(--border)" }}>
      <span className="material-symbols-outlined flex-shrink-0" style={{ fontSize: 18, color: "var(--brand-400)" }}>
        {icon}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium" style={{ color: "var(--text-main)" }}>{label}</p>
        <p className="text-[10px] leading-4" style={{ color: "var(--text-muted)" }}>{desc}</p>
      </div>
      <select
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        className="flex-shrink-0 text-xs px-2 py-1 rounded-lg"
        style={{ background: "var(--glass-bg)", color: "var(--text-main)", border: "1px solid var(--border)", cursor: "pointer" }}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </div>
  );
}

/** Reusable toggle row — DRY for any on/off boolean setting */
function ToggleRow({ icon, label, desc, value, onToggle, activeColor = "var(--brand-500)" }) {
  return (
    <div className="flex items-center gap-3 py-2 border-b last:border-0" style={{ borderColor: "var(--border)" }}>
      <span className="material-symbols-outlined flex-shrink-0" style={{ fontSize: 18, color: value ? "var(--brand-400)" : "var(--text-muted)" }}>
        {icon}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium" style={{ color: "var(--text-main)" }}>{label}</p>
        <p className="text-[10px] leading-4" style={{ color: "var(--text-muted)" }}>{desc}</p>
      </div>
      <button
        onClick={onToggle}
        className="flex-shrink-0 w-11 h-6 rounded-full transition-all relative"
        style={{ background: value ? activeColor : "var(--border)", cursor: "pointer" }}
      >
        <span className="absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all"
          style={{ left: value ? "calc(100% - 22px)" : "2px", boxShadow: "0 1px 3px rgba(0,0,0,0.3)" }} />
      </button>
    </div>
  );
}

/** Remote Services card — Terminal (always on) + Desktop (toggleable) */
function ServicesCard({ desktopEnabled, onDesktopToggle, permissions, onRequestPermission, autoStart, onAutoStartToggle, sleepInhibitMode, sleepInhibitPresets, onSleepInhibitChange }) {
  const permEntries = Object.entries(PERMISSION_META);
  // Desktop toggle requires all permissions granted
  const canEnableDesktop = permEntries.every(([type]) => !!permissions?.[type]);
  const toggleDisabled = !canEnableDesktop && !desktopEnabled;
  return (
    <div className="glass-card conn-card p-4 flex flex-col gap-3">
      {/* Desktop block: row + permissions cùng group */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{ background: desktopEnabled ? "rgba(var(--brand-rgb),0.15)" : "var(--glass-bg)" }}>
            <span className="material-symbols-outlined" style={{ fontSize: 20, color: desktopEnabled ? "var(--brand-400)" : "var(--text-muted)" }}>
              desktop_windows
            </span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold" style={{ color: "var(--text-main)" }}>Remote Desktop</p>
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>Control screen, mouse & keyboard</p>
          </div>
          {/* Toggle — disabled until all permissions granted */}
          <button
            onClick={toggleDisabled ? undefined : onDesktopToggle}
            disabled={toggleDisabled}
            title={toggleDisabled ? "Grant all permissions below to enable" : ""}
            className="flex-shrink-0 w-11 h-6 rounded-full transition-all relative"
            style={{ background: desktopEnabled ? "var(--brand-500)" : "var(--border)", opacity: toggleDisabled ? 0.5 : 1, cursor: toggleDisabled ? "not-allowed" : "pointer" }}
          >
            <span className="absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all"
              style={{ left: desktopEnabled ? "calc(100% - 22px)" : "2px", boxShadow: "0 1px 3px rgba(0,0,0,0.3)" }} />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2 pl-12">
          {permEntries.map(([type]) => (
            <PermissionRow
              key={type}
              type={type}
              granted={permissions?.[type] ?? false}
              onRequest={onRequestPermission}
            />
          ))}
        </div>
      </div>

      {/* Startup */}
      <div className="flex flex-col border-t pt-2" style={{ borderColor: "var(--border)" }}>
        <p className="text-[10px] uppercase tracking-wider mb-1" style={{ color: "var(--text-muted)" }}>Startup</p>
        <ToggleRow
          icon="power_settings_new"
          label="Launch on system startup"
          desc={autoStart ? "Runs in background when you log in" : "Disabled — start manually"}
          value={!!autoStart}
          onToggle={onAutoStartToggle}
        />
        <SelectRow
          icon="bedtime_off"
          label="Prevent sleep"
          desc="Block system sleep so the network stays alive"
          value={sleepInhibitMode || "never"}
          options={(sleepInhibitPresets || []).map((m) => ({ value: m, label: SLEEP_MODE_LABELS[m] || m }))}
          onChange={onSleepInhibitChange}
        />
      </div>
    </div>
  );
}

function UpdateBanner({ version }) {
  if (!version) return null;
  const handleUpdate = () => fetch("/api/update", { method: "POST" }).catch(() => {});
  return (
    <div className="px-5 py-2 flex items-center gap-2 border-b" style={{ background: "rgba(var(--brand-rgb),0.08)", borderColor: "rgba(var(--brand-rgb),0.2)" }}>
      <span className="material-symbols-outlined text-sm flex-shrink-0" style={{ color: "var(--brand-400)" }}>system_update</span>
      <span className="text-xs flex-1" style={{ color: "var(--brand-400)" }}>Version {version} available</span>
      <button
        onClick={handleUpdate}
        className="flex-shrink-0 text-xs px-2 py-0.5 rounded font-medium"
        style={{ background: "rgba(var(--brand-rgb),0.15)", color: "var(--brand-400)" }}
      >
        Update
      </button>
    </div>
  );
}

const FEATURES = [
  { icon: "terminal", label: "Terminal", desc: "Full shell access" },
  { icon: "desktop_windows", label: "Desktop", desc: "Remote screen control" },
  { icon: "folder_open", label: "Files", desc: "Browse & edit files" },
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

const STATUS_META = {
  online:  { color: "#4ade80", icon: "wifi",          title: "Online" },
  offline: { color: "var(--text-muted)", icon: "wifi_off",      title: "Offline" },
  pending: { color: "#f59e0b", icon: "hourglass_top", title: "Pending approval" },
};

function ClientItem({ client, onRemove, onApprove, onLabel }) {
  const shortId = `${client.deviceId.slice(0, 8)}...`;
  const name = client.label || shortId;
  const meta = STATUS_META[client.status] || STATUS_META.offline;
  const timeLabel =
    client.status === "online"
      ? `Connected · ${client.connectedAt ? new Date(client.connectedAt).toLocaleTimeString() : ""}`
      : client.status === "pending"
        ? `Pending · waiting for approval`
        : client.approvedAt
          ? `Offline · approved ${new Date(client.approvedAt).toLocaleDateString()}`
          : "Offline";
  const actionLabel = client.status === "online" ? "Disconnect" : "Remove";

  return (
    <div className="flex items-center gap-3 py-2 border-b last:border-0" style={{ borderColor: "var(--border)" }}>
      <span
        className="material-symbols-outlined flex-shrink-0"
        style={{ fontSize: 18, color: meta.color }}
        title={meta.title}
      >
        {meta.icon}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium truncate flex items-center gap-1" style={{ color: "var(--text-main)" }}>
          {name}{client.ip ? ` · ${client.ip}` : ""}
          {client.status !== "pending" && (
            <button
              onClick={() => onLabel?.(client)}
              className="material-symbols-outlined"
              style={{ fontSize: 14, color: "var(--text-muted)", cursor: "pointer" }}
              title="Rename this device"
            >
              edit
            </button>
          )}
        </p>
        <p className="text-[10px]" style={{ color: "var(--text-muted)" }}>{timeLabel}</p>
      </div>
      {client.status === "pending" && (
        <button
          onClick={() => onApprove?.(client)}
          className="flex-shrink-0 text-xs px-2 py-1 rounded-lg font-medium"
          style={{ background: "rgba(74,222,128,0.15)", color: "#4ade80" }}
          title="Approve this device"
        >
          Approve
        </button>
      )}
      <button
        onClick={() => onRemove(client)}
        className="flex-shrink-0 text-xs px-2 py-1 rounded-lg font-medium"
        style={{ background: "rgba(220,53,69,0.15)", color: "#dc3545" }}
        title="Disconnect and remove this device"
      >
        {actionLabel}
      </button>
    </div>
  );
}

const TUNNEL_HEALTH_META = {
  healthy:     { color: "#4ade80",          label: "Healthy",     dot: "bg-green-400" },
  unreachable: { color: "#dc3545",          label: "Offline",     dot: "bg-red-500" },
  unknown:     { color: "var(--text-muted)", label: "Checking...", dot: "bg-gray-400" },
};

/** Header icon-only button — uses native tooltip for clarity */
function HeaderIconBtn({ icon, title, danger, onClick }) {
  const btnClass = danger ? "btn-danger w-7 h-7 flex items-center justify-center" : "glass-btn w-7 h-7 flex items-center justify-center";
  return (
    <button onClick={onClick} title={title} className={btnClass} style={danger ? undefined : { color: "var(--text-muted)" }}>
      <span className="material-symbols-outlined text-sm">{icon}</span>
    </button>
  );
}

/** Connection empty-state shown in panel when tunnel offline — single Connect CTA */
function ConnectionEmpty({ onStart }) {
  const [connecting, setConnecting] = useState(false);
  const handleConnect = () => { setConnecting(true); onStart?.(); };
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-5 px-6 py-8 text-center max-w-md mx-auto w-full">
      <div className="w-16 h-16 rounded-2xl flex items-center justify-center" style={{ background: "var(--glass-bg)" }}>
        <span className="material-symbols-outlined" style={{ fontSize: 32, color: "var(--text-muted)" }}>cloud_off</span>
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-base font-semibold" style={{ color: "var(--text-main)" }}>Tunnel offline</p>
        <p className="text-xs leading-5" style={{ color: "var(--text-muted)" }}>Start the tunnel to get a QR code and connect your devices from anywhere.</p>
      </div>
      <button
        onClick={!connecting ? handleConnect : undefined}
        disabled={connecting}
        className="btn-primary w-full py-3 flex items-center justify-center gap-2 text-sm font-semibold"
        style={{ borderRadius: "var(--radius-brand)", opacity: connecting ? 0.7 : 1 }}
      >
        <span className="material-symbols-outlined text-base">play_arrow</span>
        {connecting ? "Connecting…" : "Connect"}
      </button>
      <div className="grid grid-cols-3 gap-2 w-full">
        {FEATURES.map((f) => (
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
function SettingsMenu({ isStopped, onStop, onShutdown }) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const ref = useRef(null);
  const curLocale = SUPPORTED_LOCALES.find((l) => l.code === locale) || SUPPORTED_LOCALES[0];

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const run = (fn) => { setOpen(false); fn?.(); };

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((v) => !v)} title={t("header.settings")} className="glass-btn w-7 h-7 flex items-center justify-center">
        <span className="material-symbols-outlined text-sm">settings</span>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 rounded-lg shadow-lg py-1 min-w-[200px]" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
          <button onClick={() => run(() => setLangOpen(true))} className="w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 card-act" style={{ color: "var(--text-main)" }}>
            <span className="material-symbols-outlined text-base">language</span>
            <span className="flex-1">{curLocale.flag} {curLocale.label}</span>
          </button>
          <MenuAction icon="menu_book" label={t("header.documentation")} onClick={() => run(() => window.open(HELP_URL, "_blank"))} />
          {!isStopped && <MenuAction icon="restart_alt" label={t("header.resetShort")} onClick={() => run(onStop)} />}
          <MenuAction icon="power_settings_new" label={t("header.shutdownShort")} danger onClick={() => run(onShutdown)} />
        </div>
      )}
      {langOpen && <LanguageModal onClose={() => setLangOpen(false)} />}
    </div>
  );
}

/** Language picker modal — grid of locales (mirrors web) */
function LanguageModal({ onClose }) {
  const { t, locale, setLocale } = useI18n();
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.6)" }} onClick={onClose}>
      <div className="glass-card p-5 flex flex-col gap-4 w-full max-w-lg max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold" style={{ color: "var(--text-main)" }}>{t("header.language")}</h3>
          <button onClick={onClose} className="material-symbols-outlined" style={{ fontSize: 20, color: "var(--text-muted)", cursor: "pointer" }}>close</button>
        </div>
        <div className="grid grid-cols-2 gap-2 overflow-y-auto">
          {SUPPORTED_LOCALES.map((l) => (
            <button
              key={l.code}
              onClick={() => { setLocale(l.code); onClose(); }}
              className="flex items-center gap-2 px-3 py-2 text-sm rounded-xl card-act"
              style={{ background: l.code === locale ? "rgba(var(--brand-rgb),0.15)" : "var(--glass-bg)", color: l.code === locale ? "var(--brand-400)" : "var(--text-main)" }}
            >
              <span>{l.flag}</span>
              <span className="flex-1 text-left truncate">{l.label}</span>
              {l.code === locale && <span className="material-symbols-outlined" style={{ fontSize: 16 }}>check</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Single dropdown action row */
function MenuAction({ icon, label, danger, onClick }) {
  return (
    <button onClick={onClick} className="w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 card-act" style={{ color: danger ? "#dc3545" : "var(--text-main)" }}>
      <span className="material-symbols-outlined text-base">{icon}</span> {label}
    </button>
  );
}

/** Primary left navigation — logo top, menu mid, controls bottom (9router pattern) */
function Sidebar({ activeMenu, onSelect, version, isReady, tunnelHealth, onClose }) {
  const { t } = useI18n();
  const handleSelect = (id) => { onSelect(id); onClose?.(); };
  return (
    <aside className="flex flex-col sidebar w-64 flex-shrink-0 h-full">
      {/* Brand */}
      <div className="flex items-center gap-3 px-5 py-4">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: "var(--brand-500)" }}>
          <span className="material-symbols-outlined text-white text-base">terminal</span>
        </div>
        <div className="flex flex-col leading-tight">
          <span className="brand-text text-xs">9Remote</span>
          {version && <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>v{version}</span>}
        </div>
      </div>

      {isReady && <div className="px-4 pb-3 flex justify-center"><TunnelHealthBadge tunnelHealth={tunnelHealth} /></div>}

      {/* Menu */}
      <nav className="flex-1 px-4 py-2 space-y-0.5 overflow-y-auto select-none">
        {MENU.map((m) => {
          const isActive = activeMenu === m.id;
          return (
            <button
              key={m.id}
              onClick={() => handleSelect(m.id)}
              className="group w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-all text-left"
              style={isActive
                ? { background: "var(--brand-tint)", color: "var(--brand-500)" }
                : { color: "var(--text-muted)" }}
            >
              <span className={`material-symbols-outlined text-[18px] ${isActive ? "fill-1" : ""}`}>{m.icon}</span>
              <span className="text-[13px] font-medium">{t(`menu.${m.id}`)}</span>
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
    <header className="shrink-0 flex items-center justify-between gap-3 px-6 lg:px-10 pt-4 pb-3 border-b" style={{ borderColor: "var(--border-subtle)" }}>
      <div className="flex items-center gap-2 min-w-0">
        <button onClick={onMenuClick} className="md:hidden glass-btn w-8 h-8 flex items-center justify-center flex-shrink-0" style={{ color: "var(--text-muted)" }} aria-label="Open menu">
          <span className="material-symbols-outlined text-lg">menu</span>
        </button>
        <span className="material-symbols-outlined text-xl" style={{ color: "var(--brand-500)" }}>{menu?.icon}</span>
        <div className="min-w-0">
          <h1 className="text-lg lg:text-xl font-semibold tracking-tight truncate" style={{ color: "var(--text-main)" }}>{menu ? t(`menu.${menu.id}`) : ""}</h1>
          {menu && <p className="hidden lg:block text-xs truncate" style={{ color: "var(--text-muted)" }}>{t(`menu.${menu.id}Desc`)}</p>}
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

function TunnelHealthBadge({ tunnelHealth }) {
  const meta = TUNNEL_HEALTH_META[tunnelHealth?.status] || TUNNEL_HEALTH_META.unknown;
  const time = tunnelHealth?.checkedAt ? new Date(tunnelHealth.checkedAt).toLocaleTimeString() : "--:--:--";
  return (
    <div
      className="inline-flex items-center justify-center gap-1.5 px-3 h-7 rounded-full glass-btn"
      title={`Tunnel ${meta.label} · last check ${time}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
      <span className="text-[11px] font-medium" style={{ color: meta.color }}>{meta.label}</span>
    </div>
  );
}

export default function MainScreen({
  step, stepDesc = "", healthCheck, tunnelHealth, tunnelUrl, oneTimeKey, oneTimeKeyExpiresAt, permanentKey, qrUrl,
  permissions, desktopEnabled, updateVersion, connections = [], version = "",
  onRequestPermission, onDesktopToggle, onStop, onStart, onShutdown, onGenerateOneTimeKey, onRegenerateKey, logs = [], onClearLogs,
  theme, onToggleTheme,
  pendingDevice, onDeviceApprove, onDeviceReject,
  approvedDevices = [], rejectedDevices = [], onDeviceRemove, onFetchDevices, onDeviceApproveRejected, onDeviceLabel,
  autoApprove = false, onAutoApproveToggle,
  autoStart = false, onAutoStartToggle,
  sleepInhibitMode = "never", sleepInhibitPresets = [], onSleepInhibitChange,
  sessions = [], onSessionDelete, onSessionRefresh,
}) {
  const [activeMenu, setActiveMenu] = useState(() => parsePath().menu);
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
  const [showShutdownConfirm, setShowShutdownConfirm] = useState(false);
  const [deviceToRemove, setDeviceToRemove] = useState(null);
  const [deviceToLabel, setDeviceToLabel] = useState(null);
  const [labelInput, setLabelInput] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [openedIds, setOpenedIds] = useState([]);
  const logEndRef = useRef(null);
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

  // Clear finished badge for the terminal currently being viewed (active pane never shows it)
  useEffect(() => { if (activeSessionId) term.clearFinished(activeSessionId); }, [activeSessionId, term.finishedIds]);

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
    if (activeMenu === "logs") logEndRef.current?.scrollIntoView({ behavior: "smooth" });
    if (activeMenu === "connection") onFetchDevices?.();
    if (activeMenu === "terminals") term.refresh();
  }, [logs, activeMenu, connections.length]);

  const clients = mergeClients(approvedDevices, connections, rejectedDevices);
  const onlineCount = clients.filter((c) => c.status === "online").length;

  const currentMenu = MENU.find((m) => m.id === activeMenu);

  return (
    <div className="h-full w-full flex overflow-hidden" style={{ background: "var(--bg-body)" }}>
      {/* Sidebar — desktop */}
      <div className="hidden md:flex">
        <Sidebar
          activeMenu={activeMenu}
          onSelect={navigateMenu}
          version={version}
          isReady={isReady}
          tunnelHealth={tunnelHealth}
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
          onClose={() => setSidebarOpen(false)}
        />
      </div>

      {/* Main — header + scrollable content (9router pattern) */}
      <main className="flex-1 flex flex-col min-w-0 h-full relative dot-grid-bg isolate">
        {/* Faint grid background overlay */}
        <div className="landing-grid absolute inset-0 pointer-events-none -z-10" aria-hidden="true" />
        <PageHeader
          menu={currentMenu}
          isStopped={isStopped}
          theme={theme}
          onToggleTheme={onToggleTheme}
          onStop={() => setShowDisconnectConfirm(true)}
          onShutdown={() => setShowShutdownConfirm(true)}
          onMenuClick={() => setSidebarOpen(true)}
        />
        <UpdateBanner version={updateVersion} />
        <div className="flex-1 overflow-y-auto p-6 lg:p-10">
          <div className="max-w-7xl mx-auto flex flex-col gap-4">
              {activeMenu === "connection" && isStopped && (
                <ConnectionEmpty onStart={onStart} />
              )}

              {activeMenu === "connection" && isConnecting && (
                <div className="flex-1 flex flex-col gap-4 max-w-2xl mx-auto w-full">
                  <StepProgress currentStep={step} activeDesc={stepDesc} healthCheck={healthCheck} />
                </div>
              )}

              {activeMenu === "connection" && isReady && (
                <>
                  {/* QR sticky (1/3) left + Config & Clients (2/3) right */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-stretch">
                    <div className="md:col-span-1">
                      <QRCard
                        qrUrl={qrUrl}
                        oneTimeKey={oneTimeKey}
                        oneTimeKeyExpiresAt={oneTimeKeyExpiresAt}
                        permanentKey={permanentKey}
                        tunnelUrl={tunnelUrl}
                        onGenerateOneTimeKey={onGenerateOneTimeKey}
                        onRegenerateKey={onRegenerateKey}
                      />
                    </div>
                    <div className="md:col-span-2 flex flex-col gap-4">
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
                      />

                      {/* Clients (merged devices + live connections) */}
                      <div className="glass-card conn-card p-4 flex flex-col gap-1">
                      <p className="text-xs font-medium uppercase tracking-wider mb-2" style={{ color: "var(--text-muted)" }}>
                        Clients{clients.length > 0 ? ` (${onlineCount}/${clients.length} online)` : ""}
                      </p>

                      {/* Auto-approve toggle */}
                      <div className="flex items-center gap-3 py-2 border-b" style={{ borderColor: "var(--border)" }}>
                        <span className="material-symbols-outlined flex-shrink-0" style={{ fontSize: 18, color: autoApprove ? "var(--brand-400)" : "var(--text-muted)" }}>
                          {autoApprove ? "lock_open" : "lock"}
                        </span>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium" style={{ color: "var(--text-main)" }}>Auto-approve new devices</p>
                          <p className="text-[10px] leading-4" style={{ color: "var(--text-muted)" }}>
                            {autoApprove ? "Any new device connects without approval" : "Require manual approval for new devices"}
                          </p>
                        </div>
                        <button
                          onClick={onAutoApproveToggle}
                          title={autoApprove ? "Disable auto-approve" : "Enable auto-approve"}
                          className="flex-shrink-0 w-11 h-6 rounded-full transition-all relative"
                          style={{ background: autoApprove ? "var(--brand-500)" : "var(--border)", cursor: "pointer" }}
                        >
                          <span className="absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all"
                            style={{ left: autoApprove ? "calc(100% - 22px)" : "2px", boxShadow: "0 1px 3px rgba(0,0,0,0.3)" }} />
                        </button>
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
                      <div className="flex justify-end mb-2 sticky top-0 z-10">
                        <button onClick={onClearLogs} title="Clear logs" className="glass-btn flex items-center gap-1.5 px-2.5 h-7 text-xs" style={{ color: "var(--text-muted)" }}>
                          <span className="material-symbols-outlined text-sm">delete_sweep</span> Clear
                        </button>
                      </div>
                    )}
                    {logs.length === 0 ? (
                      <p className="text-xs text-center mt-8" style={{ color: "var(--text-muted)" }}>No logs yet</p>
                    ) : (
                      <div className="flex flex-col gap-0.5">
                        {logs.map((line, i) => (
                          <p key={i} className="text-xs font-mono leading-5 break-all" style={{ color: "var(--text-muted)" }}>{line}</p>
                        ))}
                        <div ref={logEndRef} />
                      </div>
                    )}
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
          <div className="glass-card p-5 flex flex-col gap-4 w-80">
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
          groups={term.groups}
          finishedIds={term.finishedIds}
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
        />
      )}
    </div>
  );
}
