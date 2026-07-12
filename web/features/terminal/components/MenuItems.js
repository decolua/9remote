"use client";

import { useState, useCallback, useEffect } from "react";
import { FolderOpen, Globe, Download, Sparkles, LogOut, Bell, Loader2, FileText, Users, RefreshCw, Monitor } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useSlideMenuStore } from "@/shared/stores/slideMenuStore";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { useI18n } from "@/shared/i18n";
import AgentOutdatedBanner, { isAgentOutdated, isWebOutdated } from "@/features/terminal/components/AgentOutdatedBanner";
import UpgradeButton from "@/features/terminal/components/UpgradeButton";

export default function MenuItems({
  onRemote,
  onFiles,
  onSites,
  onCommandNotes,
  onCommunity,
  onInstallApp,
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
  unsubscribeFromPush = null
}) {
  const { t } = useI18n();
  const { connectionMode = "tunnel", agentVersion } = useSlideMenuStore((s) => s.context);
  const webglEnabled = useTerminalStore((s) => s.webglEnabled);
  const setWebglEnabled = useTerminalStore((s) => s.setWebglEnabled);
  const webVersion = process.env.NEXT_PUBLIC_SERVER_VERSION;
  const isOutdated = isAgentOutdated(agentVersion, webVersion) || isWebOutdated(agentVersion, webVersion);

  // Treat native WebView (Expo) the same as PWA for UI gating
  const isExpoWebView = typeof window !== "undefined" && !!window.ReactNativeWebView;
  const isApp = typeof window !== "undefined" && (
    window.matchMedia("(display-mode: standalone)").matches || isExpoWebView
  );

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
      {/* Notifications switch - show in PWA or native app (Expo WebView) */}
      {isApp && (
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

      {/* WebGL renderer toggle — reload prompt (swap needs remount) */}
      <button
        onClick={() => { vibrate(); setWebglEnabled(!webglEnabled); }}
        className="w-full px-3 py-1.5 bg-surface hover:bg-surface-2 text-text rounded-brand-lg text-left flex items-center justify-between gap-2.5 transition-all duration-150 ease-out active:scale-[0.99]"
      >
        <div className="flex items-center gap-2.5">
          <Monitor className="text-brand-500" size={16} />
          <div className="flex flex-col">
            <span className="text-sm">{t("menu.webgl")}</span>
            <span className="text-xs text-text-muted">{t("menu.webglHint")}</span>
          </div>
        </div>
        <span className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${webglEnabled ? "bg-brand-500" : "bg-surface-2"}`}>
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${webglEnabled ? "translate-x-4" : "translate-x-0.5"}`} />
        </span>
      </button>


      {/* Files */}
      {!hideActions.includes('files') && onFiles && (
        <button
          onClick={() => { vibrate(); onFiles(); }}
          disabled={!connected}
          className={`w-full px-3 py-1.5 rounded-brand-lg text-left flex items-center gap-2.5 transition-all duration-150 ease-out ${
            connected
              ? "bg-surface hover:bg-surface-2 text-text active:scale-[0.99]"
              : "bg-surface/30 text-text-muted cursor-not-allowed"
          }`}
        >
          <FolderOpen className="text-brand-500" size={16} />
          <span className="text-sm">{t("menu.files")}</span>
        </button>
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

      {/* Install App - hide when running as PWA or native app */}
      {!isApp && onInstallApp && (
        <button
          onClick={() => { vibrate(); onInstallApp(); }}
          className="w-full px-3 py-1.5 bg-surface hover:bg-surface-2 text-text rounded-brand-lg text-left flex items-center gap-2.5 transition-all duration-150 ease-out active:scale-[0.99]"
        >
          <Download className="text-brand-500" size={16} />
          <span className="text-sm">{t("menu.installApp")}</span>
        </button>
      )}

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
      <button
        onClick={() => { vibrate(); window.location.reload(); }}
        className="w-full px-3 py-1.5 bg-surface hover:bg-surface-2 text-text rounded-brand-lg text-left flex items-center gap-2.5 transition-all duration-150 ease-out active:scale-[0.99]"
      >
        <RefreshCw className="text-brand-500" size={16} />
        <span className="text-sm">{t("menu.reload")}</span>
      </button>

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
          {t("menu.version")} {webVersion}{agentVersion ? ` / Agent ${agentVersion}` : ""}
        </p>
      </div>

    </div>
  );
}
