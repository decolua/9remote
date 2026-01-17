"use client";

import { useState, useEffect } from "react";

export default function SitesList({ tunnelUrl }) {
  const [sites, setSites] = useState([]);
  const [showList, setShowList] = useState(false);
  const [loading, setLoading] = useState(false);

  const loadSites = async () => {
    setLoading(true);
    try {
      const response = await fetch(`${tunnelUrl}/api/local-sites`);
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
    if (showList && sites.length === 0) {
      loadSites();
    }
  }, [showList]);

  const handleOpenSite = (port) => {
    // Use current client origin for proxy (same as where we're viewing the app)
    const proxyUrl = `${window.location.origin}/proxy/${port}/`;
    window.open(proxyUrl, "_blank");
  };

  return (
    <div className="relative">
      <button
        onClick={() => {
          setShowList(!showList);
          if (!showList && sites.length === 0) loadSites();
        }}
        className="px-2 sm:px-3 py-1 sm:py-1.5 bg-slate-700 hover:bg-slate-600 text-white text-xs sm:text-sm font-medium rounded transition flex items-center gap-1"
      >
        <span className="text-base">🌐</span>
        <span className="hidden sm:inline">Sites</span>
      </button>

      {showList && (
        <div className="absolute right-0 top-full mt-2 bg-slate-800 border border-slate-600 rounded-lg shadow-xl z-50 p-2 min-w-[180px]">
          {loading ? (
            <div className="px-3 py-2 text-sm text-slate-400">Loading...</div>
          ) : sites.length === 0 ? (
            <div className="px-3 py-2 text-sm text-slate-400">No sites found</div>
          ) : (
            <>
              {sites.map((site) => (
                <button
                  key={site.port}
                  onClick={() => handleOpenSite(site.port)}
                  className="w-full px-3 py-2 text-left text-sm text-slate-300 hover:bg-slate-700 rounded flex items-center gap-2"
                >
                  <span className="text-green-500">●</span>
                  {site.name}
                </button>
              ))}
              <div className="border-t border-slate-700 mt-2 pt-2">
                <button
                  onClick={loadSites}
                  className="w-full px-3 py-1 text-xs text-slate-400 hover:text-white"
                >
                  🔄 Refresh
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
