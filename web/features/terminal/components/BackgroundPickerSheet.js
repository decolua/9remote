"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, Check, ImageOff, Loader2, Upload } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { TERMINAL_BACKGROUNDS, TERMINAL_BG_ALPHA, TERMINAL_BG_OPACITY } from "@/features/terminal/constants/terminalConfig";
import { fileToScaledDataUrl } from "@/features/terminal/lib/backgroundImage";

// Old agents have no bg:save handler — the ack never fires, so time the request out.
const SAVE_TIMEOUT_MS = 20000;

// Wallpaper-style picker sheet for the mobile terminal background. Applies live on
// tap and stays open — the terminal above the sheet previews each choice immediately.
export default function BackgroundPickerSheet({ isOpen, onClose, socketRef }) {
  const { t } = useI18n();
  const terminalBackground = useTerminalStore((s) => s.terminalBackground);
  const setTerminalBackground = useTerminalStore((s) => s.setTerminalBackground);
  const terminalBackgroundOpacity = useTerminalStore((s) => s.terminalBackgroundOpacity);
  const setTerminalBackgroundOpacity = useTerminalStore((s) => s.setTerminalBackgroundOpacity);
  const customBgDataUrl = useTerminalStore((s) => s.customBgDataUrl);
  const setCustomBgDataUrl = useTerminalStore((s) => s.setCustomBgDataUrl);

  const [urlDraft, setUrlDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  // Error clears on close, not on open — a sync setState in the open effect
  // would trip cascading-render lint and re-render the sheet needlessly.
  const handleClose = () => { setError(""); onClose(); };

  // Send URL/dataUrl to the agent — it fetches/compresses/stores, then we apply
  // the returned dataUrl immediately and make "custom" the active background.
  const saveBackground = (payload) => {
    const socket = socketRef?.current;
    if (!socket?.emit) { setError(t("menu.bgSaveFailed")); return; }
    setSaving(true);
    setError("");
    let done = false;
    const finish = (fn) => { if (done) return; done = true; clearTimeout(timer); setSaving(false); fn(); };
    const timer = setTimeout(() => finish(() => setError(t("menu.bgSaveFailed"))), SAVE_TIMEOUT_MS);
    socket.emit("bg:save", payload, (res) => {
      finish(() => {
        if (res?.success && res.dataUrl) {
          setCustomBgDataUrl(res.dataUrl);
          setTerminalBackground("custom");
          vibrate();
        } else {
          setError(res?.error || t("menu.bgSaveFailed"));
        }
      });
    });
  };

  const handleSaveUrl = () => {
    const url = urlDraft.trim();
    if (!url || saving) return;
    saveBackground({ url });
  };

  const handlePickFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || saving) return;
    try {
      saveBackground({ dataUrl: await fileToScaledDataUrl(file) });
    } catch {
      setError(t("menu.bgSaveFailed"));
    }
  };

  if (!isOpen || typeof document === "undefined") return null;

  const opacity = terminalBackgroundOpacity ?? TERMINAL_BG_ALPHA;

  return createPortal(
    <div className="fixed inset-0 z-[60] flex flex-col justify-end">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px] animate-in fade-in duration-200" onClick={handleClose} />

      <div className="relative rounded-t-3xl border-t border-border bg-surface/95 backdrop-blur-xl shadow-2xl max-h-[88dvh] flex flex-col animate-in slide-in-from-bottom duration-300 ease-out">
        {/* Drag handle */}
        <div className="pt-3 pb-1 flex justify-center flex-shrink-0">
          <div className="w-10 h-1 rounded-full bg-border" />
        </div>

        <div className="px-6 pb-3 flex items-center justify-between flex-shrink-0">
          <h3 className="text-lg font-semibold text-text">{t("menu.terminalBackground")}</h3>
          <button
            onClick={handleClose}
            className="p-2 -mr-2 text-text-muted hover:text-text hover:bg-surface-2 rounded-full transition-colors"
            aria-label={t("common.close")}
          >
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto modal_scrollable px-5 pb-6">
          {/* Custom source: agent-side URL fetch avoids mobile CORS; uploads are
              browser-scaled first so a 12MP phone photo stays a quick transfer. */}
          <div className="flex gap-2 mb-3">
            <input
              type="url"
              inputMode="url"
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSaveUrl()}
              placeholder={t("menu.bgUrlPlaceholder")}
              disabled={saving}
              className="flex-1 min-w-0 px-3 py-2 bg-surface-2 rounded-brand text-sm text-text placeholder-text-subtle focus:outline-none focus:ring-2 focus:ring-brand-500/40"
            />
            <button
              onClick={handleSaveUrl}
              disabled={saving || !urlDraft.trim()}
              className="px-4 py-2 bg-brand-500 text-white rounded-brand text-sm font-medium hover:bg-brand-600 transition-all duration-150 ease-out active:scale-[0.98] disabled:opacity-40 flex items-center gap-2"
            >
              {saving && <Loader2 size={14} className="animate-spin" />}
              {t("menu.bgSave")}
            </button>
          </div>
          <button
            onClick={() => { vibrate(); fileInputRef.current?.click(); }}
            disabled={saving}
            className="w-full mb-4 py-2 bg-surface-2 text-text rounded-brand text-sm font-medium hover:bg-surface-3 transition-all duration-150 ease-out active:scale-[0.98] disabled:opacity-40 flex items-center justify-center gap-2"
          >
            <Upload size={15} />
            {t("menu.bgUpload")}
          </button>
          <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handlePickFile} />
          {error && <div className="mb-3 px-3 py-2 rounded-brand bg-red-500/10 border border-red-500/30 text-red-500 text-xs break-all">{error}</div>}

          <div className="grid grid-cols-2 gap-3">
            {Object.entries(TERMINAL_BACKGROUNDS).map(([key, preset]) => {
              const active = terminalBackground === key;
              const src = key === "custom" ? customBgDataUrl : preset.src;
              return (
                <button
                  key={key}
                  onClick={() => { vibrate(); setTerminalBackground(key); }}
                  className="group relative aspect-[9/16] rounded-2xl overflow-hidden transition-transform duration-200 ease-out active:scale-[0.97] shadow-sm"
                >
                  {src ? (
                    <>
                      <img
                        src={src}
                        alt={preset.label}
                        className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                        loading="lazy"
                      />
                      <div className="absolute inset-x-0 bottom-0 h-1/4 bg-gradient-to-t from-black/75 to-transparent" />
                      <span className="absolute bottom-2 left-0 right-0 px-2 text-xs font-medium text-white truncate">{preset.label}</span>
                    </>
                  ) : (
                    <span className={`absolute inset-0 flex flex-col items-center justify-center gap-2 transition-colors ${
                      active ? "bg-brand-500/10 text-brand-500" : "bg-surface-2 text-text-muted group-hover:text-text"
                    }`}>
                      <ImageOff size={24} strokeWidth={1.75} />
                      <span className="text-xs font-medium">{preset.label}</span>
                    </span>
                  )}
                  {/* Ring overlay sits ABOVE the image — a ring on the button itself
                      would paint under it and get clipped at the scroll edge */}
                  <span className={`pointer-events-none absolute inset-0 rounded-2xl transition-shadow duration-200 ${
                    active
                      ? "ring-2 ring-inset ring-brand-500"
                      : "ring-1 ring-inset ring-white/15 group-hover:ring-2 group-hover:ring-inset group-hover:ring-brand-500/60"
                  }`} />
                  {active && (
                    <span className="absolute top-2 right-2 flex items-center justify-center w-6 h-6 bg-brand-500 rounded-full shadow-lg">
                      <Check size={14} className="text-white" strokeWidth={3} />
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Live dim control — the terminal above the sheet previews as it moves */}
          {terminalBackground !== "none" && (
            <div className="mt-5">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-text">{t("menu.bgDim")}</span>
                <span className="text-xs text-text-muted tabular-nums">{Math.round(opacity * 100)}%</span>
              </div>
              <input
                type="range"
                min={TERMINAL_BG_OPACITY.min}
                max={TERMINAL_BG_OPACITY.max}
                step={TERMINAL_BG_OPACITY.step}
                value={opacity}
                onChange={(e) => setTerminalBackgroundOpacity(Number(e.target.value))}
                className="w-full accent-brand-500"
                aria-label={t("menu.bgDim")}
              />
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
