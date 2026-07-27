"use client";

import { useEffect, useRef, useState } from "react";
import Button from "@/shared/components/ui/Button";
import {
  ChevronLeft, ChevronRight, RefreshCw, Keyboard, HelpCircle, Hand, Settings, MoreHorizontal, X, Bug, Monitor, Plus, CornerDownLeft, Mic, MicOff, History, Bell
} from "@/shared/components/ui/Icon";
import { useVoiceInput, localeToSpeechLang, useVoiceLang } from "@/shared/hooks/useVoiceInput";
import VoiceLangModal from "@/shared/components/ui/VoiceLangModal";
import CommandSuggestions from "@/shared/components/ui/CommandSuggestions";
import CommandHistoryModal from "@/shared/components/ui/CommandHistoryModal";
import { useRemoteHistoryStore } from "@/shared/stores/historyStore";
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
  const normal = "bg-surface-2 hover:bg-surface-3 text-text transition-all duration-150 ease-out active:scale-[0.94]";
  const activeCls = "bg-brand-500 text-white shadow-sm transition-all duration-150 ease-out active:scale-[0.94]";
  const primaryCls = "bg-green-600 hover:bg-green-700 text-white shadow-sm transition-all duration-150 ease-out active:scale-[0.94]";
  const pinnedCls = "bg-brand-500/15 hover:bg-brand-500/25 text-brand-400 transition-all duration-150 ease-out active:scale-[0.94]";
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
  clipboardNew,
  clipboardText,
  onOpenClipboard,
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
  onToggleDebug,
  debugOn,
  onEmitKey,
  onTextInputChange,
  onTextInputFocus,
  onTextInputBlur,
  onTextInputKeyDown,
  onDirectInputChange,
  onSendText,
  onClose,
  onDesktopSwitch
}) {
  const { t, locale } = useI18n();
  const { isIosPwa } = useDeviceInfo();
  const panelInputRef = useRef(null);
  // Voice dictation language: persisted, defaults to the UI locale. Chosen via modal.
  const [voiceLang, setVoiceLang] = useVoiceLang(locale);
  const [voiceLangOpen, setVoiceLangOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const voice = useVoiceInput({
    lang: localeToSpeechLang(voiceLang),
    onText: (txt) => {
      onTextInputChange(txt);
      // Keep caret at end + scroll so the user follows the incoming transcript.
      const el = panelInputRef.current;
      if (el) requestAnimationFrame(() => {
        try { el.selectionStart = el.selectionEnd = el.value.length; } catch {}
        el.scrollTop = el.scrollHeight;
      });
    },
  });
  // Auto-grow textarea from 1 row up to a max (portrait); landscape uses a fixed tall box via CSS.
  useEffect(() => {
    const el = panelInputRef.current;
    if (!el || window.matchMedia("(orientation: landscape)").matches) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 72)}px`;
  }, [textInputValue]);
  const toggleVoice = () => {
    if (voice.listening) { voice.stop(); return; }
    // Hide the native/soft keyboard while dictating.
    document.activeElement?.blur();
    voice.start(textInputValue);
  };
  const sendText = () => {
    if (voice.listening) voice.stop();
    v(onSendText, streaming);
  };
  const rowClass = "flex gap-1.5 overflow-auto scroll-thin-x py-0.5 pr-2 landscape:flex-wrap landscape:overflow-y-auto landscape:overflow-x-hidden landscape:py-2 landscape:pr-0 landscape:content-center landscape:justify-center rounded-lg";
  const [showExtra, setShowExtra] = useState(false);
  const [showCustomize, setShowCustomize] = useState(false);
  // Countdown shown on the clipboard button — mirrors RemoteDesktop's badge
  // timeout so the number reaches 0 just as the toolbar reverts to zoom-%.
  const [clipboardCountdown, setClipboardCountdown] = useState(0);
  useEffect(() => {
    if (!clipboardNew) { setClipboardCountdown(0); return; }
    setClipboardCountdown(Math.ceil(REMOTE_CONFIG.clipboardBadgeTimeout / 1000));
    const id = setInterval(() => {
      setClipboardCountdown(n => (n <= 1 ? 0 : n - 1));
    }, 1000);
    return () => clearInterval(id);
  }, [clipboardNew, clipboardText]);

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
  // Narrow viewport → fewer suggestion rows so the floating panel doesn't cover content.
  const isMobile = typeof window !== "undefined" && window.innerWidth < 768;

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
    if (kc.type === "desktop") {
      const SideIcon = kc.direction === "prev" ? ChevronLeft : kc.direction === "next" ? ChevronRight : Plus;
      return (
        <Btn
          key={kc.id + idx}
          onClick={() => v(onDesktopSwitch, kc.direction)}
          disabled={!streaming}
          pinned={pinned}
          className={cls}
          title={`${kc.direction} desktop`}
        >
          <Monitor size={12} />
          <SideIcon size={kc.direction === "new" ? 10 : 12} className="-ml-0.5" />
        </Btn>
      );
    }
    return (
      <Btn
        key={kc.id + idx}
        onClick={() => v(onEmitKey, kc.key, kc.modifiers || [], kc.osAdaptive)}
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
    <div className="bg-bg select-none relative landscape:h-full landscape:flex landscape:flex-col landscape:w-72 landscape:shrink-0">
      {/* Hidden sink drives native keyboard. */}
      <textarea
        ref={textInputRef}
        rows={1}
        value={textInputValue}
        onChange={(e) => {
          if (keyboardOn) onDirectInputChange?.(e.target.value);
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

      <div className={`${showTextPanel ? "flex" : "hidden landscape:flex"} relative z-30 px-2 py-1 gap-2 items-end landscape:order-last`}>
        <div className="relative flex-1">
          <CommandSuggestions
            value={textInputValue}
            store={useRemoteHistoryStore}
            isMobile={isMobile}
            onSelect={(cmd) => { onTextInputChange(cmd); panelInputRef.current?.focus(); }}
          />
          <textarea
            ref={panelInputRef}
            rows={1}
            value={textInputValue}
            onChange={(e) => onTextInputChange(e.target.value)}
            onFocus={onTextInputFocus}
            onKeyDown={(e) => {
              if (inputMode === "mouse" && e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (streaming) sendText();
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
            className="block w-full px-3 py-2 pr-8 bg-surface-2 rounded text-text text-sm placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-brand-500/40 transition-all duration-150 ease-out resize-none overflow-y-auto landscape:!h-32"
            disabled={!streaming}
          />
          {textInputValue ? (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { onTextInputChange(""); panelInputRef.current?.focus(); }}
              title={t("voice.clear")}
              className="absolute right-1.5 top-1.5 w-5 h-5 flex items-center justify-center text-text-muted hover:text-text transition-colors"
            >
              <X size={14} />
            </button>
          ) : (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setHistoryOpen(true)}
              title={t("history.title")}
              className="absolute right-1.5 top-1.5 w-5 h-5 flex items-center justify-center text-text-muted hover:text-text transition-colors"
            >
              <History size={14} />
            </button>
          )}
        </div>
        {voice.supported && (
          <div className="relative shrink-0">
            {voice.listening && (
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setVoiceLangOpen(true)}
                title={t("voice.language")}
                className="absolute -top-9 left-1/2 -translate-x-1/2 z-50 px-2.5 py-1 rounded-brand bg-surface-2 shadow-lg text-[11px] font-semibold uppercase text-text-muted hover:text-text transition-colors"
              >
                {voiceLang}
              </button>
            )}
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={toggleVoice}
              disabled={!streaming}
              title={voice.error === "not-allowed" || voice.error === "service-not-allowed" ? t("voice.denied") : t("voice.dictate")}
              className={`h-9 w-9 flex items-center justify-center rounded-full transition-all duration-150 ease-out disabled:opacity-40 ${
                voice.listening ? "bg-red-500/90 text-white animate-pulse" : voice.error ? "bg-surface-2 text-red-400" : "bg-surface-2 hover:bg-surface-3 text-text-muted hover:text-text"
              }`}
            >
              {voice.listening ? <MicOff size={18} /> : <Mic size={18} />}
            </button>
          </div>
        )}
        <Button
          variant="primary"
          size="sm"
          className="!px-2.5 shrink-0"
          onMouseDown={(e) => e.preventDefault()}
          onClick={sendText}
          disabled={!streaming}
        >
          {textInputValue.trim() ? t("remoteControls.send") : <CornerDownLeft size={16} strokeWidth={2.5} />}
        </Button>
      </div>

      {/* Extra keys panel — slides in ABOVE toolbar, 3 scrollable rows */}
      <div
        className={`overflow-hidden transition-all duration-300 ${showExtra ? "max-h-56 opacity-100" : "max-h-0 opacity-0"}`}
      >
        <div className="px-2 py-1">
          <div className="space-y-1">
            {extraCustom.rows.map((row, rIdx) => (
              <div key={rIdx} className="flex items-center gap-1.5">
                <div className="flex-1 min-w-0 flex gap-1.5 overflow-x-auto scroll-thin-x pr-3 rounded-lg">
                  {row.map((id, cIdx) => {
                    const kc = REMOTE_KEY_POOL.find(p => p.id === id);
                    return kc ? renderPoolKey(kc, rIdx * 100 + cIdx) : null;
                  })}
                </div>
                {rIdx === 0 && (
                  <button
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => { vibrate(); setShowCustomize(true); }}
                    className="shrink-0 h-10 w-10 flex items-center justify-center text-text-muted hover:text-text bg-surface-2 hover:bg-surface-3 rounded-brand transition-all duration-150 ease-out"
                    title={t("remote.customizeKeys")}
                  >
                    <Settings size={16} />
                  </button>
                )}
                {rIdx === 1 && onToggleDebug && (
                  <button
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => { vibrate(); onToggleDebug(); }}
                    className={`shrink-0 h-10 w-10 flex items-center justify-center rounded-brand transition-all duration-150 ease-out ${debugOn ? "bg-brand-500 text-white" : "text-text-muted hover:text-text bg-surface-2 hover:bg-surface-3"}`}
                    title={t("remote.debug")}
                  >
                    <Bug size={16} />
                  </button>
                )}
                {rIdx > 1 && <div className="shrink-0 h-10 w-10" />}
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
          {clipboardNew && clipboardText ? (
            <Btn
              onClick={() => v(onOpenClipboard)}
              className="!text-red-500"
              title={t("common.clipboard")}
            >
              <Bell size={14} className="shrink-0" />
              <span className="tabular-nums">{clipboardCountdown}</span>
            </Btn>
          ) : (
            <Btn onClick={() => v(onResetZoom)} disabled={!streaming} className="text-text" title={t("remote.resetZoom")}>
              {Math.round(canvasZoom * 100)}%
            </Btn>
          )}
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
      <VoiceLangModal
        isOpen={voiceLangOpen}
        value={voiceLang}
        onSelect={setVoiceLang}
        onClose={() => setVoiceLangOpen(false)}
      />
      <CommandHistoryModal
        isOpen={historyOpen}
        store={useRemoteHistoryStore}
        onSelect={(cmd) => { onTextInputChange(cmd); panelInputRef.current?.focus(); }}
        onClose={() => setHistoryOpen(false)}
      />
    </div>
  );
}
