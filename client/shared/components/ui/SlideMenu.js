"use client";

import { useEffect, useCallback, useState } from "react";
import { X, Sparkles, Square, ChevronLeft, Loader2 } from "@/shared/components/ui/Icon";
import { useSlideMenuStore } from "@/shared/stores/slideMenuStore";
import MenuItems from "@/features/terminal/components/MenuItems";
import PwaInstallGuide from "@/features/terminal/components/PwaInstallGuide";
import SitesList from "@/features/terminal/components/SitesList";
import { vibrate } from "@/shared/utils/vibration";

/**
 * SlideMenu - Global full-screen menu that slides from right to left
 * Uses Zustand store for state management
 */
export default function SlideMenu() {
  const {
    isOpen,
    activePanel,
    context,
    callbacks,
    close,
    setActivePanel,
    openMenu,
  } = useSlideMenuStore();

  const [sitesModalOpen, setSitesModalOpen] = useState(false);

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

  const handleInstallApp = useCallback(() => {
    handleOpenPwa();
  }, [handleOpenPwa]);

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

  const handleCloseSitesModal = useCallback(() => {
    setSitesModalOpen(false);
  }, []);

  if (!isOpen) {
    return (
      <>
        {/* Sites Modal - Always rendered even when menu is closed */}
        <SitesList
          tunnelUrl={context.tunnelUrl}
          apiKey={context.apiKey}
          isOpen={sitesModalOpen}
          onClose={handleCloseSitesModal}
        />
      </>
    );
  }

  // Get title based on active panel
  const getTitle = () => {
    switch (activePanel) {
      case "pwa":
        return "Install as App";
      case "codespace":
        return "Codespace";
      default:
        return "Menu";
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
        className="absolute top-0 right-0 bottom-0 w-[85vw] sm:w-96 max-w-md bg-dark-600 border-l border-dark-400 shadow-2xl flex flex-col slide-in-right"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-dark-400 flex-shrink-0">
          <div className="flex items-center gap-2">
            {showBackButton && (
              <button
                onClick={handleBack}
                className="p-1 text-dark-100 hover:text-white hover:bg-dark-500 rounded-brand transition-colors mr-1"
                aria-label="Back"
              >
                <ChevronLeft size={20} />
              </button>
            )}
            <h2 className="text-lg font-semibold text-white">{getTitle()}</h2>
          </div>
          <button
            onClick={close}
            className="p-2 text-dark-100 hover:text-white hover:bg-dark-500 rounded-brand transition-colors"
            aria-label="Close menu"
          >
            <X size={20} />
          </button>
        </div>

        {/* Content - scrollable */}
        <div className="flex-1 overflow-y-auto modal-scrollable">
          {activePanel === "menu" && (
            <MenuItems
              onRemote={context.remoteAvailable ? handleRemote : null}
              onFiles={handleFiles}
              onSites={handleSites}
              onInstallApp={handleInstallApp}
              onCodespace={context.codespaceInfo?.isCodespaces ? handleCodespace : null}
              onLogout={handleLogout}
              connected={context.connected}
              remoteAvailable={context.remoteAvailable}
              codespaceInfo={context.codespaceInfo}
              showTheme={context.showTheme}
              theme={context.theme}
              onThemeChange={handleThemeChange}
              hideActions={context.hideActions || []}
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

      {/* Sites Modal - Shared across all contexts */}
      <SitesList
        tunnelUrl={context.tunnelUrl}
        apiKey={context.apiKey}
        isOpen={sitesModalOpen}
        onClose={handleCloseSitesModal}
      />
    </div>
  );
}

/**
 * Codespace Panel Component
 */
function CodespacePanel({ codespaceInfo, socketRef, onStop }) {
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
          <span className="text-dark-100 text-sm">Name</span>
          <span className="text-white font-medium">{codespaceInfo.codespaceName || "Unknown"}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-dark-100 text-sm">Status</span>
          <span className="text-green-400 font-medium flex items-center gap-1">
            <span className="w-2 h-2 bg-green-400 rounded-full" />
            Running
          </span>
        </div>
      </div>

      {/* Auto Start Toggle */}
      <div className="pt-4 border-t border-dark-400 mb-6">
        <div className="flex items-center justify-between py-3">
          <div>
            <span className="text-white text-sm font-medium">Auto Start 9Remote</span>
            <p className="text-dark-100 text-xs mt-0.5">Start 9Remote when codespace opens</p>
          </div>
          {autoStart === null ? (
            <Loader2 className="animate-spin text-dark-100" size={20} />
          ) : (
            <button
              onClick={handleToggleAutoStart}
              disabled={toggling}
              className={`relative w-12 h-6 rounded-full transition-colors ${
                autoStart ? "bg-brand-500" : "bg-dark-400"
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
      <div className="pt-4 border-t border-dark-400 space-y-3">
        <button
          onClick={onStop}
          className="w-full py-2 bg-orange-600 hover:bg-orange-700 text-white font-medium rounded-brand transition flex items-center justify-center gap-2"
        >
          <Square size={16} />
          Stop Codespace
        </button>
        <p className="text-dark-50 text-sm flex items-start gap-2">
          <span className="text-yellow-400">💡</span>
          Stop to save usage
        </p>
        <p className="text-dark-100 text-xs flex items-start gap-2">
          <span className="text-orange-400">⚠️</span>
          To restart, go to GitHub
        </p>
      </div>
    </div>
  );
}
