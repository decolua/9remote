"use client";

import { useState, useEffect, useCallback } from "react";
import { FolderOpen, Globe, Download, Sparkles, LogOut, Palette, Check, Bell, Loader2, FileText, AlertCircle, Users } from "@/shared/components/ui/Icon";
import { THEMES } from "@/features/terminal/constants/themes";
import { vibrate } from "@/shared/utils/vibration";
import { useSlideMenuStore } from "@/shared/stores/slideMenuStore";

/**
 * Shared menu items for SlideMenu (DRY)
 * Used by both SessionList and Terminal
 */
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
  hideActions = [], // Array of actions to hide: ['remote', 'files', 'sites']
  socketRef = null,
  subscribeToPush = null,
  unsubscribeFromPush = null
}) {
  const [expandedSection, setExpandedSection] = useState(null);
  const { connectionMode = "tunnel", agentVersion } = useSlideMenuStore((s) => s.context);
  const webVersion = process.env.NEXT_PUBLIC_SERVER_VERSION;
  const isOutdated = !agentVersion || (webVersion && agentVersion !== webVersion);

  const handleThemeChange = (newTheme) => {
    vibrate();
    if (onThemeChange) {
      onThemeChange(newTheme);
    }
    setExpandedSection(null);
  };

  // Notification hook state
  const [hookStatus, setHookStatus] = useState(null);
  const [togglingTool, setTogglingTool] = useState(null);
  const [pushEnabled, setPushEnabled] = useState(() => {
    if (typeof window !== "undefined" && "Notification" in window) {
      return Notification.permission === "granted";
    }
    return false;
  });
  const [pushLoading, setPushLoading] = useState(false);

  // Detect PWA mode (standalone = installed as PWA)
  const isPWA = typeof window !== "undefined" && window.matchMedia("(display-mode: standalone)").matches;

  // Load hook status on mount
  useEffect(() => {
    if (!socketRef?.current) return;
    socketRef.current.emit("getHookStatus", (status) => {
      setHookStatus(status);
    });
  }, [socketRef]);

  const handleEnablePush = useCallback(async () => {
    console.log("🔔 handleEnablePush called, subscribeToPush=", !!subscribeToPush, "pushLoading=", pushLoading);
    if (!subscribeToPush || pushLoading) return;
    setPushLoading(true);
    await subscribeToPush();
    setPushEnabled(Notification.permission === "granted");
    setPushLoading(false);
  }, [subscribeToPush, pushLoading]);

  const handleDisablePush = useCallback(async () => {
    if (!unsubscribeFromPush || pushLoading) return;
    setPushLoading(true);
    await unsubscribeFromPush();
    setPushEnabled(false);
    // Disable all hooks when push is disabled
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

  // Toggle hook for a tool
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
    <div className="p-4 space-y-2">
      {/* Theme - only for Terminal */}
      {showTheme && (
        <div className="border border-dark-400 rounded-brand-lg overflow-hidden menu-item-stagger-1">
          <button
            onClick={() => { vibrate(); setExpandedSection(expandedSection === "theme" ? null : "theme"); }}
            className="w-full px-4 py-3 bg-dark-700 hover:bg-dark-600 text-white text-left flex items-center justify-between transition-colors"
          >
            <div className="flex items-center gap-3">
              <Palette className="text-brand-500" size={20} />
              <span className="font-medium">Theme</span>
            </div>
            <span className="text-dark-100 text-sm">{theme.charAt(0).toUpperCase() + theme.slice(1)}</span>
          </button>
          {expandedSection === "theme" && (
            <div className="bg-dark-700/50 border-t border-dark-400 p-2 space-y-1 slide-in-top">
              {Object.keys(THEMES).map((t) => (
                <button
                  key={t}
                  onClick={() => handleThemeChange(t)}
                  className={`w-full px-3 py-2 text-left text-sm rounded-brand flex items-center justify-between transition-all duration-200 ${
                    theme === t ? "bg-brand-500 text-white" : "text-dark-50 hover:bg-dark-600"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="w-3 h-3 rounded-full border-2 border-dark-100" style={{ background: THEMES[t].background }} />
                    {t.charAt(0).toUpperCase() + t.slice(1)}
                  </div>
                  {theme === t && <Check size={16} />}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Notifications - only show in PWA mode */}
      {isPWA && <div className={`border border-dark-400 rounded-brand-lg overflow-hidden ${showTheme ? "menu-item-stagger-2" : "menu-item-stagger-1"}`}>
        <button
          onClick={() => { vibrate(); setExpandedSection(expandedSection === "notifications" ? null : "notifications"); }}
          className="w-full px-4 py-3 bg-dark-700 hover:bg-dark-600 text-white text-left flex items-center justify-between transition-colors"
        >
          <div className="flex items-center gap-3">
            <Bell className="text-brand-500" size={20} />
            <span className="font-medium">Notifications</span>
          </div>
          <span className="text-dark-100 text-sm">
            {pushEnabled && hookStatus ? Object.values(hookStatus).filter(s => s.enabled).length + " on" : ""}
          </span>
        </button>
        {expandedSection === "notifications" && (
          <div className="bg-dark-700/50 border-t border-dark-400 p-3 space-y-3 slide-in-top">
            {!pushEnabled ? (
              // Not subscribed → show Enable button
              <div className="space-y-2">
                <p className="text-dark-200 text-xs px-1">Enable push notifications to get alerted when AI completes tasks</p>
                <button
                  onClick={handleEnablePush}
                  disabled={pushLoading}
                  className="w-full py-2 px-3 bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-white text-sm font-medium rounded-brand flex items-center justify-center gap-2 transition-colors"
                >
                  {pushLoading ? <Loader2 className="animate-spin" size={16} /> : <Bell size={16} />}
                  Enable Push Notifications
                </button>
              </div>
            ) : (
              // Subscribed → show tool toggles + disable button
              <div className="space-y-2">
                {hookStatus ? (
                  ["claude", "codex", "gemini"].map((tool) => {
                    const status = hookStatus[tool];
                    if (!status?.installed) return null;
                    const toolNames = { claude: "Claude Code", codex: "Codex", gemini: "Gemini CLI" };
                    return (
                      <div key={tool} className="flex items-center justify-between py-1 px-1">
                        <span className="text-sm text-white">{toolNames[tool]}</span>
                        {togglingTool === tool ? (
                          <Loader2 className="animate-spin text-dark-100" size={18} />
                        ) : (
                          <button
                            onClick={() => handleToggleHook(tool)}
                            className={`relative w-10 h-5 rounded-full transition-colors ${status.enabled ? "bg-brand-500" : "bg-dark-400"}`}
                          >
                            <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-transform ${status.enabled ? "left-5" : "left-0.5"}`} />
                          </button>
                        )}
                      </div>
                    );
                  })
                ) : (
                  <div className="text-center py-1">
                    <Loader2 className="animate-spin text-dark-100 mx-auto" size={18} />
                  </div>
                )}
                <button
                  onClick={handleDisablePush}
                  disabled={pushLoading}
                  className="w-full py-1.5 px-3 bg-dark-600 hover:bg-dark-500 disabled:opacity-50 text-dark-100 text-xs rounded-brand flex items-center justify-center gap-2 transition-colors mt-1"
                >
                  {pushLoading ? <Loader2 className="animate-spin" size={14} /> : null}
                  Disable Push Notifications
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
          className={`w-full px-4 py-3 rounded-brand-lg text-left flex items-center gap-3 transition-colors border border-dark-400 ${
            showTheme ? "menu-item-stagger-3" : "menu-item-stagger-2"
          } ${
            connected
              ? "bg-dark-700 hover:bg-dark-600 text-white"
              : "bg-dark-700/30 text-dark-200 cursor-not-allowed"
          }`}
        >
          <FolderOpen className="text-brand-500" size={20} />
          <span className="font-medium">Files</span>
        </button>
      )}

      {/* Sites */}
      {!hideActions.includes('sites') && onSites && (
        <button
          onClick={() => { vibrate(); onSites(); }}
          disabled={!connected}
          className={`w-full px-4 py-3 rounded-brand-lg text-left flex items-center gap-3 transition-colors border border-dark-400 ${
            showTheme ? "menu-item-stagger-4" : "menu-item-stagger-3"
          } ${
            connected
              ? "bg-dark-700 hover:bg-dark-600 text-white"
              : "bg-dark-700/30 text-dark-200 cursor-not-allowed"
          }`}
        >
          <Globe className="text-brand-500" size={20} />
          <span className="font-medium">Sites</span>
        </button>
      )}

      {/* Command Notes */}
      {onCommandNotes && (
        <button
          onClick={() => { vibrate(); onCommandNotes(); }}
          className={`w-full px-4 py-3 rounded-brand-lg text-left flex items-center gap-3 transition-colors border border-dark-400 bg-dark-700 hover:bg-dark-600 text-white ${
            showTheme ? "menu-item-stagger-5" : "menu-item-stagger-4"
          }`}
        >
          <FileText className="text-brand-500" size={20} />
          <span className="font-medium">Command Notes</span>
        </button>
      )}

      {/* Community */}
      {onCommunity && (
        <button
          onClick={() => { vibrate(); onCommunity(); }}
          className={`w-full px-4 py-3 bg-dark-700 hover:bg-dark-600 text-white rounded-brand-lg text-left flex items-center gap-3 transition-colors border border-dark-400 ${
            showTheme ? "menu-item-stagger-6" : "menu-item-stagger-5"
          }`}
        >
          <Users className="text-brand-500" size={20} />
          <span className="font-medium">Community</span>
        </button>
      )}

      {/* Install App - only show when NOT in PWA mode */}
      {!isPWA && onInstallApp && (
        <button
          onClick={() => { vibrate(); onInstallApp(); }}
          className={`w-full px-4 py-3 bg-dark-700 hover:bg-dark-600 text-white rounded-brand-lg text-left flex items-center gap-3 transition-colors border border-dark-400 ${
            showTheme ? "menu-item-stagger-6" : "menu-item-stagger-5"
          }`}
        >
          <Download className="text-brand-500" size={20} />
          <span className="font-medium">Install App</span>
        </button>
      )}

      {/* Codespace */}
      {codespaceInfo?.isCodespaces && onCodespace && (
        <button
          onClick={() => { vibrate(); onCodespace(); }}
          className={`w-full px-4 py-3 bg-dark-700 hover:bg-dark-600 text-white rounded-brand-lg text-left flex items-center gap-3 transition-colors border border-dark-400 ${
            showTheme ? "menu-item-stagger-8" : "menu-item-stagger-7"
          }`}
        >
          <Sparkles className="text-brand-500" size={20} />
          <span className="font-medium">Codespace</span>
        </button>
      )}

      {/* Logout */}
      {onLogout && (
        <button
          onClick={() => { vibrate(); onLogout(); }}
          className={`w-full px-4 py-3 bg-dark-700 hover:bg-red-600 text-white rounded-brand-lg text-left flex items-center gap-3 transition-colors border border-dark-400 hover:border-red-500 ${
            showTheme ? "menu-item-stagger-8" : "menu-item-stagger-7"
          }`}
        >
          <LogOut className="text-red-400" size={20} />
          <span className="font-medium">Logout</span>
        </button>
      )}

      {/* Version mismatch warning */}
      {isOutdated && (
        <div className="mt-3 p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-brand-lg">
          <div className="flex items-start gap-2">
            <AlertCircle className="text-yellow-400 flex-shrink-0 mt-0.5" size={16} />
            <div className="text-xs space-y-1">
              <p className="text-yellow-300 font-medium">
                Agent {agentVersion ? `v${agentVersion}` : "version unknown"} is outdated
              </p>
              <p className="text-dark-100">
                Some features may not work. Run:
              </p>
              <code className="block bg-dark-700 text-brand-400 px-2 py-1 rounded text-xs select-all">
                npm i -g 9remote@latest
              </code>
            </div>
          </div>
        </div>
      )}

      {/* Version + connection mode */}
      <div className="flex items-center justify-end gap-2 mt-4 mr-1">
        {connectionMode === "local" && (
          <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-green-500/15 text-green-400 border border-green-500/30">
            LAN
          </span>
        )}
        <p className="text-dark-100 text-sm">
          Version {webVersion}{agentVersion ? ` / Agent ${agentVersion}` : ""}
        </p>
      </div>
    </div>
  );
}
