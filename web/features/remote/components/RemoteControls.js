"use client";

import { useEffect, useRef } from "react";
import Button from "@/shared/components/ui/Button";
import { ChevronLeft, RefreshCw, Keyboard, HelpCircle, Undo2, Hand } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { REMOTE_CONFIG } from "@/features/remote/constants/REMOTE_CONFIG";

const v = (fn, ...args) => { vibrate(); fn?.(...args); };

// onMouseDown.preventDefault() — prevents focus-steal so native keyboard stays on.
function Btn({ active, primary, children, className = "", onClick, ...rest }) {
  const base = "shrink-0 px-3 py-2 rounded-brand text-xs font-semibold transition-all duration-200 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed min-w-[44px] flex items-center justify-center";
  const normal = "bg-gradient-to-br from-dark-500 to-dark-600 hover:from-dark-400 hover:to-dark-500 active:from-dark-400 active:to-dark-500 text-white border border-dark-400 hover:border-brand-500";
  const activeCls = "bg-brand-500 text-white border border-brand-400 shadow-lg shadow-brand-500/20";
  const primaryCls = "bg-green-600 hover:bg-green-700 text-white border border-green-500";
  const variant = primary ? primaryCls : active ? activeCls : normal;
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`${base} ${variant} ${className}`}
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
  onEscKey,
  onTabKey,
  onEnterKey,
  onBackspace,
  onUndo,
  onTextInputChange,
  onTextInputFocus,
  onTextInputBlur,
  onTextInputKeyDown,
  onDirectInputChange,
  onSendText,
  onClose
}) {
  const rowClass = "flex gap-1.5 overflow-auto px-2 py-1.5 landscape:flex-wrap landscape:overflow-y-auto landscape:overflow-x-hidden landscape:py-2 landscape:content-center landscape:justify-center";
  const rowStyle = { scrollbarWidth: "none", msOverflowStyle: "none" };
  const panelInputRef = useRef(null);

  // Auto-focus panel textarea after slide-in (350ms matches panel animation).
  useEffect(() => {
    if (!showTextPanel) return;
    const t = setTimeout(() => panelInputRef.current?.focus(), 350);
    return () => clearTimeout(t);
  }, [showTextPanel]);

  const pcCfg = REMOTE_CONFIG.pcModeControls;
  const show = (k) => inputMode !== "mouse" || pcCfg[k];

  return (
    <div className="bg-dark-600 border-t border-dark-400 select-none relative landscape:border-t-0 landscape:border-l landscape:h-full landscape:flex landscape:flex-col landscape:w-72 landscape:shrink-0">
      {/* Hidden sink drives native keyboard. Use <textarea> (not <input>) to skip
          iOS/Android AutoFill bar + top:0 anchor to keep offsetTop=0 on iOS. */}
      <textarea
        ref={textInputRef}
        rows={1}
        value={textInputValue}
        onChange={(e) => {
          // Android IME sends chars via onChange (keyDown.key="Unidentified").
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
          position: "absolute",
          opacity: 0.01,
          width: 1,
          height: 1,
          border: 0,
          padding: 0,
          left: 0,
          top: 0,
          fontSize: 16, // 16px prevents iOS auto-zoom on focus
          resize: "none",
          pointerEvents: "none",
          zIndex: -1
        }}
      />

      <div className={`${showTextPanel ? "flex" : "hidden landscape:flex"} px-2 py-2 border-b border-dark-400 gap-2 landscape:border-b-0 landscape:border-t landscape:order-last`}>
          <textarea
            ref={panelInputRef}
            rows={Math.min(2, (textInputValue.match(/\n/g) || []).length + 1)}
            value={textInputValue}
            onChange={(e) => onTextInputChange(e.target.value)}
            onFocus={onTextInputFocus}
            placeholder="Type text to send..."
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
            Send
          </Button>
      </div>

      <div className={`${rowClass} landscape:border-b landscape:border-dark-400`} style={rowStyle}>
        <Btn onClick={() => v(onClose)} title="Back">
          <ChevronLeft className="text-orange-400" size={16} />
        </Btn>
        <Btn onClick={() => v(onResetZoom)} disabled={!streaming} className="text-dark-50" title="Reset zoom">
          {Math.round(canvasZoom * 100)}%
        </Btn>
        <Btn onClick={() => v(onRefresh)} disabled={!streaming} title="Refresh">
          <RefreshCw size={14} />
        </Btn>
        {show("rectangleSelect") && (
          <Btn onClick={() => v(onToggleSelection)} disabled={!streaming} active={selectionMode} title="Rectangle selection">
            □
          </Btn>
        )}
        {show("pointerModeToggle") && (
          <Btn
            onClick={() => v(onTogglePointerMode)}
            disabled={!streaming}
            active={pointerMode === "trackpad"}
            title={pointerMode === "trackpad" ? "Trackpad mode" : "Direct mode"}
          >
            <span className="text-base leading-none">🖱️</span>
          </Btn>
        )}
        {show("handMode") && pointerMode === "trackpad" && (
          <Btn
            onClick={() => v(onToggleHandMode)}
            disabled={!streaming}
            active={handMode}
            title="Hand mode — long-press to hold mouse, drag to move, release to drop"
          >
            <Hand size={14} />
          </Btn>
        )}
        {show("keyboardToggle") && (
          <Btn onClick={() => v(onToggleKeyboard)} disabled={!streaming} active={keyboardOn} title="Toggle native keyboard">
            <Keyboard size={14} />
          </Btn>
        )}
        {show("textPanel") && (
          <Btn onClick={() => v(onToggleTextPanel)} disabled={!streaming} active={showTextPanel} title="Text batch input" className="landscape:hidden">
            Aa
          </Btn>
        )}
        {show("help") && (
          <Btn onClick={() => v(onToggleHelp)} title="Help">
            <HelpCircle size={14} />
          </Btn>
        )}
      </div>

      {show("modifierRow") && (
        <div className={rowClass} style={rowStyle}>
          <Btn onClick={() => v(onEscKey, streaming)} disabled={!streaming}>Esc</Btn>
          <Btn onClick={() => v(onUndo)} disabled={!streaming} className="gap-1" title="Ctrl+Z">
            <Undo2 size={12} /> Undo
          </Btn>
          <Btn onClick={() => v(onTabKey, streaming)} disabled={!streaming}>Tab</Btn>
          {["ctrl", "alt", "shift", "cmd"].map((key) => (
            <Btn key={key} onClick={() => v(onToggleModifier, key)} disabled={!streaming} active={modifierKeys[key]}>
              {key === "cmd" ? "⌘" : key.charAt(0).toUpperCase() + key.slice(1)}
            </Btn>
          ))}
          <Btn onClick={() => v(onBackspace, streaming)} disabled={!streaming}>⌫</Btn>
          <Btn onClick={(e) => v(onEnterKey, e, streaming)} disabled={!streaming} primary>↵</Btn>
        </div>
      )}
    </div>
  );
}
