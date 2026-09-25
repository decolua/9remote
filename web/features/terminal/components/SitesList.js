"use client";

import { useState, useEffect, useRef } from "react";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";
import { Globe, X, Trash2, RefreshCw, Loader2, Pencil, Check, ChevronRight } from "@/shared/components/ui/Icon";
import { useSlideMenuStore } from "@/shared/stores/slideMenuStore";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { useSessionStorage } from "@/shared/hooks/useSessionStorage";
import { useI18n } from "@/shared/i18n";
import { getCustomPorts, saveCustomPorts, getSiteLabels, saveSiteLabels } from "@/features/terminal/lib/sitesStorage";

const SOCKET_SITES_TIMEOUT_MS = 8000;
const PROXY_START_TIMEOUT_MS = 5000;

// Returns null when the bus path is unavailable so the caller can fall back to the tunnel.
function fetchSitesOverSocket(busRef) {
  const bus = busRef?.current;
  if (!bus?.connected) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), SOCKET_SITES_TIMEOUT_MS);
    bus.emit("getLocalSites", (result) => {
      clearTimeout(timer);
      resolve(Array.isArray(result?.sites) ? result.sites : null);
    });
  });
}

async function fetchSitesOverTunnel(tunnelUrl, apiKey) {
  if (!tunnelUrl) return null;
  const response = await fetch(`${tunnelUrl}/api/local-sites`, {
    headers: { "Authorization": `Bearer ${apiKey}` }
  }).catch(() => null);
  if (!response?.ok) return null;
  return response.json();
}

// The proxy needs a real HTTP origin: prefer the LAN address, fall back to the tunnel.
function resolveProxyBase(tunnelUrl, localIp) {
  const canUseLan = localIp && typeof window !== "undefined" && window.location.protocol !== "https:";
  if (canUseLan) return `http://${localIp}`;
  return tunnelUrl || null;
}

// Toggles a proxy session on the agent. Socket first so it works without a live tunnel.
// Starting returns the session id that addresses the site — the URL is no longer
// derivable from the port, which is what stopped it being guessable.
async function setProxySession(action, { busRef, base, apiKey, port }) {
  const bus = busRef?.current;
  if (bus?.connected) {
    if (action !== "start") {
      bus.emit("endProxySession", port);
      return true;
    }
    const viaSocket = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), PROXY_START_TIMEOUT_MS);
      bus.emit("startProxySession", port, (reply) => {
        clearTimeout(timer);
        // An agent from before session ids answers {ok:true} with no id. It
        // still opened the session, and its /proxy/ still keys on the port —
        // so fall through and let the HTTP call report what that agent does.
        resolve(reply?.sessionId || null);
      });
    });
    if (viaSocket) return viaSocket;
  }
  if (!base) return false;
  const response = await fetch(`${base}/api/proxy/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({ port })
  }).catch(() => null);
  if (!response?.ok) return false;
  if (action !== "start") return true;
  const data = await response.json().catch(() => null);
  // No id means an agent that still routes /proxy/ by port — the session did
  // open, so hand back the port and let the caller build that URL.
  return data?.sessionId || String(port);
}

export default function SitesList({ tunnelUrl, apiKey, busRef, siteHostKey = null, onSelectSite, isOpen: externalIsOpen, onClose: externalOnClose }) {
  const { t } = useI18n();
  const pushView = useTerminalStore((s) => s.pushView);
  const { getAuth } = useSessionStorage();
  const [customPorts, setCustomPorts] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [openedWindows, setOpenedWindows] = useState({});
  const [newPort, setNewPort] = useState("");
  const [confirmDialog, setConfirmDialog] = useState({ isOpen: false });
  const [siteLabels, setSiteLabels] = useState({});
  const [editingPort, setEditingPort] = useState(null);
  const [editingValue, setEditingValue] = useState("");
  const checkIntervalsRef = useRef({});

  // Get sites state from store (shared across all instances)
  const cachedSites = useSlideMenuStore((s) => s.cachedSites);
  const currentSites = useSlideMenuStore((s) => s.currentSites);
  const loadingSites = useSlideMenuStore((s) => s.loadingSites);
  const setCachedSites = useSlideMenuStore((s) => s.setCachedSites);
  const setCurrentSites = useSlideMenuStore((s) => s.setCurrentSites);
  const setLoadingSites = useSlideMenuStore((s) => s.setLoadingSites);

  // Use external control if provided, otherwise use internal state
  const isModalOpen = externalIsOpen !== undefined ? externalIsOpen : showModal;
  const handleCloseModal = externalOnClose || (() => setShowModal(false));

  const loadSites = async () => {
    // Only show loading if we don't have cached or current data
    if (!currentSites || currentSites.length === 0) {
      setLoadingSites(true);
    }
    try {
      // Socket first: the tunnel URL may be stale or absent on an RTC-only session
      const sites = await fetchSitesOverSocket(busRef) ?? await fetchSitesOverTunnel(tunnelUrl, apiKey);
      if (!sites) {
        console.error("[SitesList] unable to load local sites (no bus, tunnel unreachable)");
        return;
      }
      setCurrentSites(sites);
      setCachedSites(sites); // Cache to store
    } catch (error) {
      console.error("Failed to load local sites:", error);
    } finally {
      setLoadingSites(false);
    }
  };

  // End all active proxy sessions and close popups
  const endAllActiveSessions = async () => {
    const ports = Object.keys(openedWindows);
    // Clear intervals + close popups
    ports.forEach((port) => {
      const interval = checkIntervalsRef.current[port];
      if (interval) {
        clearInterval(interval);
        delete checkIntervalsRef.current[port];
      }
      const win = openedWindows[port];
      if (win && !win.closed) win.close();
    });
    if (ports.length === 0) return;
    setOpenedWindows({});
    // End sessions on agent in parallel
    const base = resolveProxyBase(tunnelUrl, getAuth()?.localIp);
    await Promise.all(ports.map((port) =>
      setProxySession("end", { busRef, base, apiKey, port: Number(port) }).catch(() => {})
    ));
  };

  useEffect(() => {
    if (isModalOpen) {
      setCustomPorts(getCustomPorts());
      setSiteLabels(getSiteLabels());
      // Show cached sites immediately if we don't have current sites
      if ((!currentSites || currentSites.length === 0) && cachedSites && cachedSites.length > 0) {
        setCurrentSites(cachedSites);
        setLoadingSites(false); // Don't show loading if we have cache
      }
      // Then load fresh data in background
      loadSites();
    } else {
      // Modal closed → revoke all proxy access
      endAllActiveSessions();
    }
  }, [isModalOpen]);

  const handleSelectSite = async (site) => {
    const { port } = site;
    // Inside the workspace, the in-app site view (SW over the transport bus) replaces the popup.
    // Store-only overlay (never in the URL) — see OVERLAY_VIEWS in routeConfig.
    const inWorkspace = typeof window !== "undefined" && window.location.pathname.startsWith("/workspace");
    if (inWorkspace && busRef?.current?.connected) {
      busRef.current.emit("startProxySession", port);
      pushView({ type: "site", port, path: "/", hostKey: siteHostKey });
      onSelectSite?.(site);
      handleCloseModal();
      return;
    }
    const base = resolveProxyBase(tunnelUrl, getAuth()?.localIp);
    if (!base) {
      alert(t("sites.startProxyFailed", { name: site.name }));
      return;
    }
    
    // If window already open, focus it
    if (openedWindows[port] && !openedWindows[port].closed) {
      openedWindows[port].focus();
      return;
    }

    // Open blank window first (synchronous - prevents popup blocking)
    const windowRef = window.open('about:blank', `_proxy_${port}`);
    
    if (!windowRef) {
      alert(t("sites.popupBlocked"));
      return;
    }
    
    // Track window
    setOpenedWindows(prev => ({ ...prev, [port]: windowRef }));

    // Start proxy session
    const sessionId = await setProxySession("start", { busRef, base, apiKey, port }).catch(() => false);
    if (!sessionId) {
      console.error("[SitesList] Failed to start proxy session for port", port);
      alert(t("sites.startProxyFailed", { name: site.name }));
      windowRef.close();
      setOpenedWindows(prev => {
        const updated = { ...prev };
        delete updated[port];
        return updated;
      });
      return;
    }

    windowRef.location.href = `${base}/proxy/${sessionId}/`;
    onSelectSite?.(site);

    // Start polling to check if window is closed
    checkIntervalsRef.current[port] = setInterval(async () => {
      if (windowRef.closed) {
        clearInterval(checkIntervalsRef.current[port]);
        delete checkIntervalsRef.current[port];
        
        setOpenedWindows(prev => {
          const updated = { ...prev };
          delete updated[port];
          return updated;
        });

        await setProxySession("end", { busRef, base, apiKey, port })
          .catch((err) => console.error(`[SitesList] Cleanup failed for port ${port}:`, err));
      }
    }, 1000);
  };

  const handleClose = () => {
    handleCloseModal();
    setNewPort("");
  };

  // Close modal on Escape key when not editing port label
  useEffect(() => {
    if (!isModalOpen) return;
    const onKey = (e) => {
      if (e.key === "Escape" && editingPort === null) {
        e.preventDefault();
        e.stopPropagation();
        if (externalOnClose) externalOnClose();
        else setShowModal(false);
        setNewPort("");
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [isModalOpen, editingPort, externalOnClose]);

  // Add custom port
  const handleAddPort = () => {
    const port = parseInt(newPort, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      return;
    }
    // Check if port already exists in auto-detected or custom
    const existsInAuto = currentSites.some(s => s.port === port);
    const existsInCustom = customPorts.includes(port);
    if (existsInAuto || existsInCustom) {
      // Open existing port
      handleSelectSite({ port, name: `Port ${port}`, protocol: "http", isCustom: true });
      setNewPort("");
      return;
    }
    // Add new custom port
    const updated = [...customPorts, port];
    setCustomPorts(updated);
    saveCustomPorts(updated);
    setNewPort("");
    // Open immediately
    handleSelectSite({ port, name: `Port ${port}`, protocol: "http", isCustom: true });
  };

  // Start editing label for a port
  const handleStartEdit = (port, currentLabel) => {
    setEditingPort(port);
    setEditingValue(currentLabel || "");
  };

  // Save label edit
  const handleSaveEdit = () => {
    if (editingPort == null) return;
    const trimmed = editingValue.trim();
    const updated = { ...siteLabels };
    if (trimmed) {
      updated[editingPort] = trimmed;
    } else {
      delete updated[editingPort];
    }
    setSiteLabels(updated);
    saveSiteLabels(updated);
    setEditingPort(null);
    setEditingValue("");
  };

  // Cancel editing
  const handleCancelEdit = () => {
    setEditingPort(null);
    setEditingValue("");
  };

  // Remove custom port
  const handleRemovePort = (port) => {
    setConfirmDialog({
      isOpen: true,
      title: t("sites.removePortTitle"),
      message: t("sites.removePortMessage", { port }),
      onConfirm: () => {
        const updated = customPorts.filter(p => p !== port);
        setCustomPorts(updated);
        saveCustomPorts(updated);
      }
    });
  };

  // Cleanup all intervals on unmount
  useEffect(() => {
    return () => {
      Object.values(checkIntervalsRef.current).forEach(interval => {
        clearInterval(interval);
      });
    };
  }, []);

  return (
    <>
      {/* Trigger Button - only show if not externally controlled */}
      {externalIsOpen === undefined && (
        <button
          onClick={() => setShowModal(true)}
          className="px-3 sm:px-4 py-2 bg-surface-2 hover:bg-surface-3 text-text text-sm font-medium rounded-brand transition-all duration-150 ease-out active:scale-[0.97] flex items-center gap-2"
        >
          <Globe className="text-brand-500" size={16} />
          <span className="hidden sm:inline">{t("sites.title")}</span>
        </button>
      )}

      {/* Modal Overlay */}
      {isModalOpen && (
        <div 
          className="fixed inset-0 bg-black/60 backdrop-blur-[2px] z-[60] flex items-center justify-center p-4 animate-in fade-in duration-200 modal-overlay"
          onClick={handleClose}
        >
          {/* Modal Content */}
          <div 
            className="card-elev w-full max-w-md max-h-[85vh] flex flex-col animate-in zoom-in-95 slide-in-from-bottom-4 duration-300"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 shrink-0">
              <div>
                <h2 className="text-lg font-semibold text-orange-400">{t("sites.localSites")}</h2>
                <p className="text-sm text-text-muted mt-0.5">{t("sites.selectSitePreview")}</p>
              </div>
              <button
                onClick={handleClose}
                className="p-2 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-colors"
              >
                <X size={20} />
              </button>
            </div>

            {/* Add Port - moved to top so keyboard doesn't cover it */}
            <div className="px-4 py-3 border-b border-border shrink-0">
              <div className="flex gap-2 items-center">
                <span className="text-text-muted text-sm whitespace-nowrap">http://localhost:</span>
                <input
                  type="number"
                  value={newPort}
                  onChange={(e) => setNewPort(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAddPort()}
                  placeholder={t("sites.portPlaceholder")}
                  min="1"
                  max="65535"
                  className="flex-1 px-3 py-2 bg-surface-2 rounded-brand text-text placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-brand-500/40 text-sm min-w-0 transition-all duration-150 ease-out"
                />
                <button
                  onClick={handleAddPort}
                  disabled={!newPort}
                  className="px-4 py-2 bg-brand-500 hover:bg-brand-600 disabled:bg-surface-2 disabled:cursor-not-allowed text-text text-sm font-medium rounded-brand transition-all duration-200 shadow-lg shadow-brand-500/20"
                >
                  {t("sites.open")}
                </button>
              </div>
            </div>

            {/* Body - scrollable list */}
            <div 
              className="p-4 modal-scrollable overflow-y-auto"
              style={{ maxHeight: "40vh" }}
            >
            {loadingSites ? (
              <div className="flex items-center justify-center py-8">
                <div className="flex items-center gap-3 text-brand-500">
                  <Loader2 className="animate-spin" size={20} />
                  <span>{t("sites.loadingSites")}</span>
                </div>
              </div>
            ) : currentSites.length === 0 ? (
                <div className="text-center py-8">
                  <div className="w-12 h-12 mx-auto mb-3 rounded-brand-lg bg-surface-2 flex items-center justify-center">
                    <Globe className="text-text-muted" size={24} />
                  </div>
                  <p className="text-text font-medium">{t("sites.noSitesFound")}</p>
                  <p className="text-text-muted text-sm mt-1">{t("sites.startServerHint")}</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {/* Custom ports - displayed first */}
                  {customPorts
                    .filter(port => !currentSites.some(s => s.port === port))
                    .map((port) => {
                      const isEditing = editingPort === port;
                      const displayName = siteLabels[port] || t("common.new");
                      return (
                        <div
                          key={`custom-${port}`}
                          className="w-full px-4 py-3 bg-surface-2 hover:bg-surface-3 rounded-brand-lg transition-all duration-150 ease-out active:scale-[0.99] group flex items-center justify-between gap-2"
                        >
                          <button
                            onClick={() => !isEditing && handleSelectSite({ port, name: displayName, protocol: "http", isCustom: true })}
                            className="flex-1 flex items-center gap-3 text-left min-w-0"
                          >
                            <div className="w-2.5 h-2.5 rounded-full bg-surface-2 shrink-0" />
                            <div className="min-w-0 flex-1">
                              {isEditing ? (
                                <input
                                  type="text"
                                  value={editingValue}
                                  onChange={(e) => setEditingValue(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") handleSaveEdit();
                                    if (e.key === "Escape") handleCancelEdit();
                                  }}
                                  onClick={(e) => e.stopPropagation()}
                                  autoFocus
                                  placeholder={t("sites.siteNamePlaceholder")}
                                  className="w-full px-2 py-1 bg-surface ring-2 ring-brand-500/40 rounded-brand text-text text-sm focus:outline-none transition-all duration-150"
                                />
                              ) : (
                                <div className="text-text font-medium group-hover:text-brand-500 transition-colors truncate" title={displayName}>
                                  {displayName}
                                </div>
                              )}
                              <div className="text-xs text-text-muted mt-0.5 flex items-center gap-2">
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-medium uppercase bg-surface-2 text-text-muted">
                                  http
                                </span>
                                <span>Port {port}</span>
                              </div>
                            </div>
                          </button>
                          {isEditing ? (
                            <button
                              onClick={(e) => { e.stopPropagation(); handleSaveEdit(); }}
                              className="p-2 text-brand-500 hover:text-text hover:bg-surface-2 rounded-brand transition-colors shrink-0"
                              title={t("sites.saveTitle")}
                            >
                              <Check size={16} />
                            </button>
                          ) : (
                            <button
                              onClick={(e) => { e.stopPropagation(); handleStartEdit(port, siteLabels[port]); }}
                              className="p-2 text-text-muted hover:text-brand-500 hover:bg-surface-2 rounded-brand transition-colors shrink-0"
                              title={t("sites.editNameTitle")}
                            >
                              <Pencil size={16} />
                            </button>
                          )}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRemovePort(port);
                            }}
                            className="p-2 text-text-muted hover:text-red-400 hover:bg-surface-2 rounded-brand transition-colors shrink-0"
                            title={t("sites.removeTitle")}
                          >
                            <Trash2 size={16} />
                          </button>
                          {!isEditing && (
                            <ChevronRight className="text-text-muted group-hover:text-brand-500 transition-colors shrink-0" size={20} />
                          )}
                        </div>
                      );
                    })}

                  {/* Auto-detected sites */}
                  {currentSites.map((site) => {
                    const isEditing = editingPort === site.port;
                    const displayName = siteLabels[site.port] || site.name;
                    return (
                      <div
                        key={`auto-${site.port}`}
                        className="w-full px-4 py-3 bg-surface-2 hover:bg-surface-3 rounded-brand-lg transition-all duration-150 ease-out active:scale-[0.99] group flex items-center justify-between gap-2"
                      >
                        <button
                          onClick={() => !isEditing && handleSelectSite({ ...site, name: displayName })}
                          className="flex-1 flex items-center gap-3 text-left min-w-0"
                        >
                          <div className="w-2.5 h-2.5 rounded-full bg-green-500 animate-pulse shrink-0" />
                          <div className="min-w-0 flex-1">
                            {isEditing ? (
                              <input
                                type="text"
                                value={editingValue}
                                onChange={(e) => setEditingValue(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") handleSaveEdit();
                                  if (e.key === "Escape") handleCancelEdit();
                                }}
                                onClick={(e) => e.stopPropagation()}
                                autoFocus
                                placeholder={site.name}
                                className="w-full px-2 py-1 bg-surface ring-2 ring-brand-500/40 rounded-brand text-text text-sm focus:outline-none transition-all duration-150"
                              />
                            ) : (
                              <div className="text-text font-medium group-hover:text-brand-500 transition-colors truncate" title={displayName}>
                                {displayName}
                              </div>
                            )}
                            <div className="text-xs text-text-muted mt-0.5 flex items-center gap-2">
                              <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium uppercase ${
                                site.protocol === "https"
                                  ? "bg-green-500/20 text-green-400"
                                  : "bg-blue-500/20 text-blue-400"
                              }`}>
                                {site.protocol}
                              </span>
                              <span>Port {site.port}</span>
                            </div>
                          </div>
                        </button>
                        {isEditing ? (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleSaveEdit(); }}
                            className="p-2 text-brand-500 hover:text-text hover:bg-surface-2 rounded-brand transition-colors shrink-0"
                            title={t("sites.saveTitle")}
                          >
                            <Check size={16} />
                          </button>
                        ) : (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleStartEdit(site.port, siteLabels[site.port]); }}
                            className="p-2 text-text-muted hover:text-brand-500 hover:bg-surface-2 rounded-brand transition-colors shrink-0"
                            title={t("sites.editNameTitle")}
                          >
                            <Pencil size={16} />
                          </button>
                        )}
                        {!isEditing && (
                          <ChevronRight className="text-text-muted group-hover:text-brand-500 transition-colors shrink-0" size={20} />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-5 py-3 border-t border-border flex items-center justify-between shrink-0">
              <span className="text-xs text-text-muted">
                {currentSites.length > 0 ? t("sites.foundCount", { n: currentSites.length, suffix: currentSites.length > 1 ? "s" : "" }) : ""}
              </span>
              <button
                onClick={loadSites}
                disabled={loadingSites}
                className="flex items-center gap-2 px-3 py-1.5 text-sm text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-colors disabled:opacity-50"
              >
                <RefreshCw className={loadingSites ? "animate-spin text-brand-500" : ""} size={16} />
                {t("sites.refresh")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm Dialog */}
      <ConfirmDialog
        isOpen={confirmDialog.isOpen}
        onClose={() => setConfirmDialog({ isOpen: false })}
        onConfirm={confirmDialog.onConfirm}
        title={confirmDialog.title}
        message={confirmDialog.message}
      />
    </>
  );
}
