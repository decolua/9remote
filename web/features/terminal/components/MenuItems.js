"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { Download, Sparkles, LogOut, Bell, Loader2, FileText, Users, RefreshCw, RotateCw, Monitor, Type, Palette, Terminal, ChevronDown, ChevronRight, Wallpaper, Keyboard, PanelRight, Zap, QrCode, Bot } from "@/shared/components/ui/Icon";
import { isLoopbackOrigin } from "@/shared/utils/localOrigin";
import { vibrate } from "@/shared/utils/vibration";
import { useSlideMenuStore } from "@/shared/stores/slideMenuStore";
import { BUTTON_GROUPS } from "@/features/terminal/constants/terminalConfig";
import { BUTTON_TOGGLE_ICONS } from "@/features/terminal/constants/headerButtonIcons";
import { useButtonToggles } from "@/features/terminal/hooks/useButtonToggles";

import { useTerminalStore } from "@/shared/stores/terminalStore";
import { useI18n } from "@/shared/i18n";
import { useTheme } from "@/shared/theme/ThemeProvider";
import { TERMINAL_THEME_OPTIONS } from "@/features/terminal/constants/themes";
import { backgroundLabel } from "@/features/terminal/constants/terminalConfig";
import AgentOutdatedBanner, { isAgentOutdated, isWebOutdated } from "@/features/terminal/components/AgentOutdatedBanner";
import AgentSwitcher from "@/features/terminal/components/AgentSwitcher";
import { useApiKeyStorage } from "@/shared/hooks/useApiKeyStorage";
import { saveLastRoute, getLastRoute } from "@/shared/hooks/useLastRoute";
import { API_ENDPOINTS, TUNNEL_VERIFY_RETRY_MAX, TUNNEL_VERIFY_RETRY_INTERVAL_MS } from "@/shared/constants/API";
import { isLegacyApiKey } from "@/shared/utils/apiKey";
import { useSessionStorage } from "@/shared/hooks/useSessionStorage";
import { verifyServerConnection } from "@/shared/hooks/useAuth";
import { usePushToggle } from "@/features/terminal/hooks/usePushToggle";
import { useArtifactToggle } from "@/features/terminal/hooks/useArtifactToggle";
import VoiceEndpointSettings from "@/shared/components/ui/VoiceEndpointSettings";
import { useJarvisStore } from "@/shared/stores/jarvisStore";
import { JARVIS_ENABLED } from "@/shared/lib/jarvisConstants";
import { useInputMode } from "@/shared/hooks/useInputMode";
import { useShortcutsModalStore } from "@/shared/stores/shortcutsModalStore";

export default function MenuItems({
  onRemote,
  onFiles,
  onCommandNotes,
  onCommunity,
  onInstallApp,
  canInstall = false,
  isInstalled = false,
  onCodespace,
  onLogout,
  connected = true,
  remoteAvailable = false,
  codespaceInfo = null,
  showTheme = false,
  theme = "default",
  onThemeChange,
  hideActions = [],
  busRef = null,
  subscribeToPush = null,
  unsubscribeFromPush = null,
  onUpdate,
  onRestart,
  onOpenBackgroundPicker
}) {
  const { t } = useI18n();
  const inputMode = useInputMode();
  const openShortcuts = useShortcutsModalStore((s) => s.open);
  const closeMenu = useSlideMenuStore((s) => s.close);
  const { connectionMode = "tunnel", agentVersion } = useSlideMenuStore((s) => s.context);
  const buttonToggles = useButtonToggles();
  const jarvisEnabled = useJarvisStore((s) => JARVIS_ENABLED && s.settings.enabled);
  const webglEnabled = useTerminalStore((s) => s.webglEnabled);
  const setWebglEnabled = useTerminalStore((s) => s.setWebglEnabled);
  const fontSize = useTerminalStore((s) => s.fontSize);
  const setFontSize = useTerminalStore((s) => s.setFontSize);
  const terminalTheme = useTerminalStore((s) => s.terminalTheme);
  const setTerminalTheme = useTerminalStore((s) => s.setTerminalTheme);
  const terminalBackgrounds = useTerminalStore((s) => s.terminalBackgrounds);
  const { theme: appMode } = useTheme();
  const [terminalMenuOpen, setTerminalMenuOpen] = useState(false);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [mcpMenuOpen, setMcpMenuOpen] = useState(false);
  const [powerMenuOpen, setPowerMenuOpen] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [switchingKey, setSwitchingKey] = useState(null);
  const [switchError, setSwitchError] = useState("");
  const terminalMenuRef = useRef(null);

  const { loadKeys } = useApiKeyStorage();
  const { setAuth } = useSessionStorage();
  const savedKeys = typeof window !== "undefined" ? loadKeys() : [];
  const currentApiKey = useSessionStorage().getAuth()?.apiKey;

  // Switch to another saved agent: persist current URL, re-auth, verify tunnel, then reload.
  // Only navigate when the new agent is actually reachable — avoids landing on a dead session.
  // Currently hidden in the UI (managed from login); kept for re-enabling later.
  const handleSwitchAgent = useCallback(async (newKey) => {
    if (!newKey || newKey === currentApiKey) return;
    if (isLegacyApiKey(newKey)) {
      setSwitchError(t("login.legacyKeyError"));
      return;
    }
    vibrate();
    setSwitchError("");
    setSwitchingKey(newKey);
    if (currentApiKey && typeof window !== "undefined") {
      saveLastRoute(currentApiKey, window.location.pathname + window.location.search);
    }
    try {
      const resp = await fetch(API_ENDPOINTS.connect, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: newKey })
      });
      if (!resp.ok) throw new Error("connect failed");
      const data = await resp.json();

      let connected = false;
      for (let i = 0; i < TUNNEL_VERIFY_RETRY_MAX; i++) {
        connected = await verifyServerConnection(data.tunnelUrl, newKey);
        if (connected) break;
        if (i < TUNNEL_VERIFY_RETRY_MAX - 1) {
          await new Promise((r) => setTimeout(r, TUNNEL_VERIFY_RETRY_INTERVAL_MS));
        }
      }
      if (!connected) {
        setSwitchingKey(null);
        setSwitchError(t("agentSwitcher.unreachable"));
        return;
      }

      setAuth({
        apiKey: newKey,
        tunnelUrl: data.tunnelUrl,
        mode: "remote",
        localIp: data.localIp || null
      });
      const last = getLastRoute(newKey);
      window.location.href = last || "/workspace/";
    } catch {
      setSwitchingKey(null);
      setSwitchError(t("agentSwitcher.unreachable"));
    }
  }, [currentApiKey, setAuth, t]);

  // Close terminal settings dropdown on outside click
  useEffect(() => {
    if (!terminalMenuOpen) return;
    const onClick = (e) => {
      if (terminalMenuRef.current && !terminalMenuRef.current.contains(e.target)) {
        setTerminalMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [terminalMenuOpen]);

  const powerMenuRef = useRef(null);

  // Close power dropdown on outside click
  useEffect(() => {
    if (!powerMenuOpen) return;
    const onClick = (e) => {
      if (powerMenuRef.current && !powerMenuRef.current.contains(e.target)) {
        setPowerMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [powerMenuOpen]);
  const [isMobile, setIsMobile] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- SSR-safe read after mount
  useEffect(() => { setIsMobile(window.innerWidth < 768); }, []);
  const webVersion = process.env.NEXT_PUBLIC_SERVER_VERSION;
  const isOutdated = isAgentOutdated(agentVersion, webVersion) || isWebOutdated(agentVersion, webVersion);

  const push = usePushToggle(subscribeToPush, unsubscribeFromPush);
  const artifact = useArtifactToggle(busRef, connected);
  // Treat native WebView (Expo) the same as PWA for UI gating
  const isApp = typeof window !== "undefined" && (
    window.matchMedia("(display-mode: standalone)").matches || push.isExpoWebView
  );

  return (
    <div className="p-3 space-y-0.5">
      {/* Install App - pinned to top; hidden when running as PWA/native or already installed.
          Whole row is one button; a small brand chip on the right signals one-tap install on Chromium. */}
      {!isApp && !isInstalled && onInstallApp && (
        <button
          onClick={() => { vibrate(); onInstallApp(); }}
          className="w-full px-3 py-1.5 mb-1.5 bg-surface hover:bg-surface-2 text-text rounded-brand-lg text-left flex items-center gap-2.5 transition duration-150 ease-out active:scale-[0.99]"
        >
          <Download className="text-brand-500 flex-shrink-0" size={16} />
          <span className="text-sm flex-1 min-w-0 truncate">{t("menu.installApp")}</span>
          {canInstall && (
            <span className="flex-shrink-0 px-2 py-0.5 bg-brand-500 text-white text-xs font-medium rounded-full">
              {t("pwaGuide.installNow")}
            </span>
          )}
        </button>
      )}

      {/* Notifications switch - WebPush (desktop browser + PWA) or Expo native */}
      {push.supported && (
        <button
          onClick={push.toggle}
          disabled={push.loading}
          className="w-full px-3 py-1.5 bg-surface hover:bg-surface-2 disabled:opacity-50 text-text rounded-brand-lg text-left flex items-center justify-between gap-2.5 transition duration-150 ease-out active:scale-[0.99]"
        >
          <div className="flex items-center gap-2.5">
            <Bell className="text-brand-500" size={16} />
            <div className="flex flex-col">
              <span className="text-sm">{t("menu.notifications")}</span>
              <span className="text-xs text-text-muted">{t("menu.notificationsHint")}</span>
            </div>
          </div>
          {push.loading ? (
            <Loader2 className="animate-spin text-text-muted" size={16} />
          ) : (
            <span className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${push.enabled ? "bg-brand-500" : "bg-surface-2"}`}>
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${push.enabled ? "translate-x-4" : "translate-x-0.5"}`} />
            </span>
          )}
        </button>
      )}

      {/* Terminal settings — collapsible dropdown (font + theme + GPU render) */}
      {/* Header buttons — the same list the desktop settings screen offers, so a
          button hidden on one is hidden on the other. */}
      {!hideActions.includes('headerButtons') && (
        <div className="bg-surface rounded-brand-lg overflow-hidden">
          <button
            onClick={() => { vibrate(); setHeaderMenuOpen((v) => !v); }}
            className="w-full px-3 py-1.5 hover:bg-surface-2 text-text text-left flex items-center gap-2.5 transition duration-150 ease-out active:scale-[0.99]"
          >
            <PanelRight className="text-brand-500" size={16} />
            <span className="text-sm flex-1">{t("menu.settingsButtons")}</span>
            <ChevronDown className={`text-text-muted transition-transform duration-200 ${headerMenuOpen ? "rotate-180" : ""}`} size={16} />
          </button>
          {headerMenuOpen && (
            <div className="pl-6 pr-3 pb-1.5 space-y-1.5">
              {BUTTON_GROUPS.map(({ group, titleKey }) => (
                <div key={group} className="space-y-1.5">
                  <p className="pt-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted">{t(titleKey)}</p>
                  {buttonToggles.buttons.filter((b) => b.group === group).map((btn) => {
                    // Hide remote desktop and emulator buttons from mobile right menu
                    if (btn.id === "remote" || btn.id === "mobile") return null;
                    const RowIcon = BUTTON_TOGGLE_ICONS[btn.id];
                    const on = buttonToggles.isOn(btn);
                    return (
                      <button
                        key={btn.id}
                        onClick={() => { vibrate(); buttonToggles.toggle(btn); }}
                        className="w-full py-1 hover:bg-surface-2 text-text rounded-brand text-left flex items-center gap-2.5 transition duration-150 ease-out active:scale-[0.99]"
                      >
                        <RowIcon className="text-text" size={16} />
                        <span className="text-sm flex-1">{t(btn.labelKey)}</span>
                        <span className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${on ? "bg-brand-500" : "bg-surface-2"}`}>
                          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${on ? "translate-x-4" : "translate-x-0.5"}`} />
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {!hideActions.includes('terminalSettings') && (
        <div ref={terminalMenuRef} className="bg-surface rounded-brand-lg overflow-hidden">
          <button
            onClick={() => { vibrate(); setTerminalMenuOpen((v) => !v); }}
            className="w-full px-3 py-1.5 hover:bg-surface-2 text-text text-left flex items-center gap-2.5 transition duration-150 ease-out active:scale-[0.99]"
          >
            <Terminal className="text-brand-500" size={16} />
            <span className="text-sm flex-1">{t("menu.terminalSettings")}</span>
            <ChevronDown className={`text-text-muted transition-transform duration-200 ${terminalMenuOpen ? "rotate-180" : ""}`} size={16} />
          </button>
          {terminalMenuOpen && (
            <div className="pl-6 pr-3 pb-1.5 space-y-1.5">
              <button
                onClick={() => { vibrate(); setWebglEnabled(!webglEnabled); }}
                className="w-full py-1 hover:bg-surface-2 text-text rounded-brand text-left flex items-center gap-2.5 transition duration-150 ease-out active:scale-[0.99]"
              >
                <Monitor className="text-text" size={16} />
                <div className="flex flex-col flex-1">
                  <span className="text-sm">{t("menu.webgl")}</span>
                  <span className="text-xs text-text-muted">{t("menu.webglHint")}</span>
                </div>
                <span className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${webglEnabled ? "bg-brand-500" : "bg-surface-2"}`}>
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${webglEnabled ? "translate-x-4" : "translate-x-0.5"}`} />
                </span>
              </button>

              <div className="flex items-center gap-2.5 pt-1.5">
                <Type className="text-text" size={16} />
                <span className="text-sm">{t("menu.fontSize")}</span>
                <select
                  value={fontSize ?? (isMobile ? 12 : 14)}
                  onChange={(e) => { vibrate(); setFontSize(Number(e.target.value)); }}
                  className="ml-auto bg-surface-2 text-text text-sm rounded-brand px-2 py-1 focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                >
                  {Array.from({ length: isMobile ? 7 : 9 }, (_, i) => i + 10).map((n) => (
                    <option key={n} value={n}>{n}px</option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-2.5">
                <Palette className="text-text" size={16} />
                <span className="text-sm">{t("menu.terminalTheme")}</span>
                <select
                  value={terminalTheme}
                  onChange={(e) => { vibrate(); setTerminalTheme(e.target.value); }}
                  className="ml-auto bg-surface-2 text-text text-xs rounded-brand px-2 py-1 max-w-[55%] focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                >
                  <option value="default">Vesper (Default)</option>
                  {TERMINAL_THEME_OPTIONS
                    .filter((opt) => opt.mode === appMode)
                    .map((opt) => (
                      <option key={opt.key} value={opt.key}>{opt.label}</option>
                    ))}
                </select>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Plugins — AI extras + voice endpoint. Its own section rather than a terminal
          setting: it changes what the AI can do, not how a terminal looks. */}
      <div className="bg-surface rounded-brand-lg overflow-hidden">
        <button
          onClick={() => { vibrate(); setMcpMenuOpen((v) => !v); }}
          className="w-full px-3 py-1.5 hover:bg-surface-2 text-text text-left flex items-center gap-2.5 transition duration-150 ease-out active:scale-[0.99]"
        >
          <Zap className="text-brand-500" size={16} />
          <span className="text-sm flex-1">{t("menu.settingsMcp")}</span>
          <ChevronDown className={`text-text-muted transition-transform duration-200 ${mcpMenuOpen ? "rotate-180" : ""}`} size={16} />
        </button>
        {mcpMenuOpen && (
          <div className="pl-6 pr-3 pb-1.5 space-y-1.5">
            <VoiceEndpointSettings dense />
            {artifact.supported && (<>
              <div className="flex items-center gap-2.5">
                <PanelRight className="text-text shrink-0" size={16} />
                <span className="text-sm flex-1 min-w-0">{t("menu.artifactPanel")}</span>
                <button
                  onClick={artifact.toggle}
                  disabled={artifact.loading || !connected}
                  className={`shrink-0 relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-60 ${artifact.enabled ? "bg-brand-500" : "bg-surface-2"}`}
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${artifact.enabled ? "translate-x-4" : "translate-x-0.5"}`} />
                </button>
              </div>
              <p className="text-[11px] leading-relaxed text-text-muted">{t("menu.artifactHint")}</p>
            </>)}
          </div>
        )}
      </div>

      {/* Terminal background picker — standalone row (mobile, dark mode only) */}
      {appMode === "dark" && (
        <button
          onClick={() => { vibrate(); onOpenBackgroundPicker?.(); }}
          className="w-full px-3 py-1.5 bg-surface hover:bg-surface-2 text-text rounded-brand-lg text-left flex items-center gap-2.5 transition duration-150 ease-out active:scale-[0.99]"
        >
          <Wallpaper className="text-brand-500 flex-shrink-0" size={16} />
          <span className="text-sm flex-1 min-w-0">{t("menu.terminalBackground")}</span>
          <span
            className="text-xs text-text-muted truncate max-w-[90px]"
            data-tip={terminalBackgrounds.length > 1
              ? `${backgroundLabel(terminalBackgrounds[0])} +${terminalBackgrounds.length - 1}`
              : backgroundLabel(terminalBackgrounds[0])}
          >
            {terminalBackgrounds.length > 1
              ? `${backgroundLabel(terminalBackgrounds[0])} +${terminalBackgrounds.length - 1}`
              : backgroundLabel(terminalBackgrounds[0])}
          </span>
          <ChevronRight size={16} className="text-text-muted flex-shrink-0" />
        </button>
      )}

      {/* Jarvis coordinator — opens the kanban + voice chat overlay */}
      {jarvisEnabled && (
      <button
        onClick={() => { vibrate(); closeMenu(); useJarvisStore.getState().toggle(); }}
        className="w-full px-3 py-1.5 rounded-brand-lg text-left flex items-center gap-2.5 transition duration-150 ease-out bg-surface hover:bg-surface-2 text-text active:scale-[0.99]"
      >
        <Bot className="text-brand-500" size={16} />
        <span className="text-sm">Jarvis</span>
      </button>
      )}

      {/* Command Notes */}
      {onCommandNotes && (
        <button
          onClick={() => { vibrate(); onCommandNotes(); }}
          className="w-full px-3 py-1.5 rounded-brand-lg text-left flex items-center gap-2.5 transition duration-150 ease-out bg-surface hover:bg-surface-2 text-text active:scale-[0.99]"
        >
          <FileText className="text-brand-500" size={16} />
          <span className="text-sm">{t("menu.commandNotes")}</span>
        </button>
      )}

      {/* Keyboard shortcuts — only meaningful with a physical keyboard */}
      {inputMode === "mouse" && (
        <button
          onClick={() => { vibrate(); closeMenu(); openShortcuts(); }}
          className="w-full px-3 py-1.5 rounded-brand-lg text-left flex items-center gap-2.5 transition duration-150 ease-out bg-surface hover:bg-surface-2 text-text active:scale-[0.99]"
        >
          <Keyboard className="text-brand-500" size={16} />
          <span className="text-sm">{t("shortcuts.menuLabel")}</span>
        </button>
      )}

      {/* Community */}
      {onCommunity && (
        <button
          onClick={() => { vibrate(); onCommunity(); }}
          className="w-full px-3 py-1.5 bg-surface hover:bg-surface-2 text-text rounded-brand-lg text-left flex items-center gap-2.5 transition duration-150 ease-out active:scale-[0.99]"
        >
          <Users className="text-brand-500" size={16} />
          <span className="text-sm">{t("menu.community")}</span>
        </button>
      )}

      {/* Codespace */}
      {codespaceInfo?.isCodespaces && onCodespace && (
        <button
          onClick={() => { vibrate(); onCodespace(); }}
          className="w-full px-3 py-1.5 bg-surface hover:bg-surface-2 text-text rounded-brand-lg text-left flex items-center gap-2.5 transition duration-150 ease-out active:scale-[0.99]"
        >
          <Sparkles className="text-brand-500" size={16} />
          <span className="text-sm">{t("menu.codespace")}</span>
        </button>
      )}

      {/* Reload app */}
      {/* Reload & Restart dropdown */}
      <div ref={powerMenuRef} className="rounded-brand-lg overflow-hidden">
        <button
          onClick={() => { vibrate(); setPowerMenuOpen((v) => !v); }}
          className="w-full px-3 py-1.5 bg-surface hover:bg-surface-2 text-text text-left flex items-center gap-2.5 transition duration-150 ease-out active:scale-[0.99]"
        >
          <RefreshCw className="text-brand-500" size={16} />
          <span className="text-sm flex-1">{t("menu.reloadRestart")}</span>
          <ChevronDown className={`text-text-muted transition-transform duration-200 ${powerMenuOpen ? "rotate-180" : ""}`} size={16} />
        </button>
        {powerMenuOpen && (
          <div className="bg-surface-2/50 px-3 pb-1.5 space-y-0">
            {/* The page takes a moment to tear down before it visibly reloads; without
                the spin the tap looks like it did nothing. */}
            <button
              onClick={() => { vibrate(); setReloading(true); setTimeout(() => window.location.reload(), 150); }}
              disabled={reloading}
              className="w-full py-1.5 text-text text-left flex items-center gap-2.5 rounded-brand transition duration-150 ease-out hover:text-brand-500 active:scale-[0.99] disabled:opacity-70"
            >
              <RefreshCw size={16} className={`ml-3 ${reloading ? "animate-spin" : ""}`} />
              <span className="text-sm">{t("menu.reload")}</span>
            </button>
            {onRestart && (
              <button
                onClick={() => { vibrate(); setPowerMenuOpen(false); onRestart(); }}
                className="w-full py-1.5 text-text text-left flex items-center gap-2.5 rounded-brand transition duration-150 ease-out hover:text-brand-500 active:scale-[0.99]"
              >
                <RotateCw size={16} className="ml-3" />
                <span className="text-sm">{t("menu.restartHost")}</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Agent switcher — hidden from menu (managed from login). Re-enable by uncommenting.
      {savedKeys.length > 1 && (
        <div className="pt-2">
          <AgentSwitcher
            variant="menu"
            keys={savedKeys}
            currentApiKey={currentApiKey}
            onSelect={handleSwitchAgent}
            loadingKey={switchingKey}
          />
          {switchError && (
            <p className="px-2 pt-1.5 text-xs text-danger">{switchError}</p>
          )}
        </div>
      )}
      */}

      {/* Back to Host / Pair Device (Agent integrated only) */}
      {(isLoopbackOrigin() || (typeof window !== "undefined" && window.__TAURI__)) && (
        <button
          onClick={() => { vibrate(); window.location.href = "/"; }}
          className="w-full px-3 py-1.5 bg-surface hover:bg-surface-2 text-text rounded-brand-lg text-left flex items-center gap-2.5 transition duration-150 ease-out active:scale-[0.99]"
        >
          <QrCode className="text-brand-500" size={16} />
          <span className="text-sm">Pair Device</span>
        </button>
      )}

      {/* Logout */}
      {onLogout && (
        <button
          onClick={() => { vibrate(); onLogout(); }}
          className="w-full px-3 py-1.5 bg-surface hover:bg-red-500/15 text-text hover:text-red-400 rounded-brand-lg text-left flex items-center gap-2.5 transition duration-150 ease-out active:scale-[0.99]"
        >
          <LogOut className="text-red-400" size={16} />
          <span className="text-sm">{t("menu.logout")}</span>
        </button>
      )}

      {/* Version mismatch warning */}
      {isOutdated && <AgentOutdatedBanner agentVersion={agentVersion} webVersion={webVersion} className="mt-3" />}

      {/* Version + connection mode */}
      <div className="flex items-center justify-end gap-2 mt-4 mr-1">
        {connectionMode === "local" && (
          <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-green-500/15 text-green-400">
            LAN
          </span>
        )}
        <p className="text-text-muted text-sm">
          {t("menu.version")} {webVersion}{agentVersion ? ` / 9Remote ${agentVersion}` : ""}
        </p>
      </div>

    </div>
  );
}
