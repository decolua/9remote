"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { FolderOpen, Globe, Download, Sparkles, LogOut, Bell, Loader2, FileText, Users, RefreshCw, RotateCw, Monitor, Type, Palette, Terminal, ChevronDown, GitBranch, StickyNote } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useSlideMenuStore } from "@/shared/stores/slideMenuStore";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { useI18n } from "@/shared/i18n";
import { useTheme } from "@/shared/theme/ThemeProvider";
import { TERMINAL_THEME_OPTIONS } from "@/features/terminal/constants/themes";
import AgentOutdatedBanner, { isAgentOutdated, isWebOutdated } from "@/features/terminal/components/AgentOutdatedBanner";
import UpgradeButton from "@/features/terminal/components/UpgradeButton";

export default function MenuItems({
  onRemote,
  onFiles,
  onSites,
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
  socketRef = null,
  subscribeToPush = null,
  unsubscribeFromPush = null,
  onUpdate,
  onRestart
}) {
  const { t } = useI18n();
  const { connectionMode = "tunnel", agentVersion } = useSlideMenuStore((s) => s.context);
  const webglEnabled = useTerminalStore((s) => s.webglEnabled);
  const setWebglEnabled = useTerminalStore((s) => s.setWebglEnabled);
  const fontSize = useTerminalStore((s) => s.fontSize);
  const setFontSize = useTerminalStore((s) => s.setFontSize);
  const terminalTheme = useTerminalStore((s) => s.terminalTheme);
  const setTerminalTheme = useTerminalStore((s) => s.setTerminalTheme);
  const showFolderButton = useTerminalStore((s) => s.showFolderButton);
  const setShowFolderButton = useTerminalStore((s) => s.setShowFolderButton);
  const showGitButton = useTerminalStore((s) => s.showGitButton);
  const setShowGitButton = useTerminalStore((s) => s.setShowGitButton);
  const showNoteButton = useTerminalStore((s) => s.showNoteButton);
  const setShowNoteButton = useTerminalStore((s) => s.setShowNoteButton);
  const { theme: appMode } = useTheme();
  const [terminalMenuOpen, setTerminalMenuOpen] = useState(false);
  const [powerMenuOpen, setPowerMenuOpen] = useState(false);
  const terminalMenuRef = useRef(null);

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
  useEffect(() => { setIsMobile(window.innerWidth < 768); }, []);
  const webVersion = process.env.NEXT_PUBLIC_SERVER_VERSION;
  const isOutdated = isAgentOutdated(agentVersion, webVersion) || isWebOutdated(agentVersion, webVersion);

  // Treat native WebView (Expo) the same as PWA for UI gating
  const isExpoWebView = typeof window !== "undefined" && !!window.ReactNativeWebView;
  const isApp = typeof window !== "undefined" && (
    window.matchMedia("(display-mode: standalone)").matches || isExpoWebView
  );
  // WebPush available on any SW+PushManager browser (desktop included), not just installed PWA
  const pushSupported = !isExpoWebView &&
    typeof navigator !== "undefined" && "serviceWorker" in navigator && "PushManager" in window;

  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushLoading, setPushLoading] = useState(false);

  // Source of truth = actual push subscription, not Notification.permission (can't be revoked via JS)
  useEffect(() => {
    if (typeof window === "undefined" || isExpoWebView) return;
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager?.getSubscription())
      .then((sub) => setPushEnabled(!!sub))
      .catch(() => {});
  }, [isExpoWebView]);

  // Toggle push on/off; enable requests permission via subscribeToPush
  const handleTogglePush = useCallback(async () => {
    if (pushLoading) return;
    vibrate();
    setPushLoading(true);
    if (pushEnabled) {
      await unsubscribeFromPush?.();
      setPushEnabled(false);
    } else {
      await subscribeToPush?.();
      // Confirm via real subscription (Expo has no PushManager)
      let enabled = isExpoWebView;
      if (!isExpoWebView && "serviceWorker" in navigator && "PushManager" in window) {
        try {
          const reg = await navigator.serviceWorker.ready;
          enabled = !!(await reg.pushManager?.getSubscription());
        } catch { enabled = false; }
      }
      setPushEnabled(enabled);
    }
    setPushLoading(false);
  }, [pushEnabled, pushLoading, subscribeToPush, unsubscribeFromPush, isExpoWebView]);

  return (
    <div className="p-3 space-y-0.5">
      {/* Install App - pinned to top; hidden when running as PWA/native or already installed.
          Whole row is one button; a small brand chip on the right signals one-tap install on Chromium. */}
      {!isApp && !isInstalled && onInstallApp && (
        <button
          onClick={() => { vibrate(); onInstallApp(); }}
          className="w-full px-3 py-1.5 mb-1.5 bg-surface hover:bg-surface-2 text-text rounded-brand-lg text-left flex items-center gap-2.5 transition-all duration-150 ease-out active:scale-[0.99]"
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
      {pushSupported && (
        <button
          onClick={handleTogglePush}
          disabled={pushLoading}
          className="w-full px-3 py-1.5 bg-surface hover:bg-surface-2 disabled:opacity-50 text-text rounded-brand-lg text-left flex items-center justify-between gap-2.5 transition-all duration-150 ease-out active:scale-[0.99]"
        >
          <div className="flex items-center gap-2.5">
            <Bell className="text-brand-500" size={16} />
            <div className="flex flex-col">
              <span className="text-sm">{t("menu.notifications")}</span>
              <span className="text-xs text-text-muted">{t("menu.notificationsHint")}</span>
            </div>
          </div>
          {pushLoading ? (
            <Loader2 className="animate-spin text-text-muted" size={16} />
          ) : (
            <span className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${pushEnabled ? "bg-brand-500" : "bg-surface-2"}`}>
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${pushEnabled ? "translate-x-4" : "translate-x-0.5"}`} />
            </span>
          )}
        </button>
      )}

      {/* Terminal settings — collapsible dropdown (font + theme + GPU render) */}
      {!hideActions.includes('terminalSettings') && (
        <div ref={terminalMenuRef} className="bg-surface rounded-brand-lg overflow-hidden">
          <button
            onClick={() => { vibrate(); setTerminalMenuOpen((v) => !v); }}
            className="w-full px-3 py-1.5 hover:bg-surface-2 text-text text-left flex items-center gap-2.5 transition-all duration-150 ease-out active:scale-[0.99]"
          >
            <Terminal className="text-brand-500" size={16} />
            <span className="text-sm flex-1">{t("menu.terminalSettings")}</span>
            <ChevronDown className={`text-text-muted transition-transform duration-200 ${terminalMenuOpen ? "rotate-180" : ""}`} size={16} />
          </button>
          {terminalMenuOpen && (
            <div className="pl-6 pr-3 pb-1.5 space-y-1.5">
              <div className="flex items-center gap-2.5 pt-1.5">
                <Type className="text-brand-500" size={16} />
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
                <Palette className="text-brand-500" size={16} />
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
              <button
                onClick={() => { vibrate(); setWebglEnabled(!webglEnabled); }}
                className="w-full py-1 hover:bg-surface-2 text-text rounded-brand text-left flex items-center gap-2.5 transition-all duration-150 ease-out active:scale-[0.99]"
              >
                <Monitor className="text-brand-500" size={16} />
                <div className="flex flex-col flex-1">
                  <span className="text-sm">{t("menu.webgl")}</span>
                  <span className="text-xs text-text-muted">{t("menu.webglHint")}</span>
                </div>
                <span className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${webglEnabled ? "bg-brand-500" : "bg-surface-2"}`}>
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${webglEnabled ? "translate-x-4" : "translate-x-0.5"}`} />
                </span>
              </button>

              {/* Quick-action button visibility (folder / git / note) */}
              <div className="flex items-center gap-2.5 pt-1.5">
                <FolderOpen className="text-brand-500" size={16} />
                <span className="text-sm">{t("menu.showFolder")}</span>
                <button
                  onClick={() => { vibrate(); setShowFolderButton(!showFolderButton); }}
                  className={`ml-auto relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${showFolderButton ? "bg-brand-500" : "bg-surface-2"}`}
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${showFolderButton ? "translate-x-4" : "translate-x-0.5"}`} />
                </button>
              </div>
              <div className="flex items-center gap-2.5">
                <GitBranch className="text-brand-500" size={16} />
                <span className="text-sm">{t("menu.showGit")}</span>
                <button
                  onClick={() => { vibrate(); setShowGitButton(!showGitButton); }}
                  className={`ml-auto relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${showGitButton ? "bg-brand-500" : "bg-surface-2"}`}
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${showGitButton ? "translate-x-4" : "translate-x-0.5"}`} />
                </button>
              </div>
              <div className="flex items-center gap-2.5">
                <StickyNote className="text-brand-500" size={16} />
                <span className="text-sm">{t("menu.showNote")}</span>
                <button
                  onClick={() => { vibrate(); setShowNoteButton(!showNoteButton); }}
                  className={`ml-auto relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${showNoteButton ? "bg-brand-500" : "bg-surface-2"}`}
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${showNoteButton ? "translate-x-4" : "translate-x-0.5"}`} />
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Sites */}
      {!hideActions.includes('sites') && onSites && (
        <button
          onClick={() => { vibrate(); onSites(); }}
          disabled={!connected}
          className={`w-full px-3 py-1.5 rounded-brand-lg text-left flex items-center gap-2.5 transition-all duration-150 ease-out ${
            connected
              ? "bg-surface hover:bg-surface-2 text-text active:scale-[0.99]"
              : "bg-surface/30 text-text-muted cursor-not-allowed"
          }`}
        >
          <Globe className="text-brand-500" size={16} />
          <span className="text-sm">{t("menu.sites")}</span>
        </button>
      )}

      {/* Command Notes */}
      {onCommandNotes && (
        <button
          onClick={() => { vibrate(); onCommandNotes(); }}
          className="w-full px-3 py-1.5 rounded-brand-lg text-left flex items-center gap-2.5 transition-all duration-150 ease-out bg-surface hover:bg-surface-2 text-text active:scale-[0.99]"
        >
          <FileText className="text-brand-500" size={16} />
          <span className="text-sm">{t("menu.commandNotes")}</span>
        </button>
      )}

      {/* Community */}
      {onCommunity && (
        <button
          onClick={() => { vibrate(); onCommunity(); }}
          className="w-full px-3 py-1.5 bg-surface hover:bg-surface-2 text-text rounded-brand-lg text-left flex items-center gap-2.5 transition-all duration-150 ease-out active:scale-[0.99]"
        >
          <Users className="text-brand-500" size={16} />
          <span className="text-sm">{t("menu.community")}</span>
        </button>
      )}

      {/* IAP upgrade — mobile app only (web flow is separate) */}
      <UpgradeButton />

      {/* Codespace */}
      {codespaceInfo?.isCodespaces && onCodespace && (
        <button
          onClick={() => { vibrate(); onCodespace(); }}
          className="w-full px-3 py-1.5 bg-surface hover:bg-surface-2 text-text rounded-brand-lg text-left flex items-center gap-2.5 transition-all duration-150 ease-out active:scale-[0.99]"
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
          className="w-full px-3 py-1.5 bg-surface hover:bg-surface-2 text-text text-left flex items-center gap-2.5 transition-all duration-150 ease-out active:scale-[0.99]"
        >
          <RefreshCw className="text-brand-500" size={16} />
          <span className="text-sm flex-1">{t("menu.reloadRestart")}</span>
          <ChevronDown className={`text-text-muted transition-transform duration-200 ${powerMenuOpen ? "rotate-180" : ""}`} size={16} />
        </button>
        {powerMenuOpen && (
          <div className="bg-surface-2/50 px-3 pb-1.5 space-y-0">
            <button
              onClick={() => { vibrate(); window.location.reload(); }}
              className="w-full py-1.5 text-text text-left flex items-center gap-2.5 rounded-brand transition-all duration-150 ease-out hover:text-brand-500 active:scale-[0.99]"
            >
              <RefreshCw size={16} className="ml-3" />
              <span className="text-sm">{t("menu.reload")}</span>
            </button>
            {onRestart && (
              <button
                onClick={() => { vibrate(); setPowerMenuOpen(false); onRestart(); }}
                className="w-full py-1.5 text-text text-left flex items-center gap-2.5 rounded-brand transition-all duration-150 ease-out hover:text-brand-500 active:scale-[0.99]"
              >
                <RotateCw size={16} className="ml-3" />
                <span className="text-sm">{t("menu.restartHost")}</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Logout */}
      {onLogout && (
        <button
          onClick={() => { vibrate(); onLogout(); }}
          className="w-full px-3 py-1.5 bg-surface hover:bg-red-500/15 text-text hover:text-red-400 rounded-brand-lg text-left flex items-center gap-2.5 transition-all duration-150 ease-out active:scale-[0.99]"
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
