"use client";

import { X, File, Folder, Loader2, Search, Upload, CornerDownLeft } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import { useState, useEffect } from "react";

// Modal + banner layer for the mobile FileExplorer: new item, rename, copy
// conflict, and the transfer/error banners. Extracted verbatim from FileExplorer.

const MODAL_WRAP = "fixed inset-0 z-50 flex items-center justify-center p-4";
const INPUT = "w-full px-3 py-2 bg-surface-2 rounded-brand text-text focus:outline-none focus:ring-2 focus:ring-brand-500/40 transition-all duration-150 ease-out";
const BTN_MUTED = "flex-1 py-2 bg-surface-2 text-text rounded-brand hover:bg-surface-3 transition-all duration-150 ease-out active:scale-[0.98]";
const BTN_BRAND = "flex-1 py-2 bg-brand-500 text-white rounded-brand hover:bg-brand-600 transition-all duration-150 ease-out active:scale-[0.98]";

/** Thin progress banner shared by upload and download. */
export function TransferBanner({ label, ratio }) {
  return (
    <div className="bg-brand-500/10 border-b border-brand-500/30 px-4 py-2 text-text text-xs flex items-center gap-2">
      <Loader2 className="animate-spin flex-shrink-0" size={14} />
      <span className="truncate flex-1">{label}</span>
      <div className="w-16 h-1.5 bg-surface-2 rounded-full overflow-hidden flex-shrink-0">
        <div className="h-full bg-brand-500 transition-all" style={{ width: `${Math.round((ratio || 0) * 100)}%` }} />
      </div>
    </div>
  );
}

export function SearchBar({ query, loading, onChange, onClose, compact = false }) {
  const { t } = useI18n();
  // Compact variant for narrow panels: bordered input with inline icons, matching SearchPanel.
  if (compact) {
    return (
      <div className="px-2 py-1.5 border-b border-border-subtle flex-shrink-0">
        <div className="relative">
          <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-subtle pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => onChange(e.target.value)}
            placeholder={t("files.searchPlaceholder")}
            className="w-full min-w-0 bg-surface-2 border border-border rounded-brand pl-7 pr-7 h-8 text-xs text-text placeholder-text-subtle focus:outline-none focus:border-brand-500"
            autoFocus
          />
          {loading ? (
            <Loader2 size={14} className="absolute right-2 top-1/2 -translate-y-1/2 animate-spin text-brand-500" />
          ) : (
            <button
              onClick={() => { vibrate(); onClose(); }}
              className="absolute right-1 top-1/2 -translate-y-1/2 p-1 text-text-subtle hover:text-text"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="bg-surface-2 px-4 py-2 flex items-center gap-2 flex-shrink-0">
      <Search className="text-text-muted flex-shrink-0" size={20} />
      <input
        type="text"
        value={query}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t("files.searchPlaceholder")}
        className="flex-1 min-w-0 w-0 bg-transparent text-text placeholder-text-subtle focus:outline-none"
        autoFocus
      />
      {loading && <Loader2 className="animate-spin text-brand-500" size={16} />}
      <button
        onClick={() => { vibrate(); onClose(); }}
        className="p-1 text-text-muted hover:text-text transition-colors"
      >
        <X size={20} />
      </button>
    </div>
  );
}

export function NewItemModal({ type, name, onTypeChange, onNameChange, onSubmit, onPickFile, onPickFolder, onClose }) {
  const { t } = useI18n();
  // Folder picking needs webkitdirectory — hide the button where the browser lacks it.
  const [dirPickerOk] = useState(() => typeof document !== "undefined" && "webkitdirectory" in document.createElement("input"));
  const isUpload = type === "upload";

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className={MODAL_WRAP}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={onClose} />
      <div className="relative card-elev w-full max-w-sm">
        <div className="px-4 py-3">
          <h3 className="text-text font-semibold">{t("files.createNew")}</h3>
        </div>
        <div className="p-4 space-y-4">
          <div className="flex gap-2">
            <button
              onClick={() => { vibrate(); onTypeChange("file"); }}
              className={`flex-1 py-2 rounded-brand transition flex items-center justify-center gap-2 ${type === "file" ? "bg-brand-500 text-white" : "bg-surface-2 text-text"}`}
            >
              <File size={16} className="text-text-subtle" /> {t("files.file")}
            </button>
            <button
              onClick={() => { vibrate(); onTypeChange("folder"); }}
              className={`flex-1 py-2 rounded-brand transition flex items-center justify-center gap-2 ${type === "folder" ? "bg-brand-500 text-white" : "bg-surface-2 text-text"}`}
            >
              <Folder size={16} className="text-orange-500/70" /> {t("files.folder")}
            </button>
            <button
              onClick={() => { vibrate(); onTypeChange("upload"); }}
              className={`flex-1 py-2 rounded-brand transition flex items-center justify-center gap-2 ${isUpload ? "bg-brand-500 text-white" : "bg-surface-2 text-text"}`}
            >
              <Upload size={16} className="text-brand-500" /> {t("common.upload")}
            </button>
          </div>
          {isUpload ? (
            <>
              <button onClick={() => { vibrate(); onPickFile(); }} className={`${BTN_BRAND} flex items-center justify-center gap-2`}>
                <File size={16} /> {t("files.pickFile")}
              </button>
              {dirPickerOk && (
                <button onClick={() => { vibrate(); onPickFolder(); }} className={`${BTN_MUTED} flex items-center justify-center gap-2`}>
                  <Folder size={16} /> {t("files.pickFolder")}
                </button>
              )}
              <button onClick={() => { vibrate(); onClose(); }} className={`${BTN_MUTED} flex items-center justify-center gap-1.5`}>
                <span>{t("common.cancel")}</span>
                <kbd className="hidden sm:inline-flex items-center text-[10px] font-mono px-1 py-0.5 rounded bg-surface-3 text-text-muted leading-none">Esc</kbd>
              </button>
            </>
          ) : (
            <>
              <input
                type="text"
                value={name}
                onChange={(e) => onNameChange(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && onSubmit()}
                placeholder={type === "file" ? t("files.placeholderFile") : t("files.placeholderFolder")}
                className={INPUT}
                autoFocus
              />
              <div className="flex gap-2">
                <button onClick={() => { vibrate(); onClose(); }} className={`${BTN_MUTED} flex items-center justify-center gap-1.5`}>
                  <span>{t("common.cancel")}</span>
                  <kbd className="hidden sm:inline-flex items-center text-[10px] font-mono px-1 py-0.5 rounded bg-surface-3 text-text-muted leading-none">Esc</kbd>
                </button>
                <button onClick={() => { vibrate(); onSubmit(); }} className={`${BTN_BRAND} flex items-center justify-center gap-1.5`}>
                  <span>{t("common.create")}</span>
                  <kbd className="hidden sm:inline-flex items-center justify-center w-4 h-4 rounded bg-white/20 text-white">
                    <CornerDownLeft size={10} strokeWidth={2.5} />
                  </kbd>
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function RenameModal({ value, onChange, onSubmit, onClose }) {
  const { t } = useI18n();

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className={MODAL_WRAP}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={onClose} />
      <div className="relative card-elev w-full max-w-sm">
        <div className="px-4 py-3">
          <h3 className="text-text font-semibold">{t("files.rename")}</h3>
        </div>
        <div className="p-4 space-y-4">
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onSubmit()}
            className={INPUT}
            autoFocus
          />
          <div className="flex gap-2">
            <button onClick={() => { vibrate(); onClose(); }} className={`${BTN_MUTED} flex items-center justify-center gap-1.5`}>
              <span>{t("common.cancel")}</span>
              <kbd className="hidden sm:inline-flex items-center text-[10px] font-mono px-1 py-0.5 rounded bg-surface-3 text-text-muted leading-none">Esc</kbd>
            </button>
            <button onClick={() => { vibrate(); onSubmit(); }} className={`${BTN_BRAND} flex items-center justify-center gap-1.5`}>
              <span>{t("files.rename")}</span>
              <kbd className="hidden sm:inline-flex items-center justify-center w-4 h-4 rounded bg-white/20 text-white">
                <CornerDownLeft size={10} strokeWidth={2.5} />
              </kbd>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Copy conflict: Skip / Skip all / Replace / Replace all. The keys live under
 *  `menu.*` — the `files.*` ones this used to read do not exist. */
export function ConflictModal({ name, onResolve }) {
  const { t } = useI18n();

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onResolve?.("skip");
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onResolve]);

  const choice = (key, cls, hasEsc = false) => (
    <button
      onClick={() => { vibrate(); onResolve(key); }}
      className={`py-2 rounded-brand text-sm flex items-center justify-center gap-1.5 ${cls}`}
    >
      <span>{t(`menu.${key}`)}</span>
      {hasEsc && <kbd className="hidden sm:inline-flex items-center text-[10px] font-mono px-1 py-0.5 rounded bg-surface-3 text-text-muted leading-none">Esc</kbd>}
    </button>
  );
  return (
    <div className={MODAL_WRAP}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={() => onResolve?.("skip")} />
      <div className="relative card-elev w-full max-w-sm">
        <div className="px-4 py-3">
          <h3 className="text-text font-semibold">{t("menu.conflictTitle")}</h3>
        </div>
        <div className="px-4 pb-3 text-text-muted text-sm break-all">
          {t("menu.conflictMessage", { name })}
        </div>
        <div className="p-4 grid grid-cols-2 gap-2">
          {choice("skip", "bg-surface-2 text-text hover:bg-surface-3", true)}
          {choice("skipAll", "bg-surface-2 text-text hover:bg-surface-3")}
          {choice("replace", "bg-brand-500 text-white hover:bg-brand-600")}
          {choice("replaceAll", "bg-brand-500 text-white hover:bg-brand-600")}
        </div>
      </div>
    </div>
  );
}
