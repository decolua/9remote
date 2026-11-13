"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { ChevronRight, Globe, Sun, Moon, Download, LogOut, Bell, Loader2, FileText, Users, RefreshCw, RotateCw, Monitor, Type, Palette, Terminal, ChevronDown, Wallpaper, Keyboard, PanelRight, Zap, Bot, Star, Check, Smartphone, Link2 } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useSlideMenuStore } from "@/shared/stores/slideMenuStore";
import { BUTTON_TOGGLE_ICONS } from "@/features/terminal/constants/headerButtonIcons";
import { useButtonToggles } from "@/features/terminal/hooks/useButtonToggles";

import { useTerminalStore } from "@/shared/stores/terminalStore";
import { useI18n } from "@/shared/i18n";
import { SUPPORTED_LOCALES } from "@/shared/i18n/config";
import { useTheme } from "@/shared/theme/ThemeProvider";
import { TERMINAL_THEME_OPTIONS } from "@/features/terminal/constants/themes";
import { backgroundLabel } from "@/features/terminal/constants/terminalConfig";
import { usePushToggle } from "@/features/terminal/hooks/usePushToggle";
import { useArtifactToggle } from "@/features/terminal/hooks/useArtifactToggle";
import VoiceEndpointSettings from "@/shared/components/ui/VoiceEndpointSettings";
import { useJarvisStore } from "@/shared/stores/jarvisStore";
import { JARVIS_ENABLED } from "@/shared/lib/jarvisConstants";
import { useInputMode } from "@/shared/hooks/useInputMode";
import { useShortcutsModalStore } from "@/shared/stores/shortcutsModalStore";
import Collapse from "@/shared/components/ui/Collapse";


// ---- Grouped settings shell (9love's settings screen) -----------------------
// One plate per subject, rows as bare lines inside it, and a small gradient squircle
// leading each row. The plate carries the boundary, so no row draws its own.

function SectionLabel({ children }) {
  return (
    <p className="mx-1 mt-4 mb-2 text-[11px] font-semibold uppercase tracking-[0.4px] text-text-subtle">
      {children}
    </p>
  );
}

function Card({ children, className = "", i = 0 }) {
  return (
    <div className="card-rise" style={{ "--i": i }}>
      <div className={`glass-card rounded-[18px] overflow-hidden ${className}`}>{children}</div>
    </div>
  );
}

const ROW_CLS = "w-full px-3.5 py-3 text-left flex items-center gap-3 transition-colors duration-150 ease-out active:bg-text/[0.06] disabled:opacity-50";
// Sub-rows sit tighter than top-level rows so an open group reads as one block.
const SUB_ROW_CLS = "w-full px-3.5 py-2 text-left flex items-center gap-3 transition-colors duration-150 ease-out active:bg-text/[0.06] disabled:opacity-50";

function Row({ icon: Icon, tone = "bg-brand-500", label, hint = null, tail = null, onClick, disabled = false, danger = false, flat = false }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={flat ? SUB_ROW_CLS : ROW_CLS}>
      {flat ? (
        <span className="w-7 flex-shrink-0 flex items-center justify-center text-text-muted">
          <Icon size={16} strokeWidth={2.2} />
        </span>
      ) : (
        <span className={`squircle-icon ${tone}`}>
          <Icon size={16} strokeWidth={2.2} />
        </span>
      )}
      <span className="flex-1 min-w-0 flex flex-col">
        <span className={`text-[15px] font-medium ${danger ? "text-danger" : "text-text"}`}>{label}</span>
        {hint && <span className="text-[12px] leading-snug text-text-muted">{hint}</span>}
      </span>
      {tail}
    </button>
  );
}

/** A row that opens a group — the header keeps the row shape and animates its chevron. */
function GroupRow({ icon: Icon, tone, label, open, onToggle, tail = null }) {
  return (
    <button type="button" onClick={onToggle} className={ROW_CLS} aria-expanded={open}>
      <span className={`squircle-icon ${tone}`}>
        <Icon size={16} strokeWidth={2.2} />
      </span>
      <span className="flex-1 min-w-0 text-[15px] font-medium text-text">{label}</span>
      {tail}
      <ChevronDown size={16} className={`text-text-muted transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
    </button>
  );
}

/** Divider between rows of one card — the only line this screen still draws. */
function Seam() {
  return <div className="ml-[54px] h-px bg-[var(--lg-hairline)]" />;
}

function Switch({ on }) {
  return (
    <span className={`shrink-0 relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 ${on ? "bg-[#34c759]" : "bg-text/15"}`}>
      <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform duration-200 ease-out ${on ? "translate-x-[22px]" : "translate-x-0.5"}`} />
    </span>
  );
}

export default function MenuItems({
  onRemote,
  onFiles,
  onCommandNotes,
  onCommunity,
  onInstallApp,
  canInstall = false,
  isInstalled = false,
  onLogout,
  connected = true,
  remoteAvailable = false,
  showTheme = false,
  theme = "default",
  onThemeChange,
  hideActions = [],
  busRef = null,
  subscribeToPush = null,
  unsubscribeFromPush = null,
  onOpenBackgroundPicker,
  onOpenLanguage
}) {
  const { t, locale } = useI18n();
  const currentLocale = SUPPORTED_LOCALES.find((l) => l.code === locale);
  const inputMode = useInputMode();
  const openShortcuts = useShortcutsModalStore((s) => s.open);
  const closeMenu = useSlideMenuStore((s) => s.close);
  const { connectionMode = "tunnel", hostVersion, agentVersion } = useSlideMenuStore((s) => s.context);
  const buttonToggles = useButtonToggles();
  // Same toggle list as the desktop settings screen: each button names its page
  // (`section`). Remote desktop is not offered on mobile.
  const renderToggles = (section) => {
    if (hideActions.includes("headerButtons")) return null;
    return buttonToggles.buttons
      .filter((b) => b.section === section && b.id !== "remote")
      .map((btn) => {
        const RowIcon = BUTTON_TOGGLE_ICONS[btn.id];
        const on = buttonToggles.isOn(btn);
        return (
          <Row
            key={btn.id}
            flat
            icon={RowIcon}
            label={t(btn.labelKey)}
            hint={btn.descKey ? t(btn.descKey) : null}
            onClick={() => { vibrate(); buttonToggles.toggle(btn); }}
            tail={<Switch on={on} />}
          />
        );
      });
  };
  const jarvisEnabled = useJarvisStore((s) => JARVIS_ENABLED && s.settings.enabled);
  const webglEnabled = useTerminalStore((s) => s.webglEnabled);
  const setWebglEnabled = useTerminalStore((s) => s.setWebglEnabled);
  const fontSize = useTerminalStore((s) => s.fontSize);
  const setFontSize = useTerminalStore((s) => s.setFontSize);
  const terminalTheme = useTerminalStore((s) => s.terminalTheme);
  const setTerminalTheme = useTerminalStore((s) => s.setTerminalTheme);
  const terminalBackgrounds = useTerminalStore((s) => s.terminalBackgrounds);
  const { theme: appMode, toggleTheme } = useTheme();
  // Accordion: one group open at a time, so the screen never stacks two panels.
  const [openGroup, setOpenGroup] = useState(null);
  const toggleGroup = useCallback((id) => {
    vibrate();
    setOpenGroup((cur) => (cur === id ? null : id));
  }, []);
  const [reloading, setReloading] = useState(false);
  const terminalMenuRef = useRef(null);


  // Close terminal settings dropdown on outside click
  useEffect(() => {
    if (openGroup !== "terminal") return;
    const onClick = (e) => {
      if (terminalMenuRef.current && !terminalMenuRef.current.contains(e.target)) {
        setOpenGroup(null);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [openGroup]);

  const [isMobile, setIsMobile] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- SSR-safe read after mount
  useEffect(() => { setIsMobile(window.innerWidth < 768); }, []);
  const webVersion = process.env.NEXT_PUBLIC_SERVER_VERSION;

  const push = usePushToggle(subscribeToPush, unsubscribeFromPush);
  const artifact = useArtifactToggle(busRef, connected);
  // Treat native WebView (Expo) the same as PWA for UI gating
  const isExpo = typeof window !== "undefined" && (
    push.isExpoWebView || !!window.ReactNativeWebView || /9Remote-Mobile/i.test(navigator.userAgent)
  );
  const isApp = typeof window !== "undefined" && (
    window.matchMedia("(display-mode: standalone)").matches || isExpo
  );
  // iOS app: orientation item hidden until a build with the bridge handler ships
  const isAndroidApp = isExpo && !(/iPad|iPhone|iPod/.test(navigator.userAgent));

  const [orientation, setOrientation] = useState(() => {
    if (typeof window !== "undefined") {
      // "auto" matches the native default lock (OrientationLock.DEFAULT)
      return window.CURRENT_ORIENTATION || localStorage.getItem("expo_orientation") || "auto";
    }
    return "auto";
  });

  useEffect(() => {
    if (!isAndroidApp) return;
    const handler = (newOri) => {
      if (newOri) {
        setOrientation(newOri);
        try { localStorage.setItem("expo_orientation", newOri); } catch {}
      }
    };
    window.handleScreenOrientationChange = handler;
    try {
      // Native lock resets on app restart — re-apply the persisted mode; otherwise
      // just read the current lock so the UI matches reality
      const stored = localStorage.getItem("expo_orientation");
      window.ReactNativeWebView?.postMessage(JSON.stringify(
        ["portrait", "auto"].includes(stored)
          ? { type: "SET_SCREEN_ORIENTATION", orientation: stored }
          : { type: "GET_SCREEN_ORIENTATION" }
      ));
    } catch {}
    return () => {
      if (window.handleScreenOrientationChange === handler) {
        window.handleScreenOrientationChange = undefined;
      }
    };
  }, [isAndroidApp]);

  const handleOrientationChange = useCallback((mode) => {
    vibrate();
    setOrientation(mode);
    try { localStorage.setItem("expo_orientation", mode); } catch {}
    try {
      window.ReactNativeWebView?.postMessage(JSON.stringify({
        type: "SET_SCREEN_ORIENTATION",
        orientation: mode
      }));
    } catch {}
  }, []);

  const handleRateApp = useCallback(() => {
    vibrate();
    try {
      window.ReactNativeWebView?.postMessage(JSON.stringify({ type: "OPEN_RATING" }));
    } catch {}
  }, []);

  return (
    <div className="px-3 pb-4">
      {/* 9love's Preferences card: dark mode and language are ROWS here, not icons in
          the screen header, so the header can be nothing but a title. */}
      <SectionLabel>{t("menu.settingsAppearance")}</SectionLabel>
      <div className="space-y-3">
        <Card i={0}>
          <Row
            icon={appMode === "dark" ? Moon : Sun}
            tone="bg-gradient-to-br from-amber-400 to-orange-500"
            label={t("menu.theme")}
            onClick={() => { vibrate(); toggleTheme(); }}
            tail={<Switch on={appMode === "dark"} />}
          />
          <Seam />
          <Row
            icon={Globe}
            tone="bg-gradient-to-br from-blue-500 to-indigo-600"
            label={t("menu.language")}
            onClick={() => { vibrate(); onOpenLanguage?.(); }}
            tail={
              <>
                <span className="flex items-center gap-1.5 text-text-muted">
                  {currentLocale && (
                    <img
                      src={`https://flagcdn.com/w40/${currentLocale.country}.png`}
                      alt=""
                      className="w-[17px] h-[12px] object-cover rounded-[2px]"
                      loading="lazy"
                    />
                  )}
                  <span className="text-[13px] font-medium">{currentLocale?.label || locale.toUpperCase()}</span>
                </span>
                <ChevronRight size={15} className="text-text-muted" />
              </>
            }
          />
          {(!isApp && !isInstalled && onInstallApp) || push.supported ? <Seam /> : null}
          {!isApp && !isInstalled && onInstallApp && (
            <Row
              icon={Download}
              label={t("menu.installApp")}
              onClick={() => { vibrate(); onInstallApp(); }}
              tail={canInstall ? (
                <span className="flex-shrink-0 px-2 py-0.5 bg-brand-500 text-white text-[11px] font-semibold rounded-full">
                  {t("pwaGuide.installNow")}
                </span>
              ) : null}
            />
          )}
          {push.supported && (
            <>
              {!isApp && !isInstalled && onInstallApp ? <Seam /> : null}
              <Row
                icon={Bell}
                label={t("menu.notifications")}
                hint={t("menu.notificationsHint")}
                disabled={push.loading}
                onClick={push.toggle}
                tail={push.loading ? <Loader2 size={16} className="animate-spin text-text-muted" /> : <Switch on={push.enabled} />}
              />
            </>
          )}
        </Card>

        {/* The terminal/remote/plugin groups sit under their own heading, like every
            other card on the screen. Without it this block read as a continuation of
            the Preferences card above. */}
        <SectionLabel>{t("menu.settingsTerminalTab")}</SectionLabel>
        <Card i={1}>
          {!hideActions.includes("terminalSettings") && (
            <div ref={terminalMenuRef}>
              <GroupRow
                icon={Terminal}
                tone="bg-gradient-to-br from-slate-500 to-zinc-600"
                label={t("menu.terminalSettings")}
                open={openGroup === "terminal"}
                onToggle={() => toggleGroup("terminal")}
              />
              <Collapse open={openGroup === "terminal"}>
                <div className="px-3.5 pb-3 space-y-1">
                  <Row
                    flat
                    icon={Monitor}
                    label={t("menu.webgl")}
                    hint={t("menu.webglHint")}
                    onClick={() => { vibrate(); setWebglEnabled(!webglEnabled); }}
                    tail={<Switch on={webglEnabled} />}
                  />
                  <div className="flex items-center gap-3 px-3.5 py-2">
                    <span className="w-7 flex-shrink-0 flex items-center justify-center text-text-muted">
                      <Type size={16} strokeWidth={2.2} />
                    </span>
                    <span className="text-[15px] font-medium text-text">{t("menu.fontSize")}</span>
                    <select
                      value={fontSize ?? (isMobile ? 12 : 14)}
                      onChange={(e) => { vibrate(); setFontSize(Number(e.target.value)); }}
                      className="ml-auto bg-text/[0.06] text-text text-[13px] rounded-[8px] px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-brand-500"
                    >
                      {Array.from({ length: isMobile ? 7 : 9 }, (_, i) => i + 10).map((n) => (
                        <option key={n} value={n}>{n}px</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex items-center gap-3 px-3.5 py-2">
                    <span className="w-7 flex-shrink-0 flex items-center justify-center text-text-muted">
                      <Palette size={16} strokeWidth={2.2} />
                    </span>
                    <span className="text-[15px] font-medium text-text">{t("menu.terminalTheme")}</span>
                    <select
                      value={terminalTheme}
                      onChange={(e) => { vibrate(); setTerminalTheme(e.target.value); }}
                      className="ml-auto bg-text/[0.06] text-text text-[12px] rounded-[8px] px-2 py-1 max-w-[55%] focus:outline-none focus:ring-1 focus:ring-brand-500"
                    >
                      <option value="default">Vesper (Default)</option>
                      {TERMINAL_THEME_OPTIONS.filter((opt) => opt.mode === appMode).map((opt) => (
                        <option key={opt.key} value={opt.key}>{opt.label}</option>
                      ))}
                    </select>
                  </div>
                  {renderToggles("terminal")}
                </div>
              </Collapse>
            </div>
          )}

          {!hideActions.includes("terminalSettings") && <Seam />}
          <div>
            <GroupRow
              icon={Link2}
              tone="bg-gradient-to-br from-emerald-500 to-teal-600"
              label={t("menu.settingsRemote")}
              open={openGroup === "remote"}
              onToggle={() => toggleGroup("remote")}
            />
            <Collapse open={openGroup === "remote"}>
              <div className="px-3.5 pb-3 space-y-1">{renderToggles("remote")}</div>
            </Collapse>
          </div>

          <Seam />
          <div>
            <GroupRow
              icon={Zap}
              tone="bg-gradient-to-br from-amber-500 to-orange-600"
              label={t("menu.settingsMcp")}
              open={openGroup === "mcp"}
              onToggle={() => toggleGroup("mcp")}
            />
            <Collapse open={openGroup === "mcp"}>
              <div className="px-3.5 pb-3 space-y-1">
                <VoiceEndpointSettings dense />
                {artifact.supported && (
                  <>
                    <Row
                      flat
                      icon={PanelRight}
                      label={t("menu.artifactPanel")}
                      hint={t("menu.artifactHint")}
                      disabled={artifact.loading || !connected}
                      onClick={artifact.toggle}
                      tail={<Switch on={artifact.enabled} />}
                    />
                  </>
                )}
                {renderToggles("plugins")}
              </div>
            </Collapse>
          </div>

          {isAndroidApp && (
            <>
              <Seam />
              <div>
                <GroupRow
                  icon={RotateCw}
                  tone="bg-gradient-to-br from-sky-500 to-blue-600"
                  label={t("menu.orientation")}
                  open={openGroup === "orientation"}
                  onToggle={() => toggleGroup("orientation")}
                />
                <Collapse open={openGroup === "orientation"}>
                  <div className="px-3.5 pb-3 space-y-1">
                    {[
                      { id: "portrait", label: t("menu.orientationPortrait"), Icon: Smartphone },
                      { id: "auto", label: t("menu.orientationAuto"), Icon: RotateCw }
                    ].map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => handleOrientationChange(item.id)}
                        className="w-full px-3.5 py-2 text-text text-left flex items-center gap-3 rounded-[10px] transition-colors duration-150 ease-out active:bg-text/[0.06]"
                      >
                        <span className="w-7 flex-shrink-0 flex items-center justify-center text-text-muted">
                          <item.Icon size={16} strokeWidth={2.2} />
                        </span>
                        <span className="text-[15px] font-medium flex-1">{item.label}</span>
                        {orientation === item.id && <Check size={16} className="text-brand-500 flex-shrink-0" />}
                      </button>
                    ))}
                  </div>
                </Collapse>
              </div>
            </>
          )}
        </Card>
      </div>

      {/* Tools on this device — background, Jarvis, notes, shortcuts, community, reload. */}
      <SectionLabel>{t("menu.settingsApplication")}</SectionLabel>
      <Card i={2}>
        {appMode === "dark" && (
          <>
            <Row
              icon={Wallpaper}
              tone="bg-gradient-to-br from-fuchsia-500 to-purple-600"
              label={t("menu.terminalBackground")}
              onClick={() => { vibrate(); onOpenBackgroundPicker?.(); }}
              tail={
                <span className="text-[12px] text-text-muted truncate max-w-[90px]">
                  {terminalBackgrounds.length > 1
                    ? `${backgroundLabel(terminalBackgrounds[0])} +${terminalBackgrounds.length - 1}`
                    : backgroundLabel(terminalBackgrounds[0])}
                </span>
              }
            />
            <Seam />
          </>
        )}
        {jarvisEnabled && (
          <>
            <Row icon={Bot} label="Jarvis" onClick={() => { vibrate(); closeMenu(); useJarvisStore.getState().toggle(); }} />
            <Seam />
          </>
        )}
        {onCommandNotes && (
          <>
            <Row icon={FileText} label={t("menu.commandNotes")} onClick={() => { vibrate(); onCommandNotes(); }} />
            <Seam />
          </>
        )}
        {inputMode === "mouse" && (
          <>
            <Row icon={Keyboard} label={t("shortcuts.menuLabel")} onClick={() => { vibrate(); closeMenu(); openShortcuts(); }} />
            <Seam />
          </>
        )}
        {onCommunity && (
          <>
            <Row icon={Users} label={t("menu.community")} onClick={() => { vibrate(); onCommunity(); }} />
            <Seam />
          </>
        )}
        {isExpo && window.DEVICE_INFO?.platform !== "ios" && (
          <>
            <Row icon={Star} label={t("menu.rateApp")} onClick={handleRateApp} />
            <Seam />
          </>
        )}
        <Row
          icon={RefreshCw}
          label={t("menu.reload")}
          disabled={reloading}
          onClick={() => { vibrate(); setReloading(true); setTimeout(() => window.location.reload(), 150); }}
          tail={reloading ? <Loader2 size={16} className="animate-spin text-text-muted" /> : null}
        />
      </Card>

      {onLogout && (
        <>
          <SectionLabel>{t("menu.settingsAccount")}</SectionLabel>
          <Card i={3}>
            <Row icon={LogOut} tone="bg-danger/15 !text-danger" label={t("menu.logout")} danger onClick={() => { vibrate(); onLogout(); }} />
          </Card>
        </>
      )}

      {/* Version + connection mode */}
      <div className="flex items-center justify-end gap-2 mt-5 mr-1">
        {connectionMode === "local" && (
          <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-green-500/15 text-green-400">
            LAN
          </span>
        )}
        <p className="text-text-muted text-[12px]">
          {t("menu.version")} {webVersion}{(hostVersion || agentVersion) ? ` / 9Remote ${hostVersion || agentVersion}` : ""}
        </p>
      </div>
    </div>
  );
}
