"use client";

import { useEffect, useCallback, useState } from "react";
import { X, Sparkles, Square, ChevronLeft, Loader2, Sun, Moon } from "@/shared/components/ui/Icon";
import { useSlideMenuStore } from "@/shared/stores/slideMenuStore";
import MenuItems from "@/features/terminal/components/MenuItems";
import PwaInstallGuide from "@/features/terminal/components/PwaInstallGuide";
import { usePwaInstallStore } from "@/shared/stores/pwaInstallStore";
import SitesList from "@/features/terminal/components/SitesList";
import CommandNotesPanel from "@/features/terminal/components/CommandNotes/CommandNotesPanel";
import CommunityModal from "@/features/terminal/components/CommunityModal";
import LanguageModal from "@/shared/components/ui/LanguageModal";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import { SUPPORTED_LOCALES } from "@/shared/i18n/config";
import { useTheme } from "@/shared/theme/ThemeProvider";

/**
 * SlideMenu - Global full-screen menu that slides from right to left
 * Uses Zustand store for state management
 */
export default function SlideMenu() {
  const { t, locale } = useI18n();
  const currentLocale = SUPPORTED_LOCALES.find((l) => l.code === locale) || SUPPORTED_LOCALES[0];
  const {
    isOpen,
    activePanel,
    context,
    callbacks,
    close,
    setActivePanel,
    openMenu,
  } = useSlideMenuStore();

  // Chromium sets canInstall via beforeinstallprompt; iOS Safari/Firefox stay false.
  const install = usePwaInstallStore((s) => s.install);
  const canInstall = usePwaInstallStore((s) => s.canInstall);
  const isInstalled = usePwaInstallStore((s) => s.isInstalled);

  const [sitesModalOpen, setSitesModalOpen] = useState(false);
  const [commandNotesOpen, setCommandNotesOpen] = useState(false);
  const [communityOpen, setCommunityOpen] = useState(false);
  const [languageOpen, setLanguageOpen] = useState(false);
  const { theme: appTheme, toggleTheme } = useTheme();

  // Prevent body scroll when menu is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [isOpen]);

  // Close on Escape key
  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === "Escape" && isOpen) {
        close();
      }
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen, close]);

  // Panel-specific handlers
  const handleOpenPwa = useCallback(() => setActivePanel("pwa"), [setActivePanel]);
  const handleOpenCodespace = useCallback(() => setActivePanel("codespace"), [setActivePanel]);

  const handleBack = useCallback(() => {
    vibrate();
    setActivePanel("menu");
  }, [setActivePanel]);

  // Menu action handlers - close menu after action
  const handleRemote = useCallback(() => {
    close();
    callbacks.onRemote?.();
  }, [close, callbacks]);

  const handleFiles = useCallback(() => {
    close();
    callbacks.onFiles?.();
  }, [close, callbacks]);

  const handleSites = useCallback(() => {
    close();
    setSitesModalOpen(true);
    callbacks.onSites?.();
  }, [close, callbacks]);

  // Chromium: trigger native install dialog directly. Otherwise open the
  // manual guide panel (iOS Safari / Firefox / pre-engagement).
  const handleInstallApp = useCallback(() => {
    if (canInstall) {
      close();
      install();
    } else {
      handleOpenPwa();
    }
  }, [canInstall, close, install, handleOpenPwa]);

  const handleCodespace = useCallback(() => {
    handleOpenCodespace();
  }, [handleOpenCodespace]);

  const handleLogout = useCallback(() => {
    // Close menu first, then call logout callback
    // Logout callback may show confirm dialog, so we close menu first
    close();
    // Use setTimeout to ensure menu is closed before callback runs
    setTimeout(() => {
      callbacks.onLogout?.();
    }, 50);
  }, [close, callbacks]);

  const handleThemeChange = useCallback((theme) => {
    callbacks.onThemeChange?.(theme);
  }, [callbacks]);

  const handleStopCodespace = useCallback(() => {
    close();
    callbacks.onStopCodespace?.();
  }, [close, callbacks]);

  // Host update/restart: confirm dialog shows after menu closes
  const handleUpdate = useCallback(() => {
    close();
    setTimeout(() => callbacks.onUpdate?.(), 50);
  }, [close, callbacks]);

  const handleRestart = useCallback(() => {
    close();
    setTimeout(() => callbacks.onRestart?.(), 50);
  }, [close, callbacks]);

  const handleCloseSitesModal = useCallback(() => {
    setSitesModalOpen(false);
  }, []);

  const handleCommandNotes = useCallback(() => {
    close();
    setCommandNotesOpen(true);
  }, [close]);

  const handleCloseCommandNotes = useCallback(() => {
    setCommandNotesOpen(false);
  }, []);

  const handleCommunity = useCallback(() => {
    close();
    setCommunityOpen(true);
  }, [close]);

  const handleCloseCommunity = useCallback(() => {
    setCommunityOpen(false);
  }, []);

  if (!isOpen) {
    return (
      <>
        <SitesList
          tunnelUrl={context.tunnelUrl}
          socketRef={context.socketRef}
          apiKey={context.apiKey}
          isOpen={sitesModalOpen}
          onClose={handleCloseSitesModal}
        />
        <CommandNotesPanel
          isOpen={commandNotesOpen}
          onClose={handleCloseCommandNotes}
        />
        <CommunityModal
          isOpen={communityOpen}
          onClose={handleCloseCommunity}
        />
      </>
    );
  }

  // Get title based on active panel
  const getTitle = () => {
    switch (activePanel) {
      case "pwa":
        return t("pwa.title");
      case "codespace":
        return t("codespace.title");
      default:
        return t("menu.title");
    }
  };

  // Show back button for sub-panels
  const showBackButton = activePanel !== "menu";

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop - more transparent to see behind */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-[2px] fade-in"
        onClick={close}
      />

      {/* Menu Panel - slides from right */}
      <div
        className="absolute top-0 right-0 bottom-0 w-[85vw] sm:w-96 max-w-md bg-surface border-l border-border shadow-2xl flex flex-col slide-in-right"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2">
            {showBackButton && (
              <button
                onClick={handleBack}
                className="p-1 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-colors mr-1"
                aria-label={t("common.back")}
              >
                <ChevronLeft size={20} />
              </button>
            )}
            <h2 className="text-lg font-semibold text-text">{getTitle()}</h2>
            {activePanel === "menu" && (() => {
              const isRtc = context.transport && context.transport !== "ws";
              return (
                <span
                  className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                    isRtc
                      ? "bg-blue-500/15 text-blue-400 border border-blue-500/30"
                      : "bg-yellow-500/15 text-yellow-500 border border-yellow-500/30"
                  }`}
                  title={`Transport: ${isRtc ? `WebRTC (${context.transport})` : "WebSocket"}`}
                >
                  {isRtc ? "RTC" : "WS"}
                </span>
              );
            })()}
          </div>
          <div className="flex items-center gap-1">
            {activePanel === "menu" && (
              <>
                <button
                  onClick={() => { vibrate(); toggleTheme(); }}
                  className="p-2 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-colors"
                  aria-label={t("menu.theme")}
                  title={t("menu.theme")}
                >
                  {appTheme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
                </button>
                <button
                  onClick={() => { vibrate(); setLanguageOpen(true); }}
                  className="px-2 py-1.5 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-colors flex items-center gap-1.5 text-sm font-medium"
                  aria-label={t("menu.language")}
                  title={t("menu.language")}
                >
                  <img src={`https://flagcdn.com/w40/${currentLocale.country}.png`} alt={currentLocale.label} className="w-[17px] h-[12px] object-cover rounded-[2px]" loading="lazy" />
                  <span className="uppercase">{currentLocale.code}</span>
                </button>
              </>
            )}
            <button
              onClick={close}
              className="p-2 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-colors"
              aria-label={t("common.close")}
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Content - scrollable */}
        <div className="flex-1 overflow-y-auto modal-scrollable">
          {activePanel === "menu" && (
            <MenuItems
              onRemote={context.remoteAvailable ? handleRemote : null}
              onFiles={handleFiles}
              onSites={handleSites}
              onInstallApp={handleInstallApp}
              canInstall={canInstall}
              isInstalled={isInstalled}
              onCodespace={context.codespaceInfo?.isCodespaces ? handleCodespace : null}
              onLogout={handleLogout}
              connected={context.connected}
              remoteAvailable={context.remoteAvailable}
              codespaceInfo={context.codespaceInfo}
              showTheme={context.showTheme}
              theme={context.theme}
              onThemeChange={handleThemeChange}
              hideActions={context.hideActions || []}
              socketRef={context.socketRef}
              subscribeToPush={context.subscribeToPush}
              unsubscribeFromPush={context.unsubscribeFromPush}
              onUpdate={handleUpdate}
              onRestart={handleRestart}
            />
          )}

          {activePanel === "pwa" && <PwaInstallGuide />}

          {activePanel === "codespace" && (
            <CodespacePanel
              codespaceInfo={context.codespaceInfo}
              socketRef={context.socketRef}
              onStop={handleStopCodespace}
            />
          )}
        </div>
      </div>

      <SitesList
        tunnelUrl={context.tunnelUrl}
        socketRef={context.socketRef}
        apiKey={context.apiKey}
        isOpen={sitesModalOpen}
        onClose={handleCloseSitesModal}
      />
      <CommandNotesPanel
        isOpen={commandNotesOpen}
        onClose={handleCloseCommandNotes}
      />
      <CommunityModal
        isOpen={communityOpen}
        onClose={handleCloseCommunity}
      />
      <LanguageModal isOpen={languageOpen} onClose={() => setLanguageOpen(false)} />
    </div>
  );
}

/**
 * Codespace Panel Component
 */
function CodespacePanel({ codespaceInfo, socketRef, onStop }) {
  const { t } = useI18n();
  const [autoStart, setAutoStart] = useState(null); // null = loading, true/false = status
  const [toggling, setToggling] = useState(false);

  // Load auto start status on mount
  useEffect(() => {
    if (!socketRef?.current || !codespaceInfo?.isCodespaces) {
      // Not in codespaces or no socket, show OFF state
      if (codespaceInfo?.isCodespaces && !socketRef?.current) {
        console.log("CodespacePanel: socketRef not available");
      }
      setAutoStart(false);
      return;
    }
    
    socketRef.current.emit("getAutoStartStatus", (result) => {
      console.log("getAutoStartStatus result:", result);
      if (result.success) {
        setAutoStart(result.enabled);
      } else {
        setAutoStart(false);
      }
    });
  }, [socketRef, codespaceInfo]);

  // Toggle auto start
  const handleToggleAutoStart = useCallback(() => {
    if (!socketRef?.current || toggling) return;
    
    setToggling(true);
    const newValue = !autoStart;
    
    socketRef.current.emit("setAutoStart", { enabled: newValue }, (result) => {
      setToggling(false);
      if (result.success) {
        setAutoStart(result.enabled);
      }
    });
  }, [socketRef, autoStart, toggling]);

  if (!codespaceInfo) return null;

  return (
    <div className="p-5">
      {/* Info */}
      <div className="space-y-3 mb-6">
        <div className="flex items-center justify-between">
          <span className="text-text-muted text-sm">{t("codespace.name")}</span>
          <span className="text-text font-medium">{codespaceInfo.codespaceName || t("codespace.unknown")}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-text-muted text-sm">{t("codespace.status")}</span>
          <span className="text-green-400 font-medium flex items-center gap-1">
            <span className="w-2 h-2 bg-green-400 rounded-full" />
            {t("codespace.running")}
          </span>
        </div>
      </div>

      {/* Auto Start Toggle */}
      <div className="pt-4 border-t border-border mb-6">
        <div className="flex items-center justify-between py-3">
          <div>
            <span className="text-text text-sm font-medium">{t("codespace.autoStart")}</span>
            <p className="text-text-muted text-xs mt-0.5">{t("codespace.autoStartHint")}</p>
          </div>
          {autoStart === null ? (
            <Loader2 className="animate-spin text-text-muted" size={20} />
          ) : (
            <button
              onClick={handleToggleAutoStart}
              disabled={toggling}
              className={`relative w-12 h-6 rounded-full transition-colors ${
                autoStart ? "bg-brand-500" : "bg-surface-2"
              } ${toggling ? "opacity-50" : ""}`}
            >
              <span
                className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform ${
                  autoStart ? "left-7" : "left-1"
                }`}
              />
            </button>
          )}
        </div>
      </div>

      {/* Stop section */}
      <div className="pt-4 border-t border-border space-y-3">
        <button
          onClick={onStop}
          className="w-full py-2 bg-orange-600 hover:bg-orange-700 text-white font-medium rounded-brand transition flex items-center justify-center gap-2"
        >
          <Square size={16} />
          {t("codespace.stop")}
        </button>
        <p className="text-text text-sm flex items-start gap-2">
          <span className="text-yellow-400">💡</span>
          {t("codespace.stopHint")}
        </p>
        <p className="text-text-muted text-xs flex items-start gap-2">
          <span className="text-orange-400">⚠️</span>
          {t("codespace.restartHint")}
        </p>
      </div>
    </div>
  );
}
