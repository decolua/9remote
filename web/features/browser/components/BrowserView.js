"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Globe, Home, Loader2, Plus, RotateCw, X } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { vibrate } from "@/shared/utils/vibration";
import { initSiteBridge, fetchLocalSites, parseSiteAddress } from "../lib/siteBridge";
import { SITE_NAV_EVENT, siteProxySrc } from "../constants/browserConfig";

let tabKeySeq = 0;
// Each tab carries its own history stack — the iframe's real history piles onto
// the parent's, which the view deliberately stays out of (OVERLAY_VIEWS).
const newTab = (port, path) => {
  const entry = { port, path: path || "/" };
  return { key: `site-${++tabKeySeq}`, port, path: entry.path, srcTick: 0, hist: [entry], histIdx: 0 };
};
const tabAddress = (tab) => (tab ? `localhost:${tab.port}${tab.path || "/"}` : "");
// Points at the shell on the sites origin, not at a path here: the browsed page
// must not share an origin with the app's stored credentials.
// A changed address is a changed document here — the tick forces the iframe to
// navigate rather than resolve to the same URL it already has.
const srcOf = (tab) => siteProxySrc(tab.port, tab.path, tab.srcTick);

export default function BrowserView({ busRef, connected = false, initialPort, initialPath, onBack }) {
  const { t } = useI18n();
  // One state object — tab list, active tab and address bar travel together
  const [state, setState] = useState(() => {
    if (!initialPort) return { tabs: [], activeKey: "", address: "" };
    const tab = newTab(initialPort, initialPath);
    return { tabs: [tab], activeKey: tab.key, address: tabAddress(tab) };
  });
  const [sites, setSites] = useState(null);
  const [loading, setLoading] = useState(false);
  const [portInput, setPortInput] = useState("");

  const { tabs, activeKey, address } = state;
  const activeTab = tabs.find((tab) => tab.key === activeKey) || null;

  // One proxy session per open port — ref'd so unmount ends only ports we started
  const startedPorts = useRef(new Set());
  const startSession = useCallback((port) => {
    if (startedPorts.current.has(port)) return;
    startedPorts.current.add(port);
    busRef?.current?.emit?.("startProxySession", port);
  }, [busRef]);
  const endSession = useCallback((port) => {
    startedPorts.current.delete(port);
    busRef?.current?.emit?.("endProxySession", port);
  }, [busRef]);

  useEffect(() => {
    initSiteBridge(busRef?.current);
  }, [busRef]);

  // Detected sites for the new-tab picker
  useEffect(() => {
    if (!connected || sites) return;
    let cancelled = false;
    fetchLocalSites(busRef?.current).then((result) => {
      if (!cancelled) setSites(result || []);
    });
    return () => { cancelled = true; };
  }, [connected, sites, busRef]);

  // Address bar follows in-iframe navigations reported by the SW; a genuinely
  // new address (e.g. a redirect) becomes a history entry
  useEffect(() => {
    const onNav = (e) => {
      const { port, path } = e.detail || {};
      if (!port) return;
      setState((prev) => ({
        tabs: prev.tabs.map((tab) => {
          if (tab.key !== prev.activeKey) return tab;
          const cur = tab.hist[tab.histIdx];
          if (cur && cur.port === port && cur.path === (path || "/")) return { ...tab, port, path };
          const hist = [...tab.hist.slice(0, tab.histIdx + 1), { port, path: path || "/" }];
          return { ...tab, port, path, hist, histIdx: hist.length - 1 };
        }),
        activeKey: prev.activeKey,
        address: `localhost:${port}${path || "/"}`
      }));
    };
    window.addEventListener(SITE_NAV_EVENT, onNav);
    return () => window.removeEventListener(SITE_NAV_EVENT, onNav);
  }, []);

  // End sessions for ports no longer open in any tab
  useEffect(() => {
    const open = new Set(tabs.map((tab) => tab.port));
    for (const port of [...startedPorts.current]) {
      if (!open.has(port)) endSession(port);
    }
  }, [tabs, endSession]);

  // Last-resort cleanup on unmount
  useEffect(() => () => {
    for (const port of startedPorts.current) {
      busRef?.current?.emit?.("endProxySession", port);
    }
    startedPorts.current.clear();
  }, [busRef]);

  const navigate = (port, path = "/") => {
    vibrate();
    startSession(port);
    setLoading(true);
    setState((prev) => {
      const existing = prev.tabs.find((tab) => tab.key === prev.activeKey);
      if (existing) {
        return {
          tabs: prev.tabs.map((tab) => {
            if (tab.key !== prev.activeKey) return tab;
            // Same address again is a reload, not a new history entry
            const cur = tab.hist[tab.histIdx];
            if (cur && cur.port === port && cur.path === path) {
              return { ...tab, port, path, srcTick: tab.srcTick + 1 };
            }
            const hist = [...tab.hist.slice(0, tab.histIdx + 1), { port, path }];
            return { ...tab, port, path, srcTick: tab.srcTick + 1, hist, histIdx: hist.length - 1 };
          }),
          activeKey: prev.activeKey,
          address: `localhost:${port}${path}`
        };
      }
      const tab = newTab(port, path);
      return { tabs: [...prev.tabs, tab], activeKey: tab.key, address: tabAddress(tab) };
    });
  };

  const submitAddress = () => {
    const parsed = parseSiteAddress(address, activeTab?.port);
    if (!parsed) return;
    navigate(parsed.port, parsed.path);
  };

  const closeTab = (key) => {
    vibrate();
    setState((prev) => {
      const idx = prev.tabs.findIndex((tab) => tab.key === key);
      const next = prev.tabs.filter((tab) => tab.key !== key);
      if (key !== prev.activeKey) return { ...prev, tabs: next };
      const fallback = next[Math.min(idx, next.length - 1)];
      return { tabs: next, activeKey: fallback?.key || "", address: tabAddress(fallback) };
    });
  };

  const reload = () => {
    if (!activeTab) return;
    vibrate();
    setLoading(true);
    setState((prev) => ({
      ...prev,
      tabs: prev.tabs.map((tab) => (tab.key === prev.activeKey ? { ...tab, srcTick: tab.srcTick + 1 } : tab))
    }));
  };

  // Walk the active tab's own history; the srcTick bump forces the iframe to
  // load the entry rather than stay on its current document
  const goHist = (delta) => {
    if (!activeTab) return;
    const idx = activeTab.histIdx + delta;
    const entry = activeTab.hist[idx];
    if (!entry) return;
    vibrate();
    startSession(entry.port);
    setLoading(true);
    setState((prev) => ({
      tabs: prev.tabs.map((tab) => (
        tab.key === prev.activeKey
          ? { ...tab, port: entry.port, path: entry.path, srcTick: tab.srcTick + 1, histIdx: idx }
          : tab
      )),
      activeKey: prev.activeKey,
      address: tabAddress(entry)
    }));
  };

  const goHome = () => {
    if (!activeTab) return;
    navigate(activeTab.port, "/");
  };

  const showPicker = () => {
    vibrate();
    setState((prev) => ({ ...prev, activeKey: "", address: "" }));
  };

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-surface text-text transition-all duration-300 ease-out animate-in slide-in-from-bottom">
      {/* Tab bar */}
      <div className="h-11 flex items-center gap-1 px-2 border-b border-border-subtle shrink-0 overflow-x-auto modal-scrollable">
        <button
          onClick={() => { vibrate(); onBack?.(); }}
          className="p-2 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-colors shrink-0"
          title={t("common.close")}
        >
          <ChevronLeft size={18} />
        </button>
        {tabs.map((tab) => (
          <div
            key={tab.key}
            className={`group flex items-center gap-1.5 pl-3 pr-1.5 h-8 rounded-brand text-xs cursor-pointer max-w-[160px] shrink-0 transition-colors ${
              tab.key === activeKey ? "bg-surface-3 text-text" : "bg-surface-2 text-text-muted hover:bg-surface-3"
            }`}
            onClick={() => setState((prev) => ({ ...prev, activeKey: tab.key, address: tabAddress(tab) }))}
          >
            <Globe size={13} className="shrink-0" />
            <span className="truncate">:{tab.port}</span>
            <button
              onClick={(e) => { e.stopPropagation(); closeTab(tab.key); }}
              className="p-0.5 rounded opacity-60 hover:opacity-100 hover:bg-surface shrink-0"
              title={t("common.close")}
            >
              <X size={12} />
            </button>
          </div>
        ))}
        <button
          onClick={showPicker}
          className="p-2 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-colors shrink-0"
          title={t("sites.browserNewTab")}
        >
          <Plus size={16} />
        </button>
        {loading && <Loader2 size={14} className="animate-spin text-brand-500 shrink-0 ml-1" />}
      </div>

      {/* Address bar */}
      <div className="h-11 flex items-center gap-1 px-2 border-b border-border-subtle shrink-0">
        <button
          onClick={() => goHist(-1)}
          disabled={!activeTab || activeTab.histIdx === 0}
          className="p-2 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-colors disabled:opacity-40 shrink-0"
          title={t("sites.goBack")}
        >
          <ChevronLeft size={16} />
        </button>
        <button
          onClick={() => goHist(1)}
          disabled={!activeTab || activeTab.histIdx >= activeTab.hist.length - 1}
          className="p-2 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-colors disabled:opacity-40 shrink-0"
          title={t("sites.goForward")}
        >
          <ChevronRight size={16} />
        </button>
        <button
          onClick={goHome}
          disabled={!activeTab}
          className="p-2 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-colors disabled:opacity-40 shrink-0"
          title={t("menu.home")}
        >
          <Home size={15} />
        </button>
        <input
          type="text"
          value={address}
          onChange={(e) => setState((prev) => ({ ...prev, address: e.target.value }))}
          onKeyDown={(e) => e.key === "Enter" && submitAddress()}
          placeholder={t("sites.browserAddressPlaceholder")}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="flex-1 min-w-0 px-3 py-1.5 bg-surface-2 rounded-brand text-sm text-text placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-brand-500/40"
        />
        <button
          onClick={reload}
          disabled={!activeTab}
          className="p-2 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-colors disabled:opacity-40 shrink-0"
          title={t("editor.reload")}
        >
          <RotateCw size={15} />
        </button>
      </div>

      {/* Content — every tab keeps its iframe (state survives tab switches) */}
      <div className="flex-1 min-h-0 bg-white relative">
        {!connected && (
          <div className="absolute inset-0 z-10 flex items-center justify-center text-sm text-text-muted bg-surface">
            {t("sites.browserNotConnected")}
          </div>
        )}
        {tabs.map((tab) => (
          <iframe
            key={tab.key}
            src={srcOf(tab)}
            title={`site-${tab.port}`}
            className={`w-full h-full border-0 absolute inset-0 ${tab.key === activeKey ? "" : "hidden"}`}
            onLoad={() => { if (tab.key === activeKey) setLoading(false); }}
          />
        ))}
        {!activeTab && (
          <div className="absolute inset-0 overflow-y-auto modal-scrollable p-4 max-w-md mx-auto bg-surface">
            <div className="flex items-center gap-2 mb-4">
              <span className="text-text-muted text-sm shrink-0">http://localhost:</span>
              <input
                type="number"
                value={portInput}
                onChange={(e) => setPortInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && portInput) navigate(Number(portInput)); }}
                placeholder={t("sites.portPlaceholder")}
                min="1"
                max="65535"
                className="flex-1 min-w-0 px-3 py-2 bg-surface-2 rounded-brand text-text text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/40"
              />
              <button
                onClick={() => portInput && navigate(Number(portInput))}
                disabled={!portInput}
                className="px-4 py-2 bg-brand-500 hover:bg-brand-600 disabled:bg-surface-2 disabled:cursor-not-allowed text-white text-sm font-medium rounded-brand transition-colors"
              >
                {t("sites.open")}
              </button>
            </div>
            {sites === null ? (
              <div className="flex items-center justify-center gap-2 py-8 text-brand-500 text-sm">
                <Loader2 size={16} className="animate-spin" />
                <span>{t("sites.loadingSites")}</span>
              </div>
            ) : sites.length === 0 ? (
              <div className="text-center py-8">
                <Globe size={24} className="text-text-muted mx-auto mb-2" />
                <p className="text-text text-sm font-medium">{t("sites.noSitesFound")}</p>
                <p className="text-text-muted text-xs mt-1">{t("sites.startServerHint")}</p>
              </div>
            ) : (
              <div className="space-y-2">
                {sites.map((site) => (
                  <button
                    key={site.port}
                    onClick={() => navigate(site.port)}
                    className="w-full px-4 py-3 bg-surface-2 hover:bg-surface-3 rounded-brand-lg transition-colors flex items-center gap-3 text-left"
                  >
                    <span className="w-2.5 h-2.5 rounded-full bg-green-500 animate-pulse shrink-0" />
                    <span className="flex-1 min-w-0">
                      <span className="block text-text font-medium truncate">{site.name}</span>
                      <span className="block text-xs text-text-muted mt-0.5">Port {site.port}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
