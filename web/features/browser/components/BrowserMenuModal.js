"use client";

import { useEffect, useState } from "react";
import { Check, ExternalLink, Plus, Shield, Trash2, X } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";

const VIEWPORTS = [
  { label: "Mobile (375 × 667)", width: 375, height: 667 },
  { label: "Tablet (768 × 1024)", width: 768, height: 1024 },
  { label: "Desktop (1120 × 780)", width: 1120, height: 780 }
];

export default function BrowserMenuModal({
  invoke,
  targetId,
  url,
  initialSection = null,
  keyboardOpen = false,
  notesCount = 0,
  onToggleKeyboard,
  onCopyUrl,
  onOpenNotes,
  onSelectViewport,
  onClose
}) {
  const [profiles, setProfiles] = useState([]);
  const [activeProfile, setActiveProfile] = useState("default");
  const [showNewProfile, setShowNewProfile] = useState(false);
  const [newProfileName, setNewProfileName] = useState("");
  const [newProfileUa, setNewProfileUa] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const [showImport, setShowImport] = useState(initialSection === "cookies");
  const [cookieContent, setCookieContent] = useState("");
  const [importStatus, setImportStatus] = useState(null);

  useEffect(() => {
    invoke?.("profiles.list")?.then((res) => {
      if (res?.ok && Array.isArray(res.profiles)) {
        setProfiles(res.profiles);
      }
    });
  }, [invoke]);

  const handleCreateProfile = async () => {
    const name = newProfileName.trim();
    if (!name) return;
    vibrate();
    const res = await invoke?.("profiles.create", { name, userAgentUnmodified: newProfileUa });
    if (res?.ok) {
      setShowNewProfile(false);
      setNewProfileName("");
      setNewProfileUa(false);
      const listRes = await invoke?.("profiles.list");
      if (listRes?.ok) setProfiles(listRes.profiles);
    }
  };

  const handleImportCookies = async () => {
    if (!cookieContent.trim() || !targetId) return;
    vibrate();
    setImportStatus("Importing…");
    const res = await invoke?.("cookie.import", {
      targetId,
      content: cookieContent.trim()
    });
    if (res?.ok) {
      setImportStatus(`Imported ${res.imported} cookies!`);
      setTimeout(() => {
        setImportStatus(null);
        setShowImport(false);
        setCookieContent("");
      }, 1500);
    } else {
      setImportStatus(res?.error || "Import failed");
    }
  };

  const toggleProfileUa = async (profile) => {
    vibrate();
    const next = !profile.userAgentUnmodified;
    const res = await invoke?.("profiles.update", { name: profile.name, userAgentUnmodified: next });
    if (res?.ok) {
      setProfiles((prev) => prev.map((p) => (p.name === profile.name ? { ...p, userAgentUnmodified: next } : p)));
    }
  };

  const handleDeleteProfile = async (name) => {
    if (confirmDelete !== name) {
      setConfirmDelete(name);
      return;
    }
    vibrate();
    const res = await invoke?.("profiles.remove", { name });
    setConfirmDelete(null);
    if (res?.ok) {
      if (activeProfile === name) setActiveProfile("default");
      const listRes = await invoke?.("profiles.list");
      if (listRes?.ok) setProfiles(listRes.profiles);
    }
  };

  const openExternal = () => {
    if (url) window.open(url, "_blank");
    onClose();
  };

  return (
    <div
      className="absolute inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-100"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm bg-surface rounded-brand border border-border-subtle shadow-2xl p-4 flex flex-col gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between pb-2 border-b border-border-subtle">
          <span className="text-xs font-semibold text-text uppercase tracking-wider">Browser</span>
          <button onClick={onClose} className="p-1 text-text-muted hover:text-text rounded-brand">
            <X size={15} />
          </button>
        </div>

        {/* Quick tools — pane controls that do not fit the orca-shaped toolbar */}
        <div className="flex flex-col gap-0.5 pb-2 border-b border-border-subtle">
          <button
            onClick={() => { onToggleKeyboard?.(); onClose(); }}
            className="w-full text-left px-2.5 py-1.5 rounded-brand text-xs text-text hover:bg-surface-2 flex items-center justify-between"
          >
            <span>Keyboard</span>
            {keyboardOpen && <Check size={13} className="text-brand-500" />}
          </button>
          <button
            onClick={() => { onOpenNotes?.(); onClose(); }}
            className="w-full text-left px-2.5 py-1.5 rounded-brand text-xs text-text hover:bg-surface-2 flex items-center justify-between"
          >
            <span>Notes</span>
            {notesCount > 0 && (
              <span className="min-w-4 rounded-full bg-brand-500 px-1 text-[10px] leading-4 text-white text-center">{notesCount}</span>
            )}
          </button>
          <button
            onClick={() => { onCopyUrl?.(); onClose(); }}
            disabled={!url}
            className="w-full text-left px-2.5 py-1.5 rounded-brand text-xs text-text hover:bg-surface-2 disabled:opacity-40 flex items-center justify-between"
          >
            <span>Copy page URL</span>
            <ExternalLink size={13} className="text-text-muted" />
          </button>
        </div>

        {/* Profiles */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium text-text-muted">Profiles</span>
          <div className="flex flex-col gap-1">
            {profiles.map((p) => (
              <div
                key={p.name}
                className={`px-2.5 py-1.5 rounded-brand text-xs flex items-center justify-between gap-2 cursor-pointer transition-colors ${
                  activeProfile === p.name ? "bg-surface-3 text-text font-medium" : "hover:bg-surface-2 text-text-muted"
                }`}
                onClick={() => { vibrate(); setActiveProfile(p.name); }}
              >
                <span className="truncate">{p.name === "default" ? "Default (Google Chrome)" : p.name}</span>
                <span className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={(e) => { e.stopPropagation(); toggleProfileUa(p); }}
                    className={`p-1 rounded ${(p.userAgentUnmodified ? "text-brand-500" : "text-text-muted hover:text-text")} hover:bg-surface/60`}
                    title={`Unmodified user agent ${p.userAgentUnmodified ? "ON" : "OFF"} — applies the next time this profile's browser starts`}
                  >
                    <Shield size={12} />
                  </button>
                  {p.name !== "default" && (
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDeleteProfile(p.name); }}
                      className={`p-1 rounded ${confirmDelete === p.name ? "text-red-500" : "text-text-muted hover:text-red-500"} hover:bg-surface/60`}
                      title={confirmDelete === p.name ? "Click again to delete" : "Delete profile"}
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                  {activeProfile === p.name && <Check size={13} className="text-brand-500" />}
                </span>
              </div>
            ))}
          </div>

          {!showNewProfile ? (
            <button
              onClick={() => setShowNewProfile(true)}
              className="text-xs text-brand-500 hover:text-brand-600 flex items-center gap-1 mt-1 font-medium"
            >
              <Plus size={13} /> New Profile…
            </button>
          ) : (
            <div className="flex flex-col gap-2 p-2 bg-surface-2 rounded-brand mt-1">
              <input
                type="text"
                value={newProfileName}
                onChange={(e) => setNewProfileName(e.target.value)}
                placeholder="Profile name"
                className="px-2 py-1 bg-surface text-xs rounded text-text placeholder-text-muted focus:outline-none"
              />
              <label className="flex items-center gap-2 text-[11px] text-text-muted cursor-pointer">
                <input
                  type="checkbox"
                  checked={newProfileUa}
                  onChange={(e) => setNewProfileUa(e.target.checked)}
                  className="rounded text-brand-500"
                />
                Use unmodified user agent
              </label>
              <div className="flex justify-end gap-1.5">
                <button onClick={() => setShowNewProfile(false)} className="px-2 py-1 text-xs text-text-muted">
                  Cancel
                </button>
                <button
                  onClick={handleCreateProfile}
                  disabled={!newProfileName.trim()}
                  className="px-2.5 py-1 bg-brand-500 text-white rounded text-xs font-medium disabled:opacity-40"
                >
                  Create
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Import Cookies */}
        <div className="flex flex-col gap-1.5 pt-2 border-t border-border-subtle">
          <span className="text-[11px] font-medium text-text-muted">Cookies</span>
          {!showImport ? (
            <button
              onClick={() => setShowImport(true)}
              className="text-xs text-text hover:bg-surface-2 px-2.5 py-1.5 rounded-brand text-left font-medium"
            >
              Import Cookies…
            </button>
          ) : (
            <div className="flex flex-col gap-2 p-2 bg-surface-2 rounded-brand">
              <textarea
                value={cookieContent}
                onChange={(e) => setCookieContent(e.target.value)}
                placeholder="Paste JSON or Netscape cookies"
                rows={3}
                className="p-1.5 bg-surface text-xs font-mono rounded text-text placeholder-text-muted focus:outline-none"
              />
              {importStatus && <span className="text-[11px] text-brand-500">{importStatus}</span>}
              <div className="flex justify-end gap-1.5">
                <button onClick={() => setShowImport(false)} className="px-2 py-1 text-xs text-text-muted">
                  Cancel
                </button>
                <button
                  onClick={handleImportCookies}
                  disabled={!cookieContent.trim()}
                  className="px-2.5 py-1 bg-brand-500 text-white rounded text-xs font-medium disabled:opacity-40"
                >
                  Import
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Viewport Size */}
        <div className="flex flex-col gap-1.5 pt-2 border-t border-border-subtle">
          <span className="text-[11px] font-medium text-text-muted">Viewport Size</span>
          <div className="flex flex-col gap-1">
            {VIEWPORTS.map((vp) => (
              <button
                key={vp.label}
                onClick={() => {
                  vibrate();
                  onSelectViewport?.(vp.width, vp.height);
                  onClose();
                }}
                className="text-xs text-text hover:bg-surface-2 px-2.5 py-1.5 rounded-brand text-left"
              >
                {vp.label}
              </button>
            ))}
          </div>
        </div>

        {/* External Link */}
        <div className="pt-2 border-t border-border-subtle">
          <button
            onClick={openExternal}
            className="w-full text-xs text-text hover:bg-surface-2 px-2.5 py-1.5 rounded-brand text-left flex items-center justify-between"
          >
            <span>Open in Default Browser</span>
            <ExternalLink size={13} className="text-text-muted" />
          </button>
        </div>
      </div>
    </div>
  );
}
