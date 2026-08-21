"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, ImageOff, Loader2, Plus } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { TERMINAL_BACKGROUNDS, TERMINAL_BG_ALPHA, TERMINAL_BG_OPACITY } from "@/features/terminal/constants/terminalConfig";
import { fileToScaledDataUrl } from "@/features/terminal/lib/backgroundImage";

// Old agents have no bg:save handler — the ack never fires, so time the request out.
const SAVE_TIMEOUT_MS = 20000;

// Wallpaper-style picker sheet for the mobile terminal background. Tiles are
// multi-select: the ordered pool round-robins across panes by display index
// (pane 0 → pick 1, pane 1 → pick 2, …), previewed live on the terminal above.
export default function BackgroundPickerSheet({ isOpen, onClose, socketRef }) {
  const { t } = useI18n();
  const terminalBackgrounds = useTerminalStore((s) => s.terminalBackgrounds);
  const setTerminalBackgrounds = useTerminalStore((s) => s.setTerminalBackgrounds);
  const terminalBackgroundOpacity = useTerminalStore((s) => s.terminalBackgroundOpacity);
  const setTerminalBackgroundOpacity = useTerminalStore((s) => s.setTerminalBackgroundOpacity);
  const customBackgrounds = useTerminalStore((s) => s.customBackgrounds);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      setError("");
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  // Error clears on close, not on open — a sync setState in the open effect
  // would trip cascading-render lint and re-render the sheet needlessly.
  const handleClose = () => { setError(""); onClose(); };

  // Toggle a tile in/out of the ordered pool — the number badge shows its turn.
  const toggleBackground = (key) => {
    vibrate();
    const { terminalBackgrounds: keys, setTerminalBackgrounds: setKeys } = useTerminalStore.getState();
    setKeys(keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key]);
  };

  // Send the picked image to the agent — it compresses/stores, then we add the
  // returned item to the list and select it at the end of the pool.
  const saveBackground = (dataUrl) => {
    const socket = socketRef?.current;
    if (!socket?.emit) { setError(t("menu.bgSaveFailed")); return; }
    setSaving(true);
    setError("");
    let done = false;
    const finish = (fn) => { if (done) return; done = true; clearTimeout(timer); setSaving(false); fn(); };
    const timer = setTimeout(() => finish(() => setError(t("menu.bgSaveFailed"))), SAVE_TIMEOUT_MS);
    socket.emit("bg:save", { dataUrl }, (res) => {
      finish(() => {
        if (res?.success && res.id && res.dataUrl) {
          const key = `custom:${res.id}`;
          const { customBackgrounds: list, setCustomBackgrounds, terminalBackgrounds: keys, setTerminalBackgrounds: setKeys } = useTerminalStore.getState();
          setCustomBackgrounds([...list, { id: res.id, dataUrl: res.dataUrl }]);
          if (!keys.includes(key)) setKeys([...keys, key]);
          vibrate();
        } else {
          setError(res?.error || t("menu.bgSaveFailed"));
        }
      });
    });
  };

  const deleteBackground = (id) => {
    vibrate();
    const socket = socketRef?.current;
    if (!socket?.emit) return;
    socket.emit("bg:delete", { id }, (res) => {
      if (!res?.success) { setError(res?.error || t("menu.bgDeleteFailed")); return; }
      const key = `custom:${id}`;
      const { customBackgrounds: list, setCustomBackgrounds, terminalBackgrounds: keys, setTerminalBackgrounds: setKeys } = useTerminalStore.getState();
      setCustomBackgrounds(list.filter((it) => it.id !== id));
      setKeys(keys.filter((k) => k !== key));
    });
  };

  const handlePickFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || saving) return;
    try {
      saveBackground(await fileToScaledDataUrl(file));
    } catch {
      setError(t("menu.bgSaveFailed"));
    }
  };

  const openPicker = () => {
    vibrate();
    if (!saving) fileInputRef.current?.click();
  };

  if (!isOpen || typeof document === "undefined") return null;

  const opacity = terminalBackgroundOpacity ?? TERMINAL_BG_ALPHA;
  const { min, max, step } = TERMINAL_BG_OPACITY;
  const pct = `${((opacity - min) / (max - min)) * 100}%`;

  // Shared tile markup — called (not used as a component) so React sees a stable
  // <button> type and the images don't remount on every render.
  const renderTile = (key, label, src) => {
    const order = terminalBackgrounds.indexOf(key);
    const selected = order !== -1;
    return (
      <button
        onClick={() => toggleBackground(key)}
        className="group relative block w-full aspect-[9/16] rounded-2xl overflow-hidden transition-transform duration-200 ease-out active:scale-[0.97] shadow-sm"
      >
        {src ? (
          <>
            <img
              src={src}
              alt={label}
              className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
              loading="lazy"
            />
            {/* Light fixed scrim only — the tile previews the image, not the pane's live dim */}
            <span className="pointer-events-none absolute inset-0 bg-black/25" />
            <div className="absolute inset-x-0 bottom-0 h-1/4 bg-gradient-to-t from-black/75 to-transparent" />
            <span className="absolute bottom-2 left-0 right-0 px-2 text-xs font-medium text-white truncate">{label}</span>
          </>
        ) : (
          <span className={`absolute inset-0 flex flex-col items-center justify-center gap-2 transition-colors ${
            selected ? "bg-brand-500/10 text-brand-500" : "bg-surface-2 text-text-muted group-hover:text-text"
          }`}>
            <ImageOff size={24} strokeWidth={1.75} />
            <span className="text-xs font-medium">{label}</span>
          </span>
        )}
        {/* Ring overlay sits ABOVE the image — a ring on the button itself
            would paint under it and get clipped at the scroll edge */}
        <span className={`pointer-events-none absolute inset-0 rounded-2xl transition-shadow duration-200 ${
          selected
            ? "ring-2 ring-inset ring-brand-500"
            : "ring-1 ring-inset ring-white/15 group-hover:ring-2 group-hover:ring-inset group-hover:ring-brand-500/60"
        }`} />
        {selected && (
          <span className="absolute top-2 right-2 flex items-center justify-center w-6 h-6 bg-brand-500 rounded-full shadow-lg text-white text-xs font-semibold">
            {order + 1}
          </span>
        )}
      </button>
    );
  };

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

        <div className="flex-1 min-h-0 overflow-y-auto modal-scrollable px-5 pb-4">
          <div className="grid grid-cols-2 gap-3">
            {Object.entries(TERMINAL_BACKGROUNDS).map(([key, preset]) => (
              <div key={key}>
                {renderTile(key, preset.label, preset.src)}
              </div>
            ))}

            {/* Add tile — picks a new image from the device */}
            <button
              onClick={openPicker}
              disabled={saving}
              className="group relative block w-full aspect-[9/16] rounded-2xl overflow-hidden border-2 border-dashed border-border flex flex-col items-center justify-center gap-2 text-text-muted hover:border-brand-500 hover:text-brand-500 transition-colors disabled:opacity-40"
            >
              {saving ? <Loader2 size={24} className="animate-spin" /> : <Plus size={24} strokeWidth={1.75} />}
              <span className="text-xs font-medium">{t("menu.bgAdd")}</span>
            </button>

            {customBackgrounds.map((it) => (
              <div key={`custom:${it.id}`} className="relative">
                {renderTile(`custom:${it.id}`, t("menu.bgCustomLabel"), it.dataUrl)}
                <button
                  onClick={() => deleteBackground(it.id)}
                  className="absolute top-2 left-2 flex items-center justify-center w-7 h-7 rounded-full bg-black/55 text-white backdrop-blur-sm hover:bg-red-500/80 transition-colors"
                  aria-label={t("common.delete")}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        </div>

        {error && (
          <div className="flex-shrink-0 mx-5 mb-2 px-3 py-2 rounded-brand bg-red-500/10 border border-red-500/30 text-red-500 text-xs break-all">{error}</div>
        )}

        {/* Dim control pinned below the grid — stays reachable while the tiles scroll */}
        {terminalBackgrounds.length > 0 && (
          <div className="flex-shrink-0 border-t border-border px-5 pt-3 pb-5">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-sm text-text">{t("menu.bgDim")}</span>
              <span className="text-xs text-text-muted tabular-nums">{Math.round(opacity * 100)}%</span>
            </div>
            <input
              type="range"
              min={min}
              max={max}
              step={step}
              value={opacity}
              onChange={(e) => setTerminalBackgroundOpacity(Number(e.target.value))}
              className="brand-range"
              style={{ "--pct": pct }}
              aria-label={t("menu.bgDim")}
            />
          </div>
        )}
      </div>

      <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handlePickFile} />
    </div>,
    document.body
  );
}
