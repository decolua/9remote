"use client";

import { useState, useEffect, useRef } from "react";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";
import { Globe, X, Trash2, RefreshCw, Loader2 } from "@/shared/components/ui/Icon";

const CUSTOM_PORTS_KEY = "custom_ports";

// Load custom ports from localStorage
function getCustomPorts() {
  if (typeof window === "undefined") return [];
  try {
    const stored = localStorage.getItem(CUSTOM_PORTS_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

// Save custom ports to localStorage
function saveCustomPorts(ports) {
  if (typeof window === "undefined") return;
  localStorage.setItem(CUSTOM_PORTS_KEY, JSON.stringify(ports));
}

export default function SitesList({ tunnelUrl, apiKey }) {
  const [sites, setSites] = useState([]);
  const [customPorts, setCustomPorts] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [loading, setLoading] = useState(false);
  const [openedWindows, setOpenedWindows] = useState({});
  const [newPort, setNewPort] = useState("");
  const [confirmDialog, setConfirmDialog] = useState({ isOpen: false });
  const checkIntervalsRef = useRef({});

  const loadSites = async () => {
    setLoading(true);
    try {
      const response = await fetch(`${tunnelUrl}/api/local-sites`, {
        headers: {
          "Authorization": `Bearer ${apiKey}`
        }
      });
      if (response.ok) {
        const data = await response.json();
        setSites(data);
      }
    } catch (error) {
      console.error("Failed to load local sites:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (showModal) {
      setCustomPorts(getCustomPorts());
      loadSites();
    }
  }, [showModal]);

  const handleSelectSite = async (site) => {
    const { port } = site;
    const proxyUrl = `${tunnelUrl}/proxy/${port}/`;
    
    // If window already open, focus it
    if (openedWindows[port] && !openedWindows[port].closed) {
      openedWindows[port].focus();
      return;
    }

    // Open blank window first (synchronous - prevents popup blocking)
    const windowRef = window.open('about:blank', `_proxy_${port}`);
    
    if (!windowRef) {
      alert("Popup blocked! Please allow popups for this site.");
      return;
    }
    
    // Track window
    setOpenedWindows(prev => ({ ...prev, [port]: windowRef }));

    // Start proxy session
    try {
      await fetch(`${tunnelUrl}/api/proxy/start`, {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({ port })
      });
      
      // Navigate to proxy URL
      windowRef.location.href = proxyUrl;
    } catch (err) {
      console.error(`[SitesList] Failed to start proxy session:`, err);
      alert(`Failed to start proxy session for ${site.name}`);
      windowRef.close();
      setOpenedWindows(prev => {
        const updated = { ...prev };
        delete updated[port];
        return updated;
      });
      return;
    }

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

        // Call cleanup API
        try {
          await fetch(`${tunnelUrl}/api/proxy/end`, {
            method: "POST",
            headers: { 
              "Content-Type": "application/json",
              "Authorization": `Bearer ${apiKey}`
            },
            body: JSON.stringify({ port })
          });
        } catch (err) {
          console.error(`[SitesList] Cleanup failed for port ${port}:`, err);
        }
      }
    }, 1000);
  };

  const handleClose = () => {
    setShowModal(false);
    setNewPort("");
  };

  // Add custom port
  const handleAddPort = () => {
    const port = parseInt(newPort, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      return;
    }
    // Check if port already exists in auto-detected or custom
    const existsInAuto = sites.some(s => s.port === port);
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

  // Remove custom port
  const handleRemovePort = (port) => {
    setConfirmDialog({
      isOpen: true,
      title: "Remove Port",
      message: `Remove port ${port} from saved list?`,
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
      {/* Trigger Button */}
      <button
        onClick={() => setShowModal(true)}
        className="px-3 sm:px-4 py-2 bg-dark-500 hover:bg-dark-400 text-white text-sm font-medium rounded-brand transition-all duration-200 flex items-center gap-2 border border-dark-400 hover:border-brand-500"
      >
        <Globe className="text-brand-500" size={16} />
        <span className="hidden sm:inline">Sites</span>
      </button>

      {/* Modal Overlay */}
      {showModal && (
        <div 
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-in fade-in duration-200 modal-overlay"
          onClick={handleClose}
        >
          {/* Modal Content */}
          <div 
            className="bg-dark-600 border border-dark-400 rounded-brand-lg shadow-2xl w-full max-w-md max-h-[85vh] flex flex-col animate-in zoom-in-95 slide-in-from-bottom-4 duration-300"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-dark-400 shrink-0">
              <div>
                <h2 className="text-lg font-semibold text-white">Local Sites</h2>
                <p className="text-sm text-dark-100 mt-0.5">Select a site to preview</p>
              </div>
              <button
                onClick={handleClose}
                className="p-2 text-dark-100 hover:text-white hover:bg-dark-500 rounded-brand transition-colors"
              >
                <X size={20} />
              </button>
            </div>

            {/* Add Port - moved to top so keyboard doesn't cover it */}
            <div className="px-4 py-3 border-b border-dark-400 shrink-0">
              <div className="flex gap-2 items-center">
                <span className="text-dark-100 text-sm whitespace-nowrap">http://localhost:</span>
                <input
                  type="number"
                  value={newPort}
                  onChange={(e) => setNewPort(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAddPort()}
                  placeholder="port"
                  min="1"
                  max="65535"
                  className="flex-1 px-3 py-2 bg-dark-700 border border-dark-400 rounded-brand text-white placeholder-dark-100 focus:outline-none focus:ring-1 focus:ring-brand-500 focus:border-transparent text-sm min-w-0 transition-all duration-200"
                />
                <button
                  onClick={handleAddPort}
                  disabled={!newPort}
                  className="px-4 py-2 bg-brand-500 hover:bg-brand-600 disabled:bg-dark-500 disabled:cursor-not-allowed text-white text-sm font-medium rounded-brand transition-all duration-200 shadow-lg shadow-brand-500/20"
                >
                  Open
                </button>
              </div>
            </div>

            {/* Body - scrollable list */}
            <div 
              className="p-4 modal-scrollable overflow-y-auto"
              style={{ maxHeight: "40vh" }}
            >
              {loading ? (
                <div className="flex items-center justify-center py-8">
                  <div className="flex items-center gap-3 text-dark-100">
                    <Loader2 className="animate-spin" size={20} />
                    <span>Loading Sites...</span>
                  </div>
                </div>
              ) : sites.length === 0 ? (
                <div className="text-center py-8">
                  <div className="w-12 h-12 mx-auto mb-3 rounded-brand-lg bg-dark-500 flex items-center justify-center">
                    <Globe className="text-dark-100" size={24} />
                  </div>
                  <p className="text-dark-50 font-medium">No sites found</p>
                  <p className="text-dark-100 text-sm mt-1">Start a local dev server to see it here</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {/* Custom ports - displayed first */}
                  {customPorts
                    .filter(port => !sites.some(s => s.port === port))
                    .map((port) => (
                      <div
                        key={`custom-${port}`}
                        className="w-full px-4 py-3 bg-dark-700/50 hover:bg-dark-600 border border-dark-400 hover:border-brand-500 rounded-brand-lg transition-all duration-200 group flex items-center justify-between"
                      >
                        <button
                          onClick={() => handleSelectSite({ port, name: `Port ${port}`, protocol: "http", isCustom: true })}
                          className="flex-1 flex items-center gap-3 text-left"
                        >
                          <div className="w-2.5 h-2.5 rounded-full bg-dark-200" />
                          <div>
                            <div className="text-white font-medium group-hover:text-brand-500 transition-colors">
                              Custom
                            </div>
                            <div className="text-xs text-dark-100 mt-0.5 flex items-center gap-2">
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium uppercase bg-dark-500 text-dark-100">
                                http
                              </span>
                              <span>Port {port}</span>
                            </div>
                          </div>
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRemovePort(port);
                          }}
                          className="p-2 text-dark-100 hover:text-red-400 hover:bg-dark-500 rounded-brand transition-colors"
                          title="Remove"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    ))}

                  {/* Auto-detected sites */}
                  {sites.map((site) => (
                    <button
                      key={`auto-${site.port}`}
                      onClick={() => handleSelectSite(site)}
                      className="w-full px-4 py-3 text-left bg-dark-700/50 hover:bg-dark-600 border border-dark-400 hover:border-brand-500 rounded-brand-lg transition-all duration-200 group"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className="w-2.5 h-2.5 rounded-full bg-green-500 animate-pulse" />
                          <div>
                            <div className="text-white font-medium group-hover:text-brand-500 transition-colors">
                              {site.name}
                            </div>
                            <div className="text-xs text-dark-100 mt-0.5 flex items-center gap-2">
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
                        </div>
                        <svg className="w-5 h-5 text-dark-100 group-hover:text-brand-500 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-5 py-3 border-t border-dark-400 flex items-center justify-between shrink-0">
              <span className="text-xs text-dark-100">
                {sites.length > 0 ? `${sites.length} site${sites.length > 1 ? "s" : ""} found` : ""}
              </span>
              <button
                onClick={loadSites}
                disabled={loading}
                className="flex items-center gap-2 px-3 py-1.5 text-sm text-dark-100 hover:text-white hover:bg-dark-500 rounded-brand transition-colors disabled:opacity-50"
              >
                <RefreshCw className={loading ? "animate-spin" : ""} size={16} />
                Refresh
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
