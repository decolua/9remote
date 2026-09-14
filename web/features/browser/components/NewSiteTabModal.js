"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Globe, Loader2, Pencil, RefreshCw, Trash2, X } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { vibrate } from "@/shared/utils/vibration";
import { fetchLocalSites } from "../lib/siteBridge";
import { getCustomPorts, getSiteLabels, saveCustomPorts, saveSiteLabels } from "@/features/terminal/lib/sitesStorage";

// The new-tab sheet: pick a detected site, a saved port, or type one. Detection
// is the agent's own scan, so it can go stale while the sheet is open (a server
// started a moment ago) — hence the refresh, and hence the re-fetch on open.
export default function NewSiteTabModal({ isOpen, onClose, onOpenSite, busRef, connected }) {
  const { t } = useI18n();
  const [sites, setSites] = useState(null);
  const [customPorts, setCustomPorts] = useState([]);
  const [labels, setLabels] = useState({});
  const [portInput, setPortInput] = useState("");
  const [editing, setEditing] = useState(null); // port being renamed
  const [editValue, setEditValue] = useState("");
  const portRef = useRef(null);

  const loadSites = () => {
    if (!connected) return;
    setSites(null);
    fetchLocalSites(busRef?.current).then((result) => setSites(result || []));
  };

  useEffect(() => {
    if (!isOpen) return;
    setCustomPorts(getCustomPorts());
    setLabels(getSiteLabels());
    loadSites();
    // A sheet that opens on a phone should not also raise the keyboard.
    const timer = requestAnimationFrame(() => portRef.current?.focus());
    return () => cancelAnimationFrame(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, connected, busRef]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e) => {
      if (e.key !== "Escape" || editing !== null) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [isOpen, editing, onClose]);

  if (!isOpen || typeof document === "undefined") return null;

  const detected = sites || [];
  const seen = new Set(detected.map((s) => s.port));
  const nameOf = (site) => labels[site.port] || site.name || `Port ${site.port}`;

  const open = (port) => {
    vibrate();
    onOpenSite(Number(port));
    onClose();
  };

  const openTyped = () => {
    const port = parseInt(portInput, 10);
    if (isNaN(port) || port < 1 || port > 65535) return;
    // A port typed here is one the user wants to come back to.
    if (!seen.has(port) && !customPorts.includes(port)) {
      const next = [...customPorts, port];
      setCustomPorts(next);
      saveCustomPorts(next);
    }
    setPortInput("");
    open(port);
  };

  const removePort = (port) => {
    const next = customPorts.filter((p) => p !== port);
    setCustomPorts(next);
    saveCustomPorts(next);
  };

  const saveLabel = () => {
    if (editing == null) return;
    const trimmed = editValue.trim();
    const next = { ...labels };
    if (trimmed) next[editing] = trimmed;
    else delete next[editing];
    setLabels(next);
    saveSiteLabels(next);
    setEditing(null);
    setEditValue("");
  };

  // A saved port with no name is still worth showing — it is what the user added.
  const savedOnly = customPorts.filter((port) => !seen.has(port));

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center px-4"
      style={{ paddingTop: "max(1rem, env(safe-area-inset-top))", paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
    >
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[4px] animate-in fade-in duration-150" onClick={onClose} />

      <div
        role="dialog"
        aria-modal="true"
        className="relative card-elev w-full max-w-md max-h-[85vh] flex flex-col animate-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 shrink-0">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-text">{t("sites.newTabTitle")}</h2>
            <p className="text-sm text-text-muted mt-0.5 truncate">{t("sites.selectSitePreview")}</p>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-colors shrink-0"
            title={t("common.close")}
          >
            <X size={20} />
          </button>
        </div>

        {/* Port entry — above the list so the phone keyboard cannot cover it */}
        <div className="px-4 pb-3 border-b border-border shrink-0">
          <div className="flex gap-2 items-center">
            <span className="text-text-muted text-sm whitespace-nowrap">http://localhost:</span>
            <input
              ref={portRef}
              type="number"
              value={portInput}
              onChange={(e) => setPortInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && openTyped()}
              placeholder={t("sites.portPlaceholder")}
              min="1"
              max="65535"
              className="flex-1 px-3 py-2 bg-surface-2 rounded-brand text-text placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-brand-500/40 text-sm min-w-0 transition-all duration-150"
            />
            <button
              onClick={openTyped}
              disabled={!portInput}
              className="px-4 py-2 bg-brand-500 hover:bg-brand-600 disabled:bg-surface-2 disabled:cursor-not-allowed text-white text-sm font-medium rounded-brand transition-all duration-150"
            >
              {t("sites.open")}
            </button>
          </div>
        </div>

        <div className="p-4 overflow-y-auto modal-scrollable" style={{ maxHeight: "45vh" }}>
          {!connected ? (
            <div className="py-8 text-center text-sm text-text-muted">
              {t("sites.notConnected", { defaultValue: "Not connected to the agent" })}
            </div>
          ) : sites === null ? (
            <div className="flex items-center justify-center gap-2 py-8 text-brand-500 text-sm">
              <Loader2 size={16} className="animate-spin" />
              <span>{t("sites.loadingSites")}</span>
            </div>
          ) : (
            <div className="space-y-2">
              {savedOnly.map((port) => (
                <SiteRow
                  key={`saved-${port}`}
                  port={port}
                  label={nameOf({ port })}
                  detected={false}
                  editing={editing === port}
                  editValue={editValue}
                  onEditValue={setEditValue}
                  onStartEdit={() => { setEditing(port); setEditValue(labels[port] || ""); }}
                  onSaveEdit={saveLabel}
                  onCancelEdit={() => { setEditing(null); setEditValue(""); }}
                  onRemove={() => removePort(port)}
                  onOpen={() => open(port)}
                  t={t}
                />
              ))}
              {detected.map((site) => (
                <SiteRow
                  key={`auto-${site.port}`}
                  port={site.port}
                  label={nameOf(site)}
                  protocol={site.protocol}
                  detected
                  editing={editing === site.port}
                  editValue={editValue}
                  onEditValue={setEditValue}
                  onStartEdit={() => { setEditing(site.port); setEditValue(labels[site.port] || ""); }}
                  onSaveEdit={saveLabel}
                  onCancelEdit={() => { setEditing(null); setEditValue(""); }}
                  onOpen={() => open(site.port)}
                  t={t}
                />
              ))}
              {detected.length === 0 && savedOnly.length === 0 && (
                <div className="text-center py-8">
                  <Globe size={24} className="text-text-muted mx-auto mb-2" />
                  <p className="text-text text-sm font-medium">{t("sites.noSitesFound")}</p>
                  <p className="text-text-muted text-xs mt-1">{t("sites.startServerHint")}</p>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-border flex items-center justify-between shrink-0">
          <span className="text-xs text-text-muted">
            {detected.length > 0 ? t("sites.foundCount", { n: detected.length, suffix: detected.length > 1 ? "s" : "" }) : ""}
          </span>
          <button
            onClick={loadSites}
            disabled={!connected}
            className="flex items-center gap-2 px-3 py-1.5 text-sm text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-colors disabled:opacity-50"
          >
            <RefreshCw className={sites === null && connected ? "animate-spin text-brand-500" : ""} size={16} />
            {t("sites.refresh")}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// One entry in the list: the whole row opens the site, the pencil renames it.
// A detected site is the agent's, so it has nothing to remove here.
function SiteRow({
  port, label, protocol, detected, editing, editValue, onEditValue,
  onStartEdit, onSaveEdit, onCancelEdit, onRemove, onOpen, t
}) {
  return (
    <div className="w-full px-4 py-3 bg-surface-2 hover:bg-surface-3 rounded-brand-lg transition-colors group flex items-center gap-2">
      <button onClick={onOpen} className="flex-1 flex items-center gap-3 text-left min-w-0">
        <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${detected ? "bg-green-500 animate-pulse" : "bg-surface-3"}`} />
        <span className="min-w-0 flex-1">
          {editing ? (
            <input
              type="text"
              value={editValue}
              onChange={(e) => onEditValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onSaveEdit();
                if (e.key === "Escape") onCancelEdit();
              }}
              onClick={(e) => e.stopPropagation()}
              autoFocus
              placeholder={`Port ${port}`}
              className="w-full px-2 py-1 bg-surface ring-2 ring-brand-500/40 rounded-brand text-text text-sm focus:outline-none"
            />
          ) : (
            <span className="block text-text font-medium truncate">{label}</span>
          )}
          <span className="block text-xs text-text-muted mt-0.5">
            {protocol ? `${protocol} · ` : ""}Port {port}
          </span>
        </span>
      </button>
      {editing ? (
        <button
          onClick={onSaveEdit}
          className="px-3 py-1.5 text-sm font-medium text-brand-500 hover:bg-surface-3 rounded-brand transition-colors shrink-0"
          title={t("sites.saveTitle")}
        >
          {t("sites.saveTitle")}
        </button>
      ) : (
        <>
          <button
            onClick={(e) => { e.stopPropagation(); onStartEdit(); }}
            className="p-2 text-text-muted hover:text-brand-500 hover:bg-surface-3 rounded-brand transition-colors shrink-0"
            title={t("sites.editNameTitle")}
          >
            <Pencil size={16} />
          </button>
          {!detected && (
            <button
              onClick={(e) => { e.stopPropagation(); onRemove(); }}
              className="p-2 text-text-muted hover:text-red-400 hover:bg-surface-3 rounded-brand transition-colors shrink-0"
              title={t("sites.removeTitle")}
            >
              <Trash2 size={16} />
            </button>
          )}
        </>
      )}
    </div>
  );
}
