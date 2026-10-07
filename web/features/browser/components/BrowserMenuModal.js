"use client";

import { useEffect, useState } from "react";
import {
  Check,
  ChevronDown,
  ExternalLink,
  Globe,
  Plus,
  SquarePen,
  Terminal,
  Trash2
} from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useBrowserStore } from "@/shared/stores/browserStore";
import BrowserModalShell from "./BrowserModalShell";

const VIEWPORTS = [
  { label: "Mobile (375 × 667)", width: 375, height: 667 },
  { label: "Tablet (768 × 1024)", width: 768, height: 1024 },
  { label: "Desktop (1120 × 780)", width: 1120, height: 780 }
];

// Chrome-style avatar: a colored disc with the profile's initial, the color
// stable per name so profiles stay tellable apart at a glance.
function profileColor(name) {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 62% 45%)`;
}
function ProfileAvatar({ name }) {
  const label = (name === "default" ? "D" : name).trim().charAt(0).toUpperCase();
  return (
    <span
      className="w-5 h-5 shrink-0 rounded-full flex items-center justify-center text-[10px] font-bold text-white"
      style={{ backgroundColor: profileColor(name) }}
    >
      {label}
    </span>
  );
}

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
  onOpenMarkup,
  onOpenConsole,
  onClose
}) {
  const activeProfile = useBrowserStore((s) => s.activeProfile);
  const setActiveProfile = useBrowserStore((s) => s.setActiveProfile);

  const [profiles, setProfiles] = useState([]);
  const [detectedBrowsers, setDetectedBrowsers] = useState([]);
  const [showNewProfile, setShowNewProfile] = useState(false);
  const [newProfileName, setNewProfileName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(null);

  const [importOpen, setImportOpen] = useState(initialSection === "cookies");
  const [showManualPaste, setShowManualPaste] = useState(initialSection === "cookies");
  const [cookieContent, setCookieContent] = useState("");
  const [importStatus, setImportStatus] = useState(null);
  const [importingBrowser, setImportingBrowser] = useState(null);

  useEffect(() => {
    invoke?.("profiles.list")?.then((res) => {
      if (res?.ok && Array.isArray(res.profiles)) {
        setProfiles(res.profiles);
      }
    });
    invoke?.("browsers.detect")?.then((res) => {
      if (res?.ok && Array.isArray(res.browsers)) {
        setDetectedBrowsers(res.browsers);
      }
    });
  }, [invoke]);

  const handleSelectProfile = (name) => {
    vibrate();
    setActiveProfile(name);
  };

  const handleCreateProfile = async () => {
    const name = newProfileName.trim();
    if (!name) return;
    vibrate();
    const res = await invoke?.("profiles.create", { name });
    if (res?.ok) {
      setShowNewProfile(false);
      setNewProfileName("");
      const listRes = await invoke?.("profiles.list");
      if (listRes?.ok) setProfiles(listRes.profiles);
      setActiveProfile(name);
    }
  };

  const handleImportFromBrowser = async (family, profileDirectory, label) => {
    if (!targetId) return;
    vibrate();
    const key = `${family}:${profileDirectory}`;
    setImportingBrowser(key);
    setImportStatus(`Importing cookies from ${label}…`);
    const res = await invoke?.("cookie.importFromBrowser", {
      family,
      profileDirectory,
      targetId
    });
    setImportingBrowser(null);
    if (res?.ok) {
      setImportStatus(`Imported ${res.imported || res.count || 0} cookies from ${label}!`);
      setTimeout(() => setImportStatus(null), 3500);
    } else {
      setImportStatus(res?.error || "Import failed");
    }
  };

  const handleCreateProfileFromBrowser = async (family, profileDirectory, defaultLabel) => {
    vibrate();
    const name = defaultLabel.toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 24);
    setImportStatus(`Creating profile from ${defaultLabel}…`);
    const res = await invoke?.("profiles.createFromBrowser", {
      family,
      profileDirectory,
      name
    });
    if (res?.ok) {
      const listRes = await invoke?.("profiles.list");
      if (listRes?.ok) setProfiles(listRes.profiles);
      if (res.profile) setActiveProfile(res.profile);
      setImportStatus(`Created profile "${res.profile}" with ${res.imported || 0} cookies!`);
      setTimeout(() => setImportStatus(null), 3500);
    } else {
      setImportStatus(res?.error || "Profile creation failed");
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
        setShowManualPaste(false);
        setCookieContent("");
      }, 2000);
    } else {
      setImportStatus(res?.error || "Import failed");
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

  return (
    <BrowserModalShell wide title="Browser & Profiles" onClose={onClose}>
      <div className="flex flex-col gap-3">
        {/* Quick tools */}
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
            onClick={() => { onOpenMarkup?.(); onClose(); }}
            className="w-full text-left px-2.5 py-1.5 rounded-brand text-xs text-text hover:bg-surface-2 flex items-center justify-between"
          >
            <span>Draw Markup</span>
            <SquarePen size={13} className="text-text-muted" />
          </button>
          <button
            onClick={() => { onOpenConsole?.(); onClose(); }}
            className="w-full text-left px-2.5 py-1.5 rounded-brand text-xs text-text hover:bg-surface-2 flex items-center justify-between"
          >
            <span>Console REPL</span>
            <Terminal size={13} className="text-text-muted" />
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

        {/* Profiles — Chrome's people list: avatar + name, check for the active one */}
        <div className="flex flex-col gap-1 pt-2 border-t border-border-subtle">
          <span className="text-[11px] font-semibold text-text uppercase tracking-wider">Profiles</span>
          <div className="flex flex-col gap-0.5">
            {profiles.map((p) => (
              <div
                key={p.name}
                className={`group px-2 py-1.5 rounded-brand text-xs flex items-center gap-2 cursor-pointer transition-colors ${
                  activeProfile === p.name ? "bg-surface-3 text-text font-medium" : "hover:bg-surface-2 text-text-muted"
                }`}
                onClick={() => handleSelectProfile(p.name)}
              >
                <ProfileAvatar name={p.name} />
                <span className="flex-1 min-w-0 truncate">{p.name}</span>
                {activeProfile === p.name && <Check size={13} className="text-brand-500 shrink-0" />}
                {p.name !== "default" && (
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDeleteProfile(p.name); }}
                    className={`p-1 rounded shrink-0 transition-colors ${
                      confirmDelete === p.name ? "text-red-500 opacity-100" : "text-text-muted hover:text-red-500 opacity-0 group-hover:opacity-100 focus:opacity-100"
                    } hover:bg-surface/60`}
                    title={confirmDelete === p.name ? "Click again to delete" : "Delete profile"}
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
            ))}
          </div>

          {!showNewProfile ? (
            <button
              onClick={() => setShowNewProfile(true)}
              className="flex items-center gap-2 px-2 py-1.5 rounded-brand text-xs text-text-muted hover:bg-surface-2 hover:text-text transition-colors mt-0.5"
            >
              <span className="w-5 h-5 shrink-0 rounded-full border border-dashed border-border-subtle flex items-center justify-center">
                <Plus size={11} />
              </span>
              <span>Add profile</span>
            </button>
          ) : (
            <div className="flex flex-col gap-2 p-2 bg-surface-2 rounded-brand mt-1">
              <input
                type="text"
                value={newProfileName}
                onChange={(e) => setNewProfileName(e.target.value)}
                placeholder="Profile name (e.g. work, personal)"
                className="px-2 py-1 bg-surface text-xs rounded text-text placeholder-text-muted focus:outline-none"
              />
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

        {/* Import — collapsed by default: a power-user path, not part of the
            everyday profile flow (Chrome keeps it behind its own submenu too). */}
        <div className="flex flex-col gap-2 pt-2 border-t border-border-subtle">
          <button
            onClick={() => setImportOpen((v) => !v)}
            className="flex items-center justify-between gap-2 text-[11px] font-semibold text-text uppercase tracking-wider hover:text-brand-500 transition-colors"
          >
            <span>Import from Chrome / Firefox</span>
            <ChevronDown size={13} className={`text-text-muted transition-transform duration-150 ${importOpen ? "rotate-180" : ""}`} />
          </button>

          {!importOpen ? null : (
          <>
          {importStatus && (
            <div className="p-2 rounded bg-brand-500/10 border border-brand-500/20 text-xs text-brand-500 font-medium">
              {importStatus}
            </div>
          )}

          {detectedBrowsers.length === 0 ? (
            <div className="text-xs text-text-muted py-1">No installed browsers detected on host.</div>
          ) : (
            <div className="flex flex-col gap-2">
              {detectedBrowsers.map((b) => (
                <div key={b.family} className="flex flex-col gap-1.5 p-2 bg-surface-2 rounded-brand border border-border-subtle">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-text">
                    <Globe size={13} className="text-brand-500" />
                    <span>{b.label}</span>
                  </div>
                  <div className="flex flex-col gap-1">
                    {b.profiles.map((p) => (
                      <div key={p.directory} className="flex items-center justify-between gap-2 px-2 py-1 bg-surface rounded text-xs">
                        <span className="truncate text-text font-medium" title={p.directory}>{p.name}</span>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            onClick={() => handleImportFromBrowser(b.family, p.directory, `${b.label} (${p.name})`)}
                            disabled={!targetId || importingBrowser === `${b.family}:${p.directory}`}
                            className="px-2 py-0.5 rounded bg-brand-500/10 hover:bg-brand-500/20 text-brand-500 text-[11px] font-medium transition-colors disabled:opacity-40"
                            title="Import cookies into current active tab"
                          >
                            {importingBrowser === `${b.family}:${p.directory}` ? "Importing…" : "Import"}
                          </button>
                          <button
                            onClick={() => handleCreateProfileFromBrowser(b.family, p.directory, `${b.family}_${p.name}`)}
                            className="px-2 py-0.5 rounded bg-surface-3 hover:bg-surface-3/80 text-text text-[11px] font-medium transition-colors"
                            title="Create a new 9remote profile with these cookies"
                          >
                            + Profile
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Manual paste toggle */}
          <button
            onClick={() => setShowManualPaste((v) => !v)}
            className="text-[11px] text-text-muted hover:text-text flex items-center gap-1 pt-0.5 self-start"
          >
            <ChevronDown size={12} className={`transition-transform duration-150 ${showManualPaste ? "rotate-180" : ""}`} />
            <span>Paste JSON or Netscape cookies manually…</span>
          </button>

          {showManualPaste && (
            <div className="flex flex-col gap-2 p-2 bg-surface-2 rounded-brand animate-in fade-in duration-100">
              <textarea
                value={cookieContent}
                onChange={(e) => setCookieContent(e.target.value)}
                placeholder="Paste JSON array or Netscape format cookies"
                rows={3}
                className="p-1.5 bg-surface text-xs font-mono rounded text-text placeholder-text-muted focus:outline-none"
              />
              <div className="flex justify-end gap-1.5">
                <button
                  onClick={handleImportCookies}
                  disabled={!cookieContent.trim() || !targetId}
                  className="px-2.5 py-1 bg-brand-500 text-white rounded text-xs font-medium disabled:opacity-40"
                >
                  Import Pasted
                </button>
              </div>
            </div>
          )}
          </>
          )}
        </div>

        {/* Viewport Size */}
        <div className="flex flex-col gap-1.5 pt-2 border-t border-border-subtle">
          <span className="text-[11px] font-semibold text-text uppercase tracking-wider">Viewport Size</span>
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
      </div>
    </BrowserModalShell>
  );
}
