"use client";

import { useEffect, useRef, useState } from "react";
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
import BrowserModalShell from "./BrowserModalShell";

import { ProfileAvatar } from "@/features/browser/lib/profileAvatar";

export default function BrowserMenuModal({
  invoke,
  profile = "default",
  onSelectProfile,
  targetId,
  url,
  initialSection = null,
  onCopyUrl,
  onClose
}) {
  // The workspace's browsing profile — switching it rebinds the whole pane
  // (stream, strip, invokes) through the parent, not a global.
  const selectProfile = (name) => onSelectProfile?.(name || "default");

  const [profiles, setProfiles] = useState([]);
  const [detectedBrowsers, setDetectedBrowsers] = useState([]);
  const [showNewProfile, setShowNewProfile] = useState(false);
  const [newProfileName, setNewProfileName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(null);

  const [importOpen, setImportOpen] = useState(false); // import MODAL visibility
  const [importName, setImportName] = useState("");
  const importNameRef = useRef(null);
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
    selectProfile(name);
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
      selectProfile(name);
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
      if (res.profile) selectProfile(res.profile);
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

  // Import modal flow: name FIRST (e.g. 9remote_chrome), then pick the source
  // browser profile — the created profile gets the typed name.
  const handleImportCreate = async (family, profileDirectory, label, defaultName) => {
    // No name-first gate: a source click imports IMMEDIATELY, defaulting the
    // profile name from the source (chrome_Default). The input only overrides.
    const sourceName = String(defaultName || label).replace(/[^a-zA-Z0-9]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || family;
    const name = importName.trim() || sourceName;
    vibrate();
    setImportStatus(`Importing from ${label}…`);
    const res = await invoke?.("profiles.createFromBrowser", { family, profileDirectory, name });
    if (res?.ok) {
      const listRes = await invoke?.("profiles.list");
      if (listRes?.ok) setProfiles(listRes.profiles);
      selectProfile(res.profile || name);
      setImportOpen(false);
      setImportStatus(null);
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
      if (profile === name) selectProfile("default");
      const listRes = await invoke?.("profiles.list");
      if (listRes?.ok) setProfiles(listRes.profiles);
    }
  };

  return (
    <>
    <BrowserModalShell wide title="Browser & Profiles" onClose={onClose}>
      <div className="flex flex-col gap-3">
        {/* Profiles — Chrome's people list: avatar + name, check for the active one */}
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold text-text uppercase tracking-wider">Profiles</span>
          <div className="flex flex-col gap-0.5">
            {[...profiles].sort((a, b) => (a.name === "default" ? -1 : b.name === "default" ? 1 : 0)).map((p) => (
              <div
                key={p.name}
                className={`group px-2 py-1.5 rounded-brand text-xs flex items-center gap-2 cursor-pointer transition-colors ${
                  profile === p.name ? "bg-surface-3 text-text font-medium" : "hover:bg-surface-2 text-text-muted"
                }`}
                onClick={() => handleSelectProfile(p.name)}
              >
                <ProfileAvatar name={p.name} />
                <span className="flex-1 min-w-0 truncate">{p.name}</span>
                {profile === p.name && <Check size={13} className="text-brand-500 shrink-0" />}
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
              <span>Create profile</span>
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

        {/* Add profile — new profile + cookies imported from an installed browser */}
        <button
          onClick={() => { setImportName(""); setImportOpen(true); }}
          className="flex items-center gap-2 px-2 py-1.5 rounded-brand text-xs text-text-muted hover:bg-surface-2 hover:text-text transition-colors -mt-1"
        >
          <span className="w-5 h-5 shrink-0 rounded-full border border-dashed border-border-subtle flex items-center justify-center">
            <Plus size={11} />
          </span>
          <span>Add profile</span>
        </button>

      </div>
    </BrowserModalShell>

    {/* Import modal — stacked above: name first, then the source browser */}
    {importOpen && (
      <BrowserModalShell
        wide
        title="Add profile"
        onClose={() => setImportOpen(false)}
        footer={
          <div className="flex items-center gap-2">
            <input
              ref={importNameRef}
              type="text"
              value={importName}
              onChange={(e) => setImportName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && detectedBrowsers?.[0]?.profiles?.[0] && handleImportCreate(detectedBrowsers[0].family, detectedBrowsers[0].profiles[0].directory, `${detectedBrowsers[0].label} (${detectedBrowsers[0].profiles[0].name})`, `${detectedBrowsers[0].family}_${detectedBrowsers[0].profiles[0].name}`)}
              placeholder="Custom profile name (optional, defaults to source)"
              className="flex-1 px-3 py-1.5 bg-surface-2 border border-border-subtle rounded-brand text-xs text-text placeholder-text-muted focus:outline-none focus:border-brand-500"
            />
          </div>
        }
      >
        <div className="flex flex-col gap-2">
          {importStatus && (
            <div className="p-2 rounded bg-brand-500/10 border border-brand-500/20 text-xs text-brand-500 font-medium">
              {importStatus}
            </div>
          )}
          {detectedBrowsers.length === 0 ? (
            <div className="text-xs text-text-muted py-1">No installed browsers detected on host.</div>
          ) : (
            detectedBrowsers.map((b) => (
              <div key={b.family} className="flex flex-col gap-1">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-text">
                  <Globe size={13} className="text-brand-500" />
                  <span>{b.label}</span>
                </div>
                {b.profiles.map((p2) => (
                  <button
                    key={p2.directory}
                    onClick={() => handleImportCreate(b.family, p2.directory, `${b.label} (${p2.name})`, `${b.family}_${p2.name}`)}
                    disabled={importingBrowser === `${b.family}:${p2.directory}`}
                    className="text-left px-2.5 py-1.5 rounded-brand text-xs text-text hover:bg-surface-2 disabled:opacity-40 flex items-center justify-between gap-2"
                  >
                    <span className="truncate font-medium">{p2.name}</span>
                    <span className="px-2 py-0.5 rounded bg-brand-500/10 text-brand-500 text-[10px] font-semibold shrink-0">{importingBrowser === `${b.family}:${p2.directory}` ? "Importing…" : "Import"}</span>
                  </button>
                ))}
              </div>
            ))
          )}
          {showManualPaste && (
            <div className="flex flex-col gap-2 p-2 bg-surface-2 rounded-brand mt-1">
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
          <button
            onClick={() => setShowManualPaste((v) => !v)}
            className="text-[11px] text-text-muted hover:text-text flex items-center gap-1 self-start"
          >
            <ChevronDown size={12} className={`transition-transform duration-150 ${showManualPaste ? "rotate-180" : ""}`} />
            <span>Paste cookies manually…</span>
          </button>
        </div>
      </BrowserModalShell>
    )}
    </>
  );
}
