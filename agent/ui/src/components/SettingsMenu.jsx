import { useState, useEffect, useRef } from "preact/hooks";
import { createPortal } from "preact/compat";
import { useI18n } from "../i18n";
import { SUPPORTED_LOCALES } from "../i18n/config";

const HELP_URL = "https://docs.9remote.cc/";

/** Reusable toggle inside settings */
function Toggle({ on, onClick, disabled, title }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      title={title}
      disabled={disabled}
      onClick={disabled ? undefined : onClick}
      className="relative flex-shrink-0 transition-opacity"
      style={{
        width: 36,
        height: 20,
        borderRadius: 10,
        background: on ? "linear-gradient(135deg, var(--brand-500), var(--brand-400))" : "var(--surface-3)",
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      <span
        className="block bg-white rounded-full transition-transform duration-200"
        style={{
          width: 14,
          height: 14,
          margin: 3,
          transform: on ? "translateX(16px)" : "translateX(0)",
          boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
        }}
      />
    </button>
  );
}

/** Flat setting row */
function SettingRow({ icon, title, desc, children }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3 border-b" style={{ borderColor: "var(--border-subtle)" }}>
      <div className="flex items-start gap-3 min-w-0">
        {icon && (
          <span className="material-symbols-outlined flex-shrink-0 mt-0.5" style={{ fontSize: 20, color: "var(--text-muted)" }}>
            {icon}
          </span>
        )}
        <div className="min-w-0">
          <p className="text-[13.5px] font-semibold" style={{ color: "var(--text-main)" }}>{title}</p>
          {desc && <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>{desc}</p>}
        </div>
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

export default function SettingsMenu({
  variant = "glass",
  theme,
  onToggleTheme,
  isStopped,
  onStop,
  onShutdown,
  logs = [],
  onClearLogs,
  autoStart,
  onAutoStartToggle,
  sleepInhibitMode,
  sleepInhibitPresets = [],
  onSleepInhibitChange,
  unlockStatus,
  onRequestUnlockInstall,
  onRequestUnlockUninstall,
  version = "",
}) {
  const { t, locale, setLocale } = useI18n();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState("general"); // "general" | "system" | "maintenance"
  const logEndRef = useRef(null);

  useEffect(() => {
    if (tab === "maintenance" && logEndRef.current) {
      logEndRef.current.scrollTop = logEndRef.current.scrollHeight;
    }
  }, [logs, tab]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const triggerClass = variant === "glass"
    ? "glass-btn w-10 h-10 rounded-xl flex items-center justify-center"
    : variant === "hdr"
      ? "hdr-icon w-10 h-10 rounded-[9px] flex items-center justify-center"
      : "p-1.5 rounded-lg transition-all duration-150 ease-out active:scale-[0.94] flex-shrink-0 term-btn";
  const triggerStyle = variant === "glass" ? undefined : { background: "var(--surface-2)", color: "var(--text-main)" };

  const curLocale = SUPPORTED_LOCALES.find((l) => l.code === locale) || SUPPORTED_LOCALES[0];

  const sleepLabels = {
    "30m": t("remote.sleepModes.30m"),
    "1h": t("remote.sleepModes.1h"),
    "2h": t("remote.sleepModes.2h"),
    "4h": t("remote.sleepModes.4h"),
    "24h": t("remote.sleepModes.24h"),
    never: t("remote.sleepModes.never"),
  };

  const navItems = [
    { id: "general", label: t("menu.general") || "General", icon: "tune" },
    { id: "system", label: t("menu.system") || "System", icon: "settings_suggest" },
    { id: "maintenance", label: t("menu.maintenance") || "Maintenance", icon: "build" },
  ];

  const modalContent = open && (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-[4px] animate-in fade-in duration-150"
      onClick={() => setOpen(false)}
    >
      <div
        className="glass-card flex overflow-hidden w-full max-w-2xl h-[540px] max-h-[90vh] rounded-2xl animate-in zoom-in-95 duration-150 shadow-2xl"
        style={{ border: "1px solid var(--border)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Left Nav */}
        <div
          className="w-48 flex-shrink-0 flex flex-col p-3 border-r"
          style={{ background: "var(--row-bg)", borderColor: "var(--border-subtle)" }}
        >
          <div className="flex items-center gap-2 px-2 py-3 mb-2">
            <span className="material-symbols-outlined" style={{ fontSize: 20, color: "var(--brand-500)" }}>settings</span>
            <span className="text-sm font-bold" style={{ color: "var(--text-main)" }}>9Remote</span>
          </div>

          <div className="flex-1 flex flex-col gap-1">
            {navItems.map((item) => {
              const active = tab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setTab(item.id)}
                  className="w-full text-left px-3 py-2 rounded-xl text-xs font-medium flex items-center gap-2.5 transition-colors"
                  style={{
                    background: active ? "rgba(var(--brand-rgb), 0.15)" : "transparent",
                    color: active ? "var(--brand-400)" : "var(--text-muted)",
                  }}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 18 }}>{item.icon}</span>
                  <span className="flex-1 truncate">{item.label}</span>
                </button>
              );
            })}
          </div>

          {version && (
            <div className="px-2 pt-2 border-t text-[11px] font-mono" style={{ borderColor: "var(--border-subtle)", color: "var(--text-subtle)" }}>
              v{version}
            </div>
          )}
        </div>

        {/* Right Content */}
        <div className="flex-1 flex flex-col min-w-0 bg-surface">
          {/* Header */}
          <div className="h-12 px-6 flex items-center justify-between border-b flex-shrink-0" style={{ borderColor: "var(--border-subtle)" }}>
            <h3 className="text-sm font-semibold capitalize" style={{ color: "var(--text-main)" }}>
              {navItems.find((n) => n.id === tab)?.label}
            </h3>
            <button
              onClick={() => setOpen(false)}
              className="p-1 rounded-lg text-text-muted hover:text-text hover:bg-surface-2 transition-colors material-symbols-outlined"
              style={{ fontSize: 20, color: "var(--text-muted)" }}
              title={t("common.close")}
            >
              close
            </button>
          </div>

          {/* Scrollable Body */}
          <div className="flex-1 overflow-y-auto p-6">
            {/* TAB: GENERAL */}
            {tab === "general" && (
              <div className="flex flex-col gap-2">
                {/* Theme */}
                <SettingRow
                  icon={theme === "dark" ? "dark_mode" : "light_mode"}
                  title={theme === "dark" ? t("header.darkMode") : t("header.lightMode")}
                  desc="Theme preference synced with workspace"
                >
                  <button
                    onClick={onToggleTheme}
                    className="glass-btn flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium"
                    style={{ color: "var(--text-main)" }}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
                      {theme === "dark" ? "light_mode" : "dark_mode"}
                    </span>
                    <span>{theme === "dark" ? "Light" : "Dark"}</span>
                  </button>
                </SettingRow>

                {/* Language Picker */}
                <div className="py-3">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-[13.5px] font-semibold" style={{ color: "var(--text-main)" }}>
                      {t("header.language")}
                    </span>
                    <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                      {curLocale.label}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 max-h-56 overflow-y-auto pr-1">
                    {SUPPORTED_LOCALES.map((l) => {
                      const active = l.code === locale;
                      return (
                        <button
                          key={l.code}
                          onClick={() => setLocale(l.code)}
                          className="flex items-center gap-2 px-3 py-2 rounded-xl text-xs text-left transition-colors"
                          style={{
                            background: active ? "rgba(var(--brand-rgb), 0.15)" : "var(--row-bg)",
                            color: active ? "var(--brand-400)" : "var(--text-main)",
                            border: "1px solid var(--border-subtle)",
                          }}
                        >
                          <img
                            src={`https://flagcdn.com/w40/${l.country}.png`}
                            alt={l.label}
                            className="w-4 h-3 object-cover rounded-[2px] flex-shrink-0"
                            loading="lazy"
                          />
                          <span className="flex-1 truncate font-medium">{l.label}</span>
                          {active && <span className="material-symbols-outlined" style={{ fontSize: 14 }}>check</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {/* TAB: SYSTEM / HOST */}
            {tab === "system" && (
              <div className="flex flex-col gap-2">
                {/* Launch on Startup */}
                <SettingRow
                  icon="rocket_launch"
                  title={t("remote.launchOnStartup")}
                  desc={t("remote.launchDesc")}
                >
                  <Toggle on={!!autoStart} onClick={onAutoStartToggle} />
                </SettingRow>

                {/* Prevent Sleep */}
                <SettingRow
                  icon="coffee"
                  title={t("remote.preventSleep")}
                  desc={t("remote.blockSleep")}
                >
                  <select
                    value={sleepInhibitMode || "never"}
                    onChange={(e) => onSleepInhibitChange?.(e.target.value)}
                    className="text-xs px-3 py-1.5 rounded-lg"
                    style={{
                      background: "var(--row-bg)",
                      color: "var(--text-main)",
                      border: "1px solid var(--border-subtle)",
                      cursor: "pointer",
                    }}
                  >
                    {(sleepInhibitPresets || []).map((m) => (
                      <option key={m} value={m}>{sleepLabels[m] || m}</option>
                    ))}
                  </select>
                </SettingRow>

                {/* Remote unlock (Windows SYSTEM worker) */}
                {unlockStatus?.supported && (
                  <SettingRow
                    icon="lock_open"
                    title={t("remote.remoteUnlock")}
                    desc={
                      unlockStatus.stale
                        ? t("remote.remoteUnlockStale")
                        : unlockStatus.running ? t("remote.remoteUnlockReady") : t("remote.remoteUnlockDesc")
                    }
                  >
                    <Toggle
                      on={!!unlockStatus.enabled}
                      disabled={!!unlockStatus.busy}
                      onClick={() => (unlockStatus.enabled ? onRequestUnlockUninstall?.() : onRequestUnlockInstall?.())}
                    />
                  </SettingRow>
                )}
              </div>
            )}

            {/* TAB: MAINTENANCE / LOGS */}
            {tab === "maintenance" && (
              <div className="flex flex-col gap-4">
                {/* Logs Viewer */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold text-text-muted uppercase tracking-wider">{t("menu.logs")}</span>
                    {logs.length > 0 && (
                      <button
                        onClick={onClearLogs}
                        className="glass-btn flex items-center gap-1 px-2.5 h-6 text-xs rounded-md"
                        style={{ color: "var(--text-muted)" }}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: 13 }}>delete_sweep</span> Clear
                      </button>
                    )}
                  </div>
                  <div
                    ref={logEndRef}
                    className="p-3 rounded-xl flex flex-col gap-1 overflow-y-auto h-44 font-mono text-[11px]"
                    style={{ background: "var(--row-bg)", border: "1px solid var(--border-subtle)" }}
                  >
                    {logs.length === 0 ? (
                      <p className="text-center py-6" style={{ color: "var(--text-muted)" }}>No logs yet</p>
                    ) : (
                      logs.map((line, i) => (
                        <p key={i} className="leading-5 break-all" style={{ color: "var(--text-muted)" }}>{line}</p>
                      ))
                    )}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex flex-col gap-2 pt-2 border-t" style={{ borderColor: "var(--border-subtle)" }}>
                  <button
                    onClick={() => window.open(HELP_URL, "_blank")}
                    className="w-full text-left px-3 py-2 rounded-xl text-xs font-medium flex items-center gap-2 card-act"
                    style={{ color: "var(--text-main)" }}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 16 }}>menu_book</span>
                    <span className="flex-1">{t("header.documentation")}</span>
                    <span className="material-symbols-outlined" style={{ fontSize: 14 }}>open_in_new</span>
                  </button>

                  {!isStopped && (
                    <button
                      onClick={() => { setOpen(false); onStop?.(); }}
                      className="w-full text-left px-3 py-2 rounded-xl text-xs font-medium flex items-center gap-2 card-act"
                      style={{ color: "var(--text-main)" }}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 16 }}>restart_alt</span>
                      <span className="flex-1">{t("header.resetShort")}</span>
                    </button>
                  )}

                  <button
                    onClick={() => { setOpen(false); onShutdown?.(); }}
                    className="w-full text-left px-3 py-2 rounded-xl text-xs font-medium flex items-center gap-2 card-act"
                    style={{ color: "var(--danger)" }}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 16 }}>power_settings_new</span>
                    <span className="flex-1">{t("header.shutdownShort")}</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="relative flex-shrink-0">
      <button onClick={() => setOpen(true)} title={t("header.settings")} className={triggerClass} style={triggerStyle}>
        <span className="material-symbols-outlined text-xl">settings</span>
      </button>
      {typeof document !== "undefined" && modalContent ? createPortal(modalContent, document.body) : modalContent}
    </div>
  );
}
