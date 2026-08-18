"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";

// Shared "New terminal" modal: name input + optional shell picker (Windows only).
// Used by both workspace TerminalHeader and home SessionList. Remount via `key` from caller to reset form.
const SHELL_PREF_KEY = "9remote.terminal.shellPref";

export function loadShellPref() {
  try { return localStorage.getItem(SHELL_PREF_KEY) || null; } catch { return null; }
}

export default function NewTerminalModal({ onClose, onCreate, shells = [], suggestName = "" }) {
  const { t } = useI18n();
  const [name, setName] = useState(suggestName || "");
  const [shellId, setShellId] = useState(() => {
    const saved = loadShellPref();
    if (saved && shells.some((s) => s.id === saved)) return saved;
    return shells[0]?.id || "";
  });
  const inputRef = useRef(null);

  useEffect(() => {
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select(); });
  }, []);

  const submit = () => {
    vibrate();
    if (shellId) { try { localStorage.setItem(SHELL_PREF_KEY, shellId); } catch {} }
    onCreate?.(name.trim() || null, shellId || null);
    onClose?.();
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center px-4 bg-black/70"
      style={{ paddingTop: "max(1rem, env(safe-area-inset-top))", paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-brand-lg p-5 w-80 shadow-elev"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-semibold text-text">{t("terminal.newTerminal")}</p>
          <button onClick={onClose} className="text-text-muted hover:text-text">
            <X size={18} />
          </button>
        </div>
        <div className="relative mb-4">
          <input
            type="text"
            ref={inputRef}
            value={name}
            placeholder={t("terminal.defaultName")}
            onInput={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              if (e.key === "Escape") onClose?.();
            }}
            className="w-full px-3 py-2 pr-8 bg-surface-2 rounded-brand text-sm text-text placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-brand-500/40"
          />
          {name && (
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setName("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text"
              title={t("common.cancel")}
            >
              <X size={16} />
            </button>
          )}
        </div>
        {shells.length > 0 && (
          <div className="mb-4">
            <label className="block text-xs font-medium text-text-muted mb-1.5">{t("terminal.shell")}</label>
            <select
              value={shellId}
              onChange={(e) => setShellId(e.target.value)}
              className="w-full px-3 py-2 bg-surface-2 rounded-brand text-sm text-text focus:outline-none focus:ring-2 focus:ring-brand-500/40"
            >
              {shells.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
          </div>
        )}
        <div className="flex gap-2">
          <button
            onClick={submit}
            className="flex-1 py-2 text-sm font-semibold text-white bg-brand-500 hover:bg-brand-600 rounded-brand transition-colors"
          >
            {t("common.create")}
          </button>
          <button
            onClick={onClose}
            className="flex-1 py-2 text-sm text-text-muted bg-surface-2 hover:bg-surface-3 rounded-brand transition-colors"
          >
            {t("common.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
