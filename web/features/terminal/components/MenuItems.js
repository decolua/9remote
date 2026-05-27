"use client";

import { useState, useEffect, useCallback } from "react";
import { FolderOpen, Globe, Download, Sparkles, LogOut, Bell, Loader2, FileText, AlertCircle, Users } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useSlideMenuStore } from "@/shared/stores/slideMenuStore";
import { useI18n } from "@/shared/i18n";

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
  const [expandedSection, setExpandedSection] = useState(null);
  const { t } = useI18n();
  const { connectionMode = "tunnel", agentVersion } = useSlideMenuStore((s) => s.context);
  const webVersion = process.env.NEXT_PUBLIC_SERVER_VERSION;
  const isOutdated = !agentVersion || (webVersion && agentVersion !== webVersion);

  const [hookStatus, setHookStatus] = useState(null);
  const [togglingTool, setTogglingTool] = useState(null);
  // Treat native WebView (Expo) the same as PWA for UI gating
  const isExpoWebView = typeof window !== "undefined" && !!window.ReactNativeWebView;
  const isApp = typeof window !== "undefined" && (
    window.matchMedia("(display-mode: standalone)").matches || isExpoWebView
  );

  const [pushEnabled, setPushEnabled] = useState(() => {
    if (typeof window === "undefined") return false;
    if (window.ReactNativeWebView) return false;
    if ("Notification" in window) return Notification.permission === "granted";
    return false;
  });
  const [pushLoading, setPushLoading] = useState(false);

  useEffect(() => {
    if (!socketRef?.current) return;
    socketRef.current.emit("getHookStatus", (status) => {
      setHookStatus(status);
    });
  }, [socketRef]);

  const handleEnablePush = useCallback(async () => {
    if (!subscribeToPush || pushLoading) return;
    setPushLoading(true);
    await subscribeToPush();
    // Expo: native handles permission; treat subscribe call as enabled.
    // PWA: rely on Notification API permission state.
    const granted = isExpoWebView ||
      (typeof Notification !== "undefined" && Notification.permission === "granted");
    setPushEnabled(granted);
    setPushLoading(false);
  }, [subscribeToPush, pushLoading, isExpoWebView]);

  const handleDisablePush = useCallback(async () => {
    if (!unsubscribeFromPush || pushLoading) return;
    setPushLoading(true);
    await unsubscribeFromPush();
    setPushEnabled(false);
    if (hookStatus && socketRef?.current) {
      for (const tool of Object.keys(hookStatus)) {
        if (hookStatus[tool]?.enabled) {
          socketRef.current.emit("disableHook", { tool }, () => {});
        }
      }
      setHookStatus(prev => Object.fromEntries(
        Object.entries(prev).map(([k, v]) => [k, { ...v, enabled: false }])
      ));
    }
    setPushLoading(false);
  }, [unsubscribeFromPush, pushLoading, hookStatus, socketRef]);

  const handleToggleHook = useCallback((tool) => {
    if (!socketRef?.current || togglingTool) return;
    setTogglingTool(tool);
    const isEnabled = hookStatus?.[tool]?.enabled;
    const event = isEnabled ? "disableHook" : "enableHook";
    socketRef.current.emit(event, { tool }, (result) => {
      setTogglingTool(null);
      if (result.success) {
        setHookStatus(prev => ({
          ...prev,
          [tool]: { ...prev[tool], enabled: !isEnabled }
        }));
      }
    });
  }, [socketRef, hookStatus, togglingTool]);

  return (
    <div className="p-3 space-y-0.5">
      {/* Notifications - show in PWA or native app (Expo WebView) */}
      {isApp && <div className="bg-surface rounded-brand-lg overflow-hidden">
        <button
          onClick={() => { vibrate(); setExpandedSection(expandedSection === "notifications" ? null : "notifications"); }}
          className="w-full px-3 py-1.5 hover:bg-surface-2 text-text text-left flex items-center justify-between transition-colors duration-150 ease-out"
        >
          <div className="flex items-center gap-2.5">
            <Bell className="text-brand-500" size={16} />
            <span className="text-sm">{t("menu.notifications")}</span>
          </div>
          <span className="text-text-muted text-xs">
            {pushEnabled && hookStatus ? `${Object.values(hookStatus).filter(s => s.enabled).length} ${t("common.on")}` : ""}
          </span>
        </button>
        {expandedSection === "notifications" && (
          <div className="bg-surface-2/50 p-3 space-y-3 slide-in-top">
            {!pushEnabled ? (
              <div className="space-y-2">
                <p className="text-text-muted text-xs px-1">{t("menu.pushHint")}</p>
                <button
                  onClick={handleEnablePush}
                  disabled={pushLoading}
                  className="w-full py-2 px-3 bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-white text-sm font-medium rounded-brand flex items-center justify-center gap-2 transition-colors"
                >
                  {pushLoading ? <Loader2 className="animate-spin" size={16} /> : <Bell size={16} />}
                  {t("menu.enablePush")}
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                {hookStatus ? (
                  ["claude", "codex", "gemini", "opencode"].map((tool) => {
                    const status = hookStatus[tool];
                    if (!status?.installed) return null;
                    const toolKeys = { claude: "claudeCode", codex: "codex", gemini: "geminiCli", opencode: "openCode" };
                    return (
                      <div key={tool} className="flex items-center justify-between py-1 px-1">
                        <span className="text-sm text-text">{t(`notifications.${toolKeys[tool]}`)}</span>
                        {togglingTool === tool ? (
                          <Loader2 className="animate-spin text-text-muted" size={18} />
                        ) : (
                          <button
                            onClick={() => handleToggleHook(tool)}
                            className={`relative w-10 h-5 rounded-full transition-colors ${status.enabled ? "bg-brand-500" : "bg-surface-2"}`}
                          >
                            <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-transform ${status.enabled ? "left-5" : "left-0.5"}`} />
                          </button>
                        )}
                      </div>
                    );
                  })
                ) : (
                  <div className="text-center py-1">
                    <Loader2 className="animate-spin text-text-muted mx-auto" size={18} />
                  </div>
                )}
                <button
                  onClick={handleDisablePush}
                  disabled={pushLoading}
                  className="w-full py-1.5 px-3 bg-surface hover:bg-surface-2 disabled:opacity-50 text-text-muted text-xs rounded-brand flex items-center justify-center gap-2 transition-colors mt-1"
                >
                  {pushLoading ? <Loader2 className="animate-spin" size={14} /> : null}
                  {t("menu.disablePush")}
                </button>
              </div>
            )}
          </div>
        )}
      </div>}


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
      {isOutdated && (
        <div className="mt-3 p-3 bg-yellow-500/10 rounded-brand-lg">
          <div className="flex items-start gap-2">
            <AlertCircle className="text-yellow-400 flex-shrink-0 mt-0.5" size={16} />
            <div className="text-xs space-y-1">
              <p className="text-yellow-300 font-medium">
                {t("menu.versionMismatch", { version: agentVersion ? `v${agentVersion}` : "?" })}
              </p>
              <p className="text-text-muted">
                {t("menu.versionMismatchHint")}
              </p>
              <code className="block bg-surface text-brand-400 px-2 py-1 rounded text-xs select-all">
                npm i -g 9remote@latest
              </code>
            </div>
          </div>
        </div>
      )}

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
