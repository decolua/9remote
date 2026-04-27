"use client";

import { useEffect, useRef } from "react";
import { ChevronLeft, Settings, Monitor, Plus } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useSlideMenuStore } from "@/shared/stores/slideMenuStore";
import { useI18n } from "@/shared/i18n";

export default function TerminalHeader({
  sessions = [],
  activeSessionId,
  connected,
  notifications = {},
  onSwitchSession,
  onCreateSession,
  onBack,
  onOpenRemote,
  onOpenFiles,
  onLogout,
  onStopCodespace,
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

  useEffect(() => {
    if (activeTabRef.current && tabsContainerRef.current) {
      activeTabRef.current.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    }
  }, [activeSessionId]);

  useEffect(() => {
    if (!isActive) return;
    setContext({
      connected,
      remoteAvailable: !!onOpenRemote,
      codespaceInfo,
      showTheme: false,
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
      onStopCodespace,
    });
  }, [isActive, connected, onOpenRemote, onOpenFiles, codespaceInfo, onLogout, onStopCodespace, tunnelUrl, apiKey, connectionMode, agentVersion, socketRef, subscribeToPush, unsubscribeFromPush, setContext, setCallbacks]);

  return (
    <div className="px-2 sm:px-4 pt-2 flex items-center gap-2 flex-shrink-0 bg-bg">
      <button
        onClick={() => { vibrate(); onBack(); }}
        className="p-1.5 bg-surface-2 hover:bg-surface-3 text-text rounded-brand transition-all duration-150 ease-out active:scale-[0.94] flex-shrink-0"
        title={t("common.back")}
      >
        <ChevronLeft size={18} />
      </button>

      {/* overflow-auto whitelists this for mobile touchmove (see page.js preventScroll) */}
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
                className={`px-2 py-1.5 text-sm font-medium transition-all duration-150 ease-out flex items-center gap-2 whitespace-nowrap ${
                  isActiveTab ? "border-brand-500 text-brand-500" : "border-transparent text-text-muted hover:text-text"
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
              className="sticky right-0 ml-1 p-1.5 bg-surface-2 hover:bg-surface-3 text-text-muted hover:text-text transition-all duration-150 ease-out active:scale-[0.94] disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0 rounded-brand"
              title={t("terminal.newTerminal")}
            >
              <Plus size={18} />
            </button>
          )}
        </div>
      </div>

      {onOpenRemote && (
        <button
          onClick={() => { vibrate(); onOpenRemote(); }}
          className="p-1.5 bg-surface-2 hover:bg-surface-3 text-text rounded-brand transition-all duration-150 ease-out active:scale-[0.94] flex-shrink-0"
          title={t("menu.remoteDesktop")}
        >
          <Monitor size={18} />
        </button>
      )}

      <button
        onClick={() => { vibrate(); openMenu(); }}
        className="p-1.5 bg-surface-2 hover:bg-surface-3 text-text rounded-brand transition-all duration-150 ease-out active:scale-[0.94] flex-shrink-0"
        title={t("menu.title")}
      >
        <Settings size={18} />
      </button>
    </div>
  );
}
