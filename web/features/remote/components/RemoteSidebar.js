"use client";

import { ChevronLeft, HelpCircle, Keyboard, RefreshCw, Hand } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";

// Landscape-only left toolbar: back, refresh, zoom, pointer mode, hand, keyboard,
// help, rectangle select. Extracted from RemoteDesktop — same buttons, same order.
const BASE = "shrink-0 w-9 h-9 rounded-brand flex items-center justify-center transition-all duration-150 active:scale-[0.94]";
const NEUTRAL = "bg-surface-2 hover:bg-surface-3 text-text";
const MUTED = "bg-surface-2 hover:bg-surface-3 text-text-muted hover:text-text";
const ACTIVE = "bg-brand-500 text-white";

function ToolButton({ onClick, title, disabled, className, children }) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => { vibrate(); onClick(); }}
      disabled={disabled}
      title={title}
      className={`${BASE} ${className} ${disabled ? "disabled:opacity-50" : ""}`}
    >
      {children}
    </button>
  );
}

export default function RemoteSidebar({
  streaming, canvasZoom, pointerMode, handMode, keyboardOn, selectionMode,
  show, onBack, onRefresh, onResetZoom, onTogglePointerMode, onToggleHandMode,
  onToggleKeyboard, onShowHelp, onToggleSelection
}) {
  const { t } = useI18n();

  return (
    <div className="hidden landscape:flex flex-col items-center gap-1.5 py-2 px-1 bg-bg shrink-0 landscape:w-12 z-20">
      <ToolButton
        onClick={onBack}
        title={t("remote.back")}
        className="bg-brand-500/15 hover:bg-brand-500/25 text-brand-400"
      >
        <ChevronLeft size={18} />
      </ToolButton>

      <ToolButton onClick={onRefresh} disabled={!streaming} title={t("remote.refresh")} className={MUTED}>
        <RefreshCw size={16} />
      </ToolButton>

      <ToolButton
        onClick={onResetZoom}
        disabled={!streaming}
        title={t("remote.resetZoom")}
        className={`text-[10px] font-semibold ${NEUTRAL}`}
      >
        {Math.round(canvasZoom * 100)}%
      </ToolButton>

      {show("pointerModeToggle") && (
        <ToolButton
          onClick={onTogglePointerMode}
          disabled={!streaming}
          title={pointerMode === "trackpad" ? t("remoteControls.trackpadMode") : t("remoteControls.directMode")}
          className={`text-base leading-none ${pointerMode === "trackpad" ? ACTIVE : NEUTRAL}`}
        >
          🖱️
        </ToolButton>
      )}

      {show("handMode") && pointerMode === "trackpad" && (
        <ToolButton
          onClick={onToggleHandMode}
          disabled={!streaming}
          title={t("remote.handMode")}
          className={handMode ? ACTIVE : NEUTRAL}
        >
          <Hand size={16} />
        </ToolButton>
      )}

      {show("keyboardToggle") && (
        <ToolButton
          onClick={onToggleKeyboard}
          disabled={!streaming}
          title={t("remote.toggleKeyboard")}
          className={keyboardOn ? ACTIVE : MUTED}
        >
          <Keyboard size={16} />
        </ToolButton>
      )}

      {show("help") && (
        <ToolButton onClick={onShowHelp} title={t("remote.help")} className={MUTED}>
          <HelpCircle size={16} />
        </ToolButton>
      )}

      {show("rectangleSelect") && (
        <ToolButton
          onClick={onToggleSelection}
          disabled={!streaming}
          title={t("remote.rectangleSelection")}
          className={selectionMode ? ACTIVE : NEUTRAL}
        >
          □
        </ToolButton>
      )}
    </div>
  );
}
