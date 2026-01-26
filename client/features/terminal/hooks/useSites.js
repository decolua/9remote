import { useState, useCallback } from "react";

/**
 * Custom hook for managing sites (load and open with proxy)
 * Reusable across Terminal and SitesList components
 */
export function useSites(tunnelUrl, apiKey) {
  const [sites, setSites] = useState([]);
  const [loading, setLoading] = useState(false);

  // Load sites from API
  const loadSites = useCallback(async () => {
    if (!tunnelUrl || !apiKey) return;
    setLoading(true);
    try {
      const response = await fetch(`${tunnelUrl}/api/local-sites`, {
        headers: { "Authorization": `Bearer ${apiKey}` }
      });
      if (response.ok) {
        const data = await response.json();
        setSites(data);
      }
    } catch (error) {
      console.error("Failed to load sites:", error);
    } finally {
      setLoading(false);
    }
  }, [tunnelUrl, apiKey]);

  // Open site in new window with proxy session
  const openSite = useCallback(async (site) => {
    const { port } = site;
    const proxyUrl = `${tunnelUrl}/proxy/${port}/`;
    
    // Open blank window first (synchronous - prevents popup blocking)
    const windowRef = window.open("about:blank", `_proxy_${port}`);
    
    if (!windowRef) {
      alert("Popup blocked! Please allow popups for this site.");
      return false;
    }

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
      return true;
    } catch (err) {
      console.error("Failed to start proxy session:", err);
      alert(`Failed to start proxy session for ${site.name}`);
      windowRef.close();
      return false;
    }
  }, [tunnelUrl, apiKey]);

  return {
    sites,
    loading,
    loadSites,
    openSite
  };
}
