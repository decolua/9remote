"use client";

import { useState, useEffect, useRef } from "react";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";

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
        className="px-3 sm:px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white text-sm font-medium rounded transition flex items-center gap-2"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
        </svg>
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
            className="bg-slate-800 border border-slate-600 rounded-xl shadow-2xl w-full max-w-md max-h-[85vh] flex flex-col animate-in zoom-in-95 slide-in-from-bottom-4 duration-300"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700 shrink-0">
              <div>
                <h2 className="text-lg font-semibold text-white">Local Sites</h2>
                <p className="text-sm text-slate-400 mt-0.5">Select a site to preview</p>
              </div>
              <button
                onClick={handleClose}
                className="p-2 text-slate-400 hover:text-white hover:bg-slate-700 rounded-lg transition"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Add Port - moved to top so keyboard doesn't cover it */}
            <div className="px-4 py-3 border-b border-slate-700 shrink-0">
              <div className="flex gap-2 items-center">
                <span className="text-slate-400 text-sm whitespace-nowrap">http://localhost:</span>
                <input
                  type="number"
                  value={newPort}
                  onChange={(e) => setNewPort(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAddPort()}
                  placeholder="port"
                  min="1"
                  max="65535"
                  className="flex-1 px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:border-purple-500 text-sm min-w-0"
                />
                <button
                  onClick={handleAddPort}
                  disabled={!newPort}
                  className="px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-slate-600 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition"
                >
                  Open
                </button>
              </div>
            </div>

            {/* Body - scrollable list */}
            <div 
              className="p-4 modal-scrollable"
              style={{ maxHeight: "40vh" }}
            >
              {loading ? (
                <div className="flex items-center justify-center py-8">
                  <div className="flex items-center gap-3 text-slate-400">
                    <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    <span>Loading Sites...</span>
                  </div>
                </div>
              ) : sites.length === 0 ? (
                <div className="text-center py-8">
                  <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-slate-700 flex items-center justify-center">
                    <svg className="w-6 h-6 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 10h.01M15 10h.01M9.5 15a3.5 3.5 0 005 0" />
                    </svg>
                  </div>
                  <p className="text-slate-400 font-medium">No sites found</p>
                  <p className="text-slate-500 text-sm mt-1">Start a local dev server to see it here</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {/* Custom ports - displayed first */}
                  {customPorts
                    .filter(port => !sites.some(s => s.port === port))
                    .map((port) => (
                      <div
                        key={`custom-${port}`}
                        className="w-full px-4 py-3 bg-slate-700/50 hover:bg-slate-700 border border-slate-600 hover:border-slate-500 rounded-lg transition group flex items-center justify-between"
                      >
                        <button
                          onClick={() => handleSelectSite({ port, name: `Port ${port}`, protocol: "http", isCustom: true })}
                          className="flex-1 flex items-center gap-3 text-left"
                        >
                          <div className="w-2.5 h-2.5 rounded-full bg-slate-500" />
                          <div>
                            <div className="text-white font-medium group-hover:text-purple-300 transition">
                              Custom
                            </div>
                            <div className="text-xs text-slate-400 mt-0.5 flex items-center gap-2">
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium uppercase bg-slate-500/20 text-slate-400">
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
                          className="p-2 text-slate-500 hover:text-red-400 hover:bg-slate-600 rounded transition"
                          title="Remove"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      </div>
                    ))}

                  {/* Auto-detected sites */}
                  {sites.map((site) => (
                    <button
                      key={`auto-${site.port}`}
                      onClick={() => handleSelectSite(site)}
                      className="w-full px-4 py-3 text-left bg-slate-700/50 hover:bg-slate-700 border border-slate-600 hover:border-slate-500 rounded-lg transition group"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className="w-2.5 h-2.5 rounded-full bg-green-500 animate-pulse" />
                          <div>
                            <div className="text-white font-medium group-hover:text-purple-300 transition">
                              {site.name}
                            </div>
                            <div className="text-xs text-slate-400 mt-0.5 flex items-center gap-2">
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
                        <svg className="w-5 h-5 text-slate-500 group-hover:text-purple-400 transition" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-5 py-3 border-t border-slate-700 flex items-center justify-between shrink-0">
              <span className="text-xs text-slate-500">
                {sites.length > 0 ? `${sites.length} site${sites.length > 1 ? "s" : ""} found` : ""}
              </span>
              <button
                onClick={loadSites}
                disabled={loading}
                className="flex items-center gap-2 px-3 py-1.5 text-sm text-slate-400 hover:text-white hover:bg-slate-700 rounded-lg transition disabled:opacity-50"
              >
                <svg className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
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
