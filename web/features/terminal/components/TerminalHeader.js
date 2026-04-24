"use client";

import { useEffect, useRef } from "react";
import { ChevronLeft, Settings, Monitor, Plus } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useSlideMenuStore } from "@/shared/stores/slideMenuStore";
import { useI18n } from "@/shared/i18n";

// Shared header for all terminal panes - contains tabs + actions
export default function TerminalHeader({
  sessions = [],
  activeSessionId,
  connected,
  notifications = {},
  onSwitchSession,
  onCreateSession,
  onBack,
  onOpenRemote,
  // Menu context props
  onOpenFiles,
  onLogout,
  onStopCodespace,
  onThemeChange,
  theme,
  codespaceInfo,
  tunnelUrl,
  apiKey,
  connectionMode,
  subscribeToPush,
  unsubscribeFromPush,
  agentVersion,
  socketRef,
  isActive = true,
}) {
  const { t } = useI18n();
  const tabsContainerRef = useRef(null);
  const activeTabRef = useRef(null);
  const { open: openMenu, setContext, setCallbacks } = useSlideMenuStore();

  // Scroll active tab into view when switched
  useEffect(() => {
    if (activeTabRef.current && tabsContainerRef.current) {
      activeTabRef.current.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    }
  }, [activeSessionId]);

  // Set up SlideMenu context at page level (once)
  useEffect(() => {
    if (!isActive) return;
    setContext({
      connected,
      remoteAvailable: !!onOpenRemote,
      codespaceInfo,
      showTheme: true,
      theme,
      socketRef,
      tunnelUrl,
      apiKey,
      connectionMode,
      subscribeToPush,
      unsubscribeFromPush,
      agentVersion,
    });

    setCallbacks({
      onRemote: onOpenRemote,
      onFiles: onOpenFiles,
      onSites: null,
      onCodespace: null,
      onLogout,
      onThemeChange,
      onStopCodespace,
    });
  }, [isActive, connected, onOpenRemote, onOpenFiles, codespaceInfo, onLogout, onStopCodespace, theme, onThemeChange, tunnelUrl, apiKey, connectionMode, agentVersion, socketRef, subscribeToPush, unsubscribeFromPush, setContext, setCallbacks]);

  return (
    <div className="bg-dark-600 border-b border-dark-400 px-2 sm:px-4 py-2 flex items-center gap-2 flex-shrink-0">
      <button
        onClick={() => { vibrate(); onBack(); }}
        className="p-2 bg-dark-500 hover:bg-dark-400 text-white rounded-brand transition-all duration-200 border border-dark-400 hover:border-brand-500 flex-shrink-0"
        title={t("common.back")}
      >
        <ChevronLeft size={20} />
      </button>

      {/* Terminal Tabs - sticky "+" button stays visible when tabs overflow */}
      {/* overflow-auto class also whitelists this for mobile touchmove (see page.js preventScroll) */}
      <div ref={tabsContainerRef} className="flex-1 overflow-auto overflow-x-auto overflow-y-hidden scrollbar-thin scrollbar-thumb-dark-400 scrollbar-track-transparent">
        <div className="flex gap-0.5 min-w-max items-center">
          {sessions.map((session) => {
            const isActiveTab = session.id === activeSessionId;
            const hasNotif = !!notifications[session.id];
            return (
              <button
                key={session.id}
                ref={isActiveTab ? activeTabRef : null}
                onClick={() => {
                  vibrate();
                  onSwitchSession?.(session.id);
                }}
                className={`px-2 py-1 text-sm font-medium transition-colors duration-200 flex items-center gap-2 whitespace-nowrap ${
                  isActiveTab ? "text-brand-500" : "text-dark-50 hover:text-white"
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${hasNotif ? "bg-yellow-400 animate-pulse" : connected ? "bg-green-400" : "bg-red-400"}`} />
                <span className="truncate max-w-[120px]">{session.name || t("terminal.defaultName")}</span>
              </button>
            );
          })}
          {onCreateSession && (
            <button
              onClick={() => { vibrate(); onCreateSession(); }}
              disabled={!connected}
              className="sticky right-0 ml-1 p-1 bg-dark-500 text-dark-50 hover:text-white transition-colors duration-200 disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0 rounded-md"
              title={t("terminal.newTerminal")}
            >
              <Plus size={20} />
            </button>
          )}
        </div>
      </div>

      {onOpenRemote && (
        <button
          onClick={() => { vibrate(); onOpenRemote(); }}
          className="p-2 bg-dark-500 hover:bg-dark-400 text-white rounded-brand transition-all duration-200 border border-dark-400 hover:border-brand-500 flex-shrink-0"
          title={t("menu.remoteDesktop")}
        >
          <Monitor size={20} />
        </button>
      )}

      <button
        onClick={() => { vibrate(); openMenu(); }}
        className="p-2 bg-dark-500 hover:bg-dark-400 text-white rounded-brand transition-all duration-200 border border-dark-400 hover:border-brand-500 flex-shrink-0"
        title={t("menu.title")}
      >
        <Settings size={20} />
      </button>
    </div>
  );
}
