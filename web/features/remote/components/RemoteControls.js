"use client";

import { useRef } from "react";
import Button from "@/shared/components/ui/Button";
import { ChevronLeft, RefreshCw, Keyboard, HelpCircle, Undo2, MousePointer2, Hand } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";

// Wrapper to add vibration to any callback
const v = (fn, ...args) => { vibrate(); fn?.(...args); };

// Local button — prevents focus-steal so native keyboard stays visible when ⌨️ is on.
// onMouseDown.preventDefault() stops the button from grabbing focus away from textInputRef.
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
  onSendText,
  onClose
}) {
  // Horizontal scroll on mobile: mirror terminal's MobileKeyboard (simple overflow-auto).
  // Hide scrollbar cross-browser.
  const rowClass = "flex gap-1.5 overflow-auto px-2 py-1.5";
  const rowStyle = { scrollbarWidth: "none", msOverflowStyle: "none" };
  // Separate ref for the visible batch-input panel — keeps the hidden native-keyboard input
  // always mounted so toggling "Aa" never unmounts the focused element (which would dismiss the keyboard).
  const panelInputRef = useRef(null);

  return (
    <div className="bg-dark-600 border-t border-dark-400 select-none relative">
      {/* Hidden input ALWAYS mounted — drives native keyboard when ⌨️ is on.
          Toggling Aa/panel must not unmount this element or the keyboard will dismiss. */}
      <input
        ref={textInputRef}
        type="text"
        value={keyboardOn && !showTextPanel ? "" : textInputValue}
        onChange={(e) => {
          // In direct keyboard mode, ignore value changes (keys go straight to agent via onKeyDown).
          if (!(keyboardOn && !showTextPanel)) onTextInputChange(e.target.value);
        }}
        onKeyDown={onTextInputKeyDown}
        onFocus={onTextInputFocus}
        onBlur={onTextInputBlur}
        aria-hidden="true"
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        style={{
          position: "absolute",
          opacity: 0.01,
          width: 1,
          height: 1,
          border: 0,
          padding: 0,
          left: 0,
          bottom: 0,
          pointerEvents: "none",
          zIndex: -1
        }}
      />

      {/* Text input panel (toggled by Aa) — visible batch input, mounted alongside hidden input */}
      {showTextPanel && (
        <div className="px-2 py-2 border-b border-dark-400 flex gap-2">
          <input
            ref={panelInputRef}
            type="text"
            value={textInputValue}
            onChange={(e) => onTextInputChange(e.target.value)}
            onKeyDown={onTextInputKeyDown}
            onFocus={onTextInputFocus}
            placeholder="Type text to send..."
            className="flex-1 px-3 py-2 bg-dark-700 border border-dark-400 rounded-brand text-white placeholder-dark-100 focus:outline-none focus:ring-1 focus:ring-brand-500 text-sm"
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
      )}

      {/* Row 1 — utility bar */}
      <div className={rowClass} style={rowStyle}>
        <Btn onClick={() => v(onClose)} title="Back">
          <ChevronLeft className="text-orange-400" size={16} />
        </Btn>
        <Btn onClick={() => v(onResetZoom)} disabled={!streaming} className="text-dark-50" title="Reset zoom">
          {Math.round(canvasZoom * 100)}%
        </Btn>
        <Btn onClick={() => v(onRefresh)} disabled={!streaming} title="Refresh">
          <RefreshCw size={14} />
        </Btn>
        <Btn onClick={() => v(onToggleSelection)} disabled={!streaming} active={selectionMode} title="Rectangle selection">
          □
        </Btn>
        <Btn
          onClick={() => v(onTogglePointerMode)}
          disabled={!streaming}
          active={pointerMode === "trackpad"}
          title={pointerMode === "trackpad" ? "Trackpad mode" : "Direct mode"}
        >
          <MousePointer2 size={14} />
        </Btn>
        {pointerMode === "trackpad" && (
          <Btn
            onClick={() => v(onToggleHandMode)}
            disabled={!streaming}
            active={handMode}
            title="Hand mode — long-press to hold mouse, drag to move, release to drop"
          >
            <Hand size={14} />
          </Btn>
        )}
        <Btn onClick={() => v(onToggleKeyboard)} disabled={!streaming} active={keyboardOn} title="Toggle native keyboard">
          <Keyboard size={14} />
        </Btn>
        <Btn onClick={() => v(onToggleTextPanel)} disabled={!streaming} active={showTextPanel} title="Text batch input">
          Aa
        </Btn>
        <Btn onClick={() => v(onToggleHelp)} title="Help">
          <HelpCircle size={14} />
        </Btn>
      </div>

      {/* Row 2 — keys bar */}
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
    </div>
  );
}
