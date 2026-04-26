"use client";

import { useEffect, useRef, useState } from "react";
import Button from "@/shared/components/ui/Button";
import {
  ChevronLeft, RefreshCw, Keyboard, HelpCircle, Hand, Settings, MoreHorizontal, X
} from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import {
  REMOTE_CONFIG,
  REMOTE_KEY_POOL,
  REMOTE_DEFAULT_BOTTOM,
  REMOTE_DEFAULT_EXTRA,
  REMOTE_EXTRA_ROW_COUNT,
  REMOTE_PINNED_KEY_ID
} from "@/features/remote/constants/REMOTE_CONFIG";
import { useCustomKeys } from "@/shared/hooks/useCustomKeys";
import { useDeviceInfo } from "@/shared/hooks/useDeviceInfo";
import KeyCustomizeModal from "@/shared/components/ui/KeyCustomizeModal";
import { useI18n } from "@/shared/i18n";

const v = (fn, ...args) => { vibrate(); fn?.(...args); };

// onMouseDown.preventDefault() — prevents focus-steal so native keyboard stays on.
function Btn({ active, primary, pinned, children, className = "", onClick, ...rest }) {
  const base = "shrink-0 px-1 h-8 rounded-brand text-xs font-semibold shadow-sm disabled:opacity-50 disabled:cursor-not-allowed min-w-[34px] flex items-center justify-center";
  const normal = "bg-gradient-to-br from-dark-500 to-dark-600 hover:from-dark-400 hover:to-dark-500 active:from-dark-400 active:to-dark-500 text-white border border-dark-400 hover:border-brand-500";
  const activeCls = "bg-brand-500 text-white border border-brand-400 shadow-lg shadow-brand-500/20";
  const primaryCls = "bg-green-600 hover:bg-green-700 text-white border border-green-500";
  const pinnedCls = "bg-dark-700 hover:bg-dark-600 active:bg-dark-600 text-brand-300 border border-brand-500/40 hover:border-brand-500";
  const variant = active ? activeCls : pinned ? pinnedCls : primary ? primaryCls : normal;
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`${base} ${variant} ${className}`}
      style={{ touchAction: "manipulation", WebkitTapHighlightColor: "transparent" }}
      {...rest}
    >
      {children}
    </button>
  );
}

export default function RemoteControls({
  streaming,
  canvasZoom,
  selectionMode,
  pointerMode,
  handMode,
  inputMode,
  onToggleHandMode,
  onTogglePointerMode,
  modifierKeys,
  textInputValue,
  textInputRef,
  keyboardOn,
  showTextPanel,
  onResetZoom,
  onRefresh,
  onToggleSelection,
  onToggleModifier,
  onToggleKeyboard,
  onToggleTextPanel,
  onToggleHelp,
  onEmitKey,
  onTextInputChange,
  onTextInputFocus,
  onTextInputBlur,
  onTextInputKeyDown,
  onDirectInputChange,
  onSendText,
  onClose
}) {
  const { t } = useI18n();
  const { isIosPwa } = useDeviceInfo();
  const rowClass = "flex gap-1.5 overflow-auto scroll-fade-x scroll-thin-x landscape:no-fade px-2 py-1 pr-2 landscape:flex-wrap landscape:overflow-y-auto landscape:overflow-x-hidden landscape:py-2 landscape:pr-0 landscape:content-center landscape:justify-center rounded-lg";
  const panelInputRef = useRef(null);
  const [showExtra, setShowExtra] = useState(false);
  const [showCustomize, setShowCustomize] = useState(false);

  const bottomCustom = useCustomKeys("remoteDesktop.bottomKeys", REMOTE_KEY_POOL, REMOTE_DEFAULT_BOTTOM, "flat");
  const extraCustom = useCustomKeys("remoteDesktop.extraKeys", REMOTE_KEY_POOL, REMOTE_DEFAULT_EXTRA, "grid");

  // Auto-focus panel textarea after slide-in (350ms matches panel animation).
  useEffect(() => {
    if (!showTextPanel) return;
    const t = setTimeout(() => panelInputRef.current?.focus(), 350);
    return () => clearTimeout(t);
  }, [showTextPanel]);

  const pcCfg = REMOTE_CONFIG.pcModeControls;
  const show = (k) => inputMode !== "mouse" || pcCfg[k];

  // Render one pool key with correct handler
  const renderPoolKey = (kc, idx, pinned = false, extraClass = "") => {
    const textCls = kc.label.length > 1 ? "text-[11px]" : "";
    const cls = `${extraClass} ${textCls}`.trim();
    if (kc.type === "modifier") {
      return (
        <Btn
          key={kc.id + idx}
          onClick={() => v(onToggleModifier, kc.modifier)}
          disabled={!streaming}
          active={modifierKeys[kc.modifier]}
          pinned={pinned}
          className={cls}
        >
          {kc.label}
        </Btn>
      );
    }
    return (
      <Btn
        key={kc.id + idx}
        onClick={() => v(onEmitKey, kc.key, kc.modifiers || [])}
        disabled={!streaming}
        primary={!pinned && kc.primary}
        pinned={pinned}
        className={cls}
      >
        {kc.label}
      </Btn>
    );
  };

  return (
    <div className="bg-dark-700 select-none relative landscape:h-full landscape:flex landscape:flex-col landscape:w-72 landscape:shrink-0">
      {/* Hidden sink drives native keyboard. */}
      <textarea
        ref={textInputRef}
        rows={1}
        value={textInputValue}
        onChange={(e) => {
          if (keyboardOn && !showTextPanel) onDirectInputChange?.(e.target.value);
          else onTextInputChange(e.target.value);
        }}
        onKeyDown={onTextInputKeyDown}
        onFocus={onTextInputFocus}
        onBlur={onTextInputBlur}
        aria-hidden="true"
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        data-lpignore="true"
        data-1p-ignore="true"
        data-form-type="other"
        name="remote-keyboard-sink"
        style={{
          position: "absolute", opacity: 0.01, width: 1, height: 1, border: 0, padding: 0,
          left: 0, top: 0, fontSize: 16, resize: "none", pointerEvents: "none", zIndex: -1
        }}
      />

      <div className={`${showTextPanel ? "flex" : "hidden landscape:flex"} px-2 py-2 gap-2 landscape:order-last`}>
        <textarea
          ref={panelInputRef}
          rows={Math.min(2, (textInputValue.match(/\n/g) || []).length + 1)}
          value={textInputValue}
          onChange={(e) => onTextInputChange(e.target.value)}
          onFocus={onTextInputFocus}
          onKeyDown={(e) => {
            if (inputMode === "mouse" && e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (streaming && textInputValue.trim()) v(onSendText, streaming);
            }
          }}
          placeholder={inputMode === "mouse" ? t("remoteControls.enterToSend") : t("remoteControls.typeToSend")}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          data-lpignore="true"
          data-1p-ignore="true"
          data-form-type="other"
          name="remote-batch-input"
          className="w-full px-3 py-2 bg-dark-600 border border-dark-400 rounded text-white text-base placeholder-dark-100 focus:outline-none focus:ring-1 focus:ring-brand-500 transition-all duration-200 resize-none landscape:h-32"
          disabled={!streaming}
        />
        <Button
          variant="primary"
          size="sm"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => v(onSendText, streaming)}
          disabled={!streaming || !textInputValue.trim()}
        >
          {t("remoteControls.send")}
        </Button>
      </div>

      {/* Extra keys panel — slides in ABOVE toolbar, 3 scrollable rows */}
      <div
        className={`overflow-hidden transition-all duration-300 ${showExtra ? "max-h-56 opacity-100" : "max-h-0 opacity-0"}`}
      >
        <div className="p-2">
          <div className="space-y-1">
            {extraCustom.rows.map((row, rIdx) => (
              <div key={rIdx} className="flex items-center gap-1.5">
                <div className="flex-1 min-w-0 flex gap-1.5 overflow-x-auto scroll-fade-x scroll-thin-x pr-3 rounded-lg">
                  {row.map((id, cIdx) => {
                    const kc = REMOTE_KEY_POOL.find(p => p.id === id);
                    return kc ? renderPoolKey(kc, rIdx * 100 + cIdx) : null;
                  })}
                </div>
                {rIdx === 0 && (
                  <button
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => { vibrate(); setShowCustomize(true); }}
                    className="shrink-0 h-10 w-10 flex items-center justify-center text-dark-100 hover:text-white border border-dark-400 rounded-brand"
                    title={t("remote.customizeKeys")}
                  >
                    <Settings size={16} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Top toolbar — pin "..." at end, scroll rest */}
      <div className="flex items-center gap-1.5 px-2 py-1 landscape:py-2">
        <div className={`${rowClass} flex-1 min-w-0 px-0 py-0 landscape:py-0`}>
          <Btn onClick={() => v(onClose)} title={t("remote.back")} pinned>
            <ChevronLeft size={16} />
          </Btn>
          <Btn onClick={() => v(onResetZoom)} disabled={!streaming} className="text-dark-50" title={t("remote.resetZoom")}>
            {Math.round(canvasZoom * 100)}%
          </Btn>
          <Btn onClick={() => v(onRefresh)} disabled={!streaming} title={t("remote.refresh")}>
            <RefreshCw size={14} />
          </Btn>
          {show("rectangleSelect") && (
            <Btn onClick={() => v(onToggleSelection)} disabled={!streaming} active={selectionMode} title={t("remote.rectangleSelection")}>
              □
            </Btn>
          )}
          {show("pointerModeToggle") && (
            <Btn
              onClick={() => v(onTogglePointerMode)}
              disabled={!streaming}
              active={pointerMode === "trackpad"}
              title={pointerMode === "trackpad" ? t("remoteControls.trackpadMode") : t("remoteControls.directMode")}
            >
              <span className="text-base leading-none">🖱️</span>
            </Btn>
          )}
          {show("handMode") && pointerMode === "trackpad" && (
            <Btn
              onClick={() => v(onToggleHandMode)}
              disabled={!streaming}
              active={handMode}
              title={t("remote.handMode")}
            >
              <Hand size={14} />
            </Btn>
          )}
          {show("keyboardToggle") && (
            <Btn onClick={() => v(onToggleKeyboard)} disabled={!streaming} active={keyboardOn} title={t("remote.toggleKeyboard")}>
              <Keyboard size={14} />
            </Btn>
          )}
          {show("textPanel") && (
            <Btn onClick={() => v(onToggleTextPanel)} disabled={!streaming} active={showTextPanel} title={t("remote.textBatchInput")} className="landscape:hidden">
              Aa
            </Btn>
          )}
          {show("help") && (
            <Btn onClick={() => v(onToggleHelp)} title={t("remote.help")}>
              <HelpCircle size={14} />
            </Btn>
          )}
        </div>
        {/* Pinned expand button — always visible */}
        <Btn onClick={() => { vibrate(); setShowExtra(s => !s); }} active={showExtra} pinned title={t("remote.extraKeys")}>
          {showExtra ? <X size={16} /> : <MoreHorizontal size={16} />}
        </Btn>
      </div>

      {/* Bottom row (customizable) — pin Enter at end */}
      {show("modifierRow") && (
        <div className={`flex items-center gap-1.5 px-2 py-1 landscape:py-2 ${isIosPwa ? "safe-area-bottom" : ""}`}>
          <div className={`${rowClass} flex-1 min-w-0 px-0 py-0 landscape:py-0`}>
            {bottomCustom.keys
              .filter(kc => kc.id !== REMOTE_PINNED_KEY_ID)
              .map((kc, idx) => renderPoolKey(kc, idx))}
          </div>
          {/* Pinned Enter — always visible */}
          {(() => {
            const pinned = REMOTE_KEY_POOL.find(p => p.id === REMOTE_PINNED_KEY_ID);
            return pinned ? renderPoolKey(pinned, "pinned", true) : null;
          })()}
        </div>
      )}

      <KeyCustomizeModal
        isOpen={showCustomize}
        onClose={() => setShowCustomize(false)}
        title={t("remote.customizeRemoteKeys")}
        tabs={[
          { id: "bottom", label: t("remoteControls.bottomRow"), hook: bottomCustom, excludeIds: [REMOTE_PINNED_KEY_ID] },
          { id: "extra", label: t("remoteControls.extraPanel"), hook: extraCustom }
        ]}
      />
    </div>
  );
}
