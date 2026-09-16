"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { useI18n } from "@/shared/i18n";
import { X, ImageOff } from "@/shared/components/ui/Icon";
import { TERMINAL_BACKGROUNDS, TERMINAL_BG_ALPHA, TERMINAL_BG_OPACITY, TERMINAL_BG_PREVIEW_ALPHA, resolvableBackgroundKeys } from "@/features/terminal/constants/terminalConfig";

const NONE_KEY = "none";

// Per-session background picker: grid of wallpapers, plus a first tile that drops the
// override so the pane follows the global pool again. Tiles carry a light veil only —
// the pane's real veil is nearly opaque, which would make every thumbnail read as black.
// "Apply to all" flips the grid into the pool multi-select the settings sheet uses,
// so one terminal can push its wallpaper to every pane in the workspace.
export default function SessionBackgroundModal({ sessionId, title, onClose }) {
  const { t } = useI18n();
  const current = useTerminalStore((s) => s.backgroundBySession[sessionId]);
  const setSessionBackground = useTerminalStore((s) => s.setSessionBackground);
  const customBackgrounds = useTerminalStore((s) => s.customBackgrounds);
  const pool = useTerminalStore((s) => s.terminalBackgrounds);
  const setPool = useTerminalStore((s) => s.setTerminalBackgrounds);
  const setTerminalBackgroundOpacity = useTerminalStore((s) => s.setTerminalBackgroundOpacity);
  const opacity = useTerminalStore((s) => s.terminalBackgroundOpacity) ?? TERMINAL_BG_ALPHA;
  const [applyAll, setApplyAll] = useState(false);

  if (typeof document === "undefined") return null;

  // Pool pruned of dead custom keys — badges follow what actually renders
  const poolKeys = resolvableBackgroundKeys(pool, customBackgrounds);

  // Single-pick mode pins the wallpaper to this terminal and closes; pool mode toggles
  // the shared list and keeps the modal open so several can be picked in a row.
  const pick = (key) => {
    if (!applyAll) {
      setSessionBackground(sessionId, key);
      onClose?.();
      return;
    }
    if (key === NONE_KEY) { setPool([]); return; }
    setPool(poolKeys.includes(key) ? poolKeys.filter((k) => k !== key) : [...poolKeys, key]);
  };

  const selected = current ?? null;
  const tiles = [
    ...Object.entries(TERMINAL_BACKGROUNDS).map(([key, preset]) => ({ key, label: preset.label, src: preset.src })),
    ...customBackgrounds.map((it) => ({ key: `custom:${it.id}`, label: t("menu.bgCustomLabel"), src: it.dataUrl }))
  ];

  const renderTile = ({ key, label, src }) => {
    const isNone = key === NONE_KEY;
    const order = isNone ? -1 : poolKeys.indexOf(key);
    const isSelected = applyAll ? (isNone ? poolKeys.length === 0 : order !== -1) : selected === key;
    return (
      <button
        key={key ?? "global"}
        type="button"
        onClick={() => pick(key)}
        className={`relative block w-full aspect-[9/16] rounded-2xl overflow-hidden transition-transform duration-200 ease-out active:scale-[0.97] ${
          isSelected ? "" : "hover:-translate-y-0.5"
        }`}
      >
        {src ? (
          <img
            src={src}
            alt={label}
            className="absolute inset-0 h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface-2 text-text-muted">
            <ImageOff size={22} strokeWidth={1.75} />
            <span className="text-[11px] font-medium">{isNone ? TERMINAL_BACKGROUNDS.none.label : label}</span>
          </span>
        )}

        {/* Light veil only: enough to make white labels legible, not the pane's real dim */}
        {src && <span className="pointer-events-none absolute inset-0" style={{ background: `rgba(0,0,0,${TERMINAL_BG_PREVIEW_ALPHA})` }} />}
        {src && <span className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/70 to-transparent" />}
        {src && (
          <span className="absolute bottom-1.5 inset-x-0 px-2 text-[11px] font-medium text-white truncate text-center">{label}</span>
        )}

        <span className={`pointer-events-none absolute inset-0 rounded-2xl ${
          isSelected ? "ring-1 ring-inset ring-brand-500" : "ring-1 ring-inset ring-white/15"
        }`} />

        {/* Pool turn — the panes round-robin in this order */}
        {applyAll && isSelected && !isNone && (
          <span className="absolute top-1.5 right-1.5 flex items-center justify-center w-5 h-5 rounded-full bg-brand-500 text-white text-[11px] font-semibold shadow-lg">
            {order + 1}
          </span>
        )}
      </button>
    );
  };

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px] animate-in fade-in duration-200" onClick={onClose} />

      <div className="relative w-full max-w-lg max-h-[80vh] rounded-brand-lg border border-border-subtle bg-surface shadow-2xl flex flex-col overflow-hidden animate-in zoom-in-95 duration-200">
        <div className="px-5 py-3 flex items-center justify-between flex-shrink-0 border-b border-border-subtle">
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 bg-brand-500/15 text-brand-500">
              <ImageOff size={13} />
            </span>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-text truncate">{t("menu.terminalBackground")}</h2>
              {title && <p className="text-[11px] text-text-muted truncate">{title}</p>}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-brand text-text-muted hover:text-text hover:bg-surface-2 transition-colors flex-shrink-0"
            aria-label={t("common.close")}
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto modal-scrollable px-4 py-4">
          <div className="grid grid-cols-3 gap-3">{tiles.map(renderTile)}</div>
        </div>

        {/* Dim is global — one veil value for every pane, not per session */}
        <div className="flex-shrink-0 border-t border-border-subtle px-4 py-3 flex items-center gap-3">
          <span className="text-xs text-text flex-shrink-0">{t("menu.bgDim")}</span>
          <input
            type="range"
            min={TERMINAL_BG_OPACITY.min}
            max={TERMINAL_BG_OPACITY.max}
            step={TERMINAL_BG_OPACITY.step}
            value={opacity}
            onChange={(e) => setTerminalBackgroundOpacity(Number(e.target.value))}
            className="brand-range flex-1 min-w-0"
            style={{ "--pct": `${((opacity - TERMINAL_BG_OPACITY.min) / (TERMINAL_BG_OPACITY.max - TERMINAL_BG_OPACITY.min)) * 100}%` }}
            aria-label={t("menu.bgDim")}
          />
          <span className="text-xs text-text-muted tabular-nums flex-shrink-0">{Math.round(opacity * 100)}%</span>
        </div>

        <label className="flex-shrink-0 border-t border-border-subtle px-4 py-3 flex items-center gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            checked={applyAll}
            onChange={(e) => setApplyAll(e.target.checked)}
            className="accent-brand-500 w-3.5 h-3.5 flex-shrink-0"
          />
          <span className="text-xs text-text">{t("menu.bgApplyAll")}</span>
        </label>
      </div>
    </div>,
    document.body
  );
}
