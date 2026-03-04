"use client";

import Button from "@/shared/components/ui/Button";
import Input from "@/shared/components/ui/Input";
import { ChevronLeft, RefreshCw } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";

// Wrapper to add vibration to any callback
const v = (fn, ...args) => { vibrate(); fn?.(...args); };

// Remote Desktop Controls component
// Transport status — same style as other buttons, not clickable
function TransportBadge({ transport }) {
  const textColor = {
    "dc-stun": "text-green-400",
    "dc-turn": "text-blue-400",
    "ws":      "text-dark-200"
  }[transport] || "text-dark-200";

  const label = {
    "dc-stun": "P2P",
    "dc-turn": "RTC",
    "ws":      "WS"
  }[transport] || "WS";

  return (
    <div className={`px-2 py-1.5 rounded-brand text-xs font-semibold shadow-sm bg-gradient-to-br from-dark-500 to-dark-600 border border-dark-400 cursor-default select-none text-center ${textColor}`}>
      {label}
    </div>
  );
}

export default function RemoteControls({
  streaming,
  connected,
  transport,
  canvasZoom,
  selectionMode,
  dragMode,
  isDragging,
  modifierKeys,
  textInputValue,
  textInputRef,
  keyboardVisible,
  isLandscape,
  onStartStreaming,
  onStopStreaming,
  onResetZoom,
  onRefresh,
  onToggleSelection,
  onToggleDrag,
  onToggleModifier,
  onScrollUp,
  onScrollDown,
  onScrollLeft,
  onScrollRight,
  onStopScrolling,
  onArrowKey,
  onEscKey,
  onTabKey,
  onEnterKey,
  onBackspace,
  onTextInputChange,
  onTextInputFocus,
  onTextInputKeyDown,
  onSendText,
  onClose
}) {
  const btnBase = "px-2 py-1.5 rounded-brand text-xs font-semibold transition-all duration-200 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed";
  const btnNormal = "bg-gradient-to-br from-dark-500 to-dark-600 hover:from-dark-400 hover:to-dark-500 active:from-dark-400 active:to-dark-500 text-white border border-dark-400 hover:border-brand-500";

  // Landscape mode - vertical compact layout
  if (isLandscape) {
    return (
      <div className="w-[25vw] h-full bg-dark-600 border-l border-dark-400 p-2 flex flex-col gap-2 overflow-y-auto">
        {/* Top buttons */}
        <div className="grid grid-cols-2 gap-1">
          <button
            onClick={() => v(onClose)}
            className={`${btnBase} ${btnNormal} flex items-center justify-center`}
            title="Back"
          >
            <ChevronLeft className="text-orange-400" size={14} />
          </button>
          <button
            onClick={() => v(onRefresh)}
            disabled={!streaming}
            className={`${btnBase} ${btnNormal} flex items-center justify-center`}
          >
            <RefreshCw size={12} />
          </button>
        </div>
        <TransportBadge transport={transport} />

        {/* Zoom & Selection */}
        <div className="grid grid-cols-2 gap-1">
          <button
            onClick={() => v(onResetZoom)}
            disabled={!streaming}
            className={`${btnBase} ${btnNormal} text-dark-50 text-[10px]`}
          >
            {Math.round(canvasZoom * 100)}%
          </button>
          <button
            onClick={() => v(onToggleSelection)}
            disabled={!streaming}
            className={`${btnBase} ${selectionMode ? "bg-brand-500 text-white" : btnNormal}`}
          >
            □
          </button>
        </div>

        {/* Arrow keys */}
        <div className="grid grid-cols-3 gap-1">
          <div />
          <button
            onClick={() => v(onArrowKey, "up", streaming)}
            disabled={!streaming}
            className={`${btnBase} ${btnNormal}`}
          >
            ↑
          </button>
          <div />
          <button
            onClick={() => v(onArrowKey, "left", streaming)}
            disabled={!streaming}
            className={`${btnBase} ${btnNormal}`}
          >
            ←
          </button>
          <button
            onClick={() => v(onArrowKey, "down", streaming)}
            disabled={!streaming}
            className={`${btnBase} ${btnNormal}`}
          >
            ↓
          </button>
          <button
            onClick={() => v(onArrowKey, "right", streaming)}
            disabled={!streaming}
            className={`${btnBase} ${btnNormal}`}
          >
            →
          </button>
        </div>

        {/* Scroll */}
        <div className="grid grid-cols-2 gap-1">
          <button
            onMouseDown={(e) => { e.preventDefault(); v(onScrollUp, streaming); }}
            onMouseUp={onStopScrolling}
            onMouseLeave={onStopScrolling}
            onTouchStart={(e) => { e.preventDefault(); v(onScrollUp, streaming); }}
            onTouchEnd={onStopScrolling}
            disabled={!streaming}
            className={`${btnBase} ${btnNormal} select-none`}
          >
            ⇈
          </button>
          <button
            onMouseDown={(e) => { e.preventDefault(); v(onScrollDown, streaming); }}
            onMouseUp={onStopScrolling}
            onMouseLeave={onStopScrolling}
            onTouchStart={(e) => { e.preventDefault(); v(onScrollDown, streaming); }}
            onTouchEnd={onStopScrolling}
            disabled={!streaming}
            className={`${btnBase} ${btnNormal} select-none`}
          >
            ⇊
          </button>
        </div>

        {/* Special keys */}
        <div className="grid grid-cols-2 gap-1">
          <button
            onClick={() => v(onEscKey, streaming)}
            disabled={!streaming}
            className={`${btnBase} ${btnNormal} text-[10px]`}
          >
            ESC
          </button>
          <button
            onClick={() => v(onTabKey, streaming)}
            disabled={!streaming}
            className={`${btnBase} ${btnNormal} text-[10px]`}
          >
            TAB
          </button>
        </div>

        {/* Drag & Backspace */}
        <div className="grid grid-cols-2 gap-1">
          <button
            onClick={() => v(onToggleDrag)}
            disabled={!streaming}
            className={`${btnBase} ${
              dragMode
                ? isDragging
                  ? "bg-red-500 text-white animate-pulse"
                  : "bg-green-500 text-white"
                : btnNormal
            }`}
          >
            ✋
          </button>
          <button
            onClick={() => v(onBackspace, streaming)}
            disabled={!streaming}
            className={`${btnBase} ${btnNormal}`}
          >
            ⌫
          </button>
        </div>

        {/* Modifiers */}
        <div className="grid grid-cols-2 gap-1">
          {["ctrl", "cmd", "alt", "shift"].map((key) => (
            <button
              key={key}
              onClick={() => v(onToggleModifier, key)}
              disabled={!streaming}
              className={`${btnBase} text-[10px] ${
                modifierKeys[key]
                  ? "bg-brand-500 text-white"
                  : btnNormal
              }`}
            >
              {key === "cmd" ? "Cmd" : key.charAt(0).toUpperCase() + key.slice(1)}
            </button>
          ))}
        </div>

        {/* Enter */}
        <button
          onClick={(e) => v(onEnterKey, e, streaming)}
          disabled={!streaming}
          className={`${btnBase} bg-green-600 hover:bg-green-700 text-white w-full`}
        >
          Enter
        </button>

        {/* Text input - compact */}
        <div className="mt-auto">
          <input
            ref={textInputRef}
            type="text"
            value={textInputValue}
            onChange={(e) => onTextInputChange(e.target.value)}
            onKeyDown={onTextInputKeyDown}
            onFocus={onTextInputFocus}
            placeholder="Type..."
            className="w-full px-2 py-1.5 bg-dark-600 border border-dark-400 rounded-brand text-white placeholder-dark-100 focus:outline-none focus:ring-1 focus:ring-brand-500 text-xs"
            disabled={!streaming}
          />
          <Button
            variant="primary"
            size="sm"
            onClick={() => v(onSendText, streaming)}
            disabled={!streaming || !textInputValue.trim()}
            className="w-full mt-1 text-xs"
          >
            Send
          </Button>
        </div>
      </div>
    );
  }
  
  // Portrait mode - horizontal layout (original)
  return (
    <div 
      className="p-3 bg-dark-600 border-t border-dark-400"
    >
      {/* Main Controls */}
      <div className="flex flex-row items-center justify-center mb-3">
        <div className="flex-1 grid grid-cols-5 gap-2">
          {/* Back - Return to terminal */}
          <button
            onClick={() => v(onClose)}
            className={`${btnBase} ${btnNormal} flex items-center justify-center gap-1`}
            title="Back to Terminal"
          >
            <ChevronLeft className="text-orange-400" size={16} />
          </button>

          {/* Zoom */}
          <button
            onClick={() => v(onResetZoom)}
            disabled={!streaming}
            className={`${btnBase} ${btnNormal} text-dark-50`}
          >
            {Math.round(canvasZoom * 100)}%
          </button>

          {/* Refresh */}
          <button
            onClick={() => v(onRefresh)}
            disabled={!streaming}
            className={`${btnBase} ${btnNormal} flex items-center justify-center`}
          >
            <RefreshCw size={14} />
          </button>

          {/* Selection */}
          <button
            onClick={() => v(onToggleSelection)}
            disabled={!streaming}
            className={`${btnBase} ${selectionMode ? "bg-brand-500 text-white shadow-lg shadow-brand-500/20" : btnNormal}`}
          >
            □
          </button>

          {/* Transport status */}
          <TransportBadge transport={transport} />
        </div>

      </div>

      {/* Navigation Controls */}
      <div className="space-y-2 mb-3">
        <div className="grid grid-cols-6 gap-1">
          <button
            onClick={() => v(onEscKey, streaming)}
            disabled={!streaming}
            className={`${btnBase} ${btnNormal}`}
          >
            ESC
          </button>
          <button
            onClick={() => v(onArrowKey, "up", streaming)}
            disabled={!streaming}
            className={`${btnBase} ${btnNormal}`}
          >
            ↑
          </button>
          <button
            onClick={() => v(onArrowKey, "down", streaming)}
            disabled={!streaming}
            className={`${btnBase} ${btnNormal}`}
          >
            ↓
          </button>
          <button
            onMouseDown={(e) => { e.preventDefault(); v(onScrollUp, streaming); }}
            onMouseUp={onStopScrolling}
            onMouseLeave={onStopScrolling}
            onTouchStart={(e) => { e.preventDefault(); v(onScrollUp, streaming); }}
            onTouchEnd={onStopScrolling}
            disabled={!streaming}
            className={`${btnBase} ${btnNormal} select-none`}
          >
            ⇈
          </button>
          <button
            onMouseDown={(e) => { e.preventDefault(); v(onScrollDown, streaming); }}
            onMouseUp={onStopScrolling}
            onMouseLeave={onStopScrolling}
            onTouchStart={(e) => { e.preventDefault(); v(onScrollDown, streaming); }}
            onTouchEnd={onStopScrolling}
            disabled={!streaming}
            className={`${btnBase} ${btnNormal} select-none`}
          >
            ⇊
          </button>
          <button
            onClick={() => v(onToggleDrag)}
            disabled={!streaming}
            className={`${btnBase} ${
              dragMode
                ? isDragging
                  ? "bg-red-500 text-white animate-pulse"
                  : "bg-green-500 text-white"
                : btnNormal
            }`}
          >
            ✋
          </button>
        </div>

        <div className="grid grid-cols-6 gap-1">
          <button
            onClick={() => v(onTabKey, streaming)}
            disabled={!streaming}
            className={`${btnBase} ${btnNormal}`}
          >
            TAB
          </button>
          <button
            onClick={() => v(onArrowKey, "left", streaming)}
            disabled={!streaming}
            className={`${btnBase} ${btnNormal}`}
          >
            ←
          </button>
          <button
            onClick={() => v(onArrowKey, "right", streaming)}
            disabled={!streaming}
            className={`${btnBase} ${btnNormal}`}
          >
            →
          </button>
          <button
            onMouseDown={(e) => { e.preventDefault(); v(onScrollRight, streaming); }}
            onMouseUp={onStopScrolling}
            onMouseLeave={onStopScrolling}
            onTouchStart={(e) => { e.preventDefault(); v(onScrollRight, streaming); }}
            onTouchEnd={onStopScrolling}
            disabled={!streaming}
            className={`${btnBase} ${btnNormal} select-none`}
          >
            ⇇
          </button>
          <button
            onMouseDown={(e) => { e.preventDefault(); v(onScrollLeft, streaming); }}
            onMouseUp={onStopScrolling}
            onMouseLeave={onStopScrolling}
            onTouchStart={(e) => { e.preventDefault(); v(onScrollLeft, streaming); }}
            onTouchEnd={onStopScrolling}
            disabled={!streaming}
            className={`${btnBase} ${btnNormal} select-none`}
          >
            ⇉
          </button>
          <button
            onClick={() => v(onBackspace, streaming)}
            disabled={!streaming}
            className={`${btnBase} ${btnNormal}`}
          >
            ⌫
          </button>
        </div>
      </div>

      {/* Modifier Keys */}
      <div className="border-t border-dark-400 pt-2 mb-3">
        <div className="grid grid-cols-5 gap-1">
          {["ctrl", "cmd", "alt", "shift"].map((key) => (
            <button
              key={key}
              onClick={() => v(onToggleModifier, key)}
              disabled={!streaming}
              className={`${btnBase} ${
                modifierKeys[key]
                  ? "bg-brand-500 text-white shadow-lg shadow-brand-500/20"
                  : btnNormal
              }`}
            >
              {key === "cmd" ? "Cmd" : key.charAt(0).toUpperCase() + key.slice(1)}
            </button>
          ))}
          <button
            onClick={(e) => v(onEnterKey, e, streaming)}
            disabled={!streaming}
            className={`${btnBase} bg-green-600 hover:bg-green-700 text-white`}
          >
            Enter
          </button>
        </div>
      </div>

      {/* Text Input */}
      <div className="border-t border-dark-400 pt-3">
        <div className="flex gap-2">
          <input
            ref={textInputRef}
            type="text"
            value={textInputValue}
            onChange={(e) => onTextInputChange(e.target.value)}
            onKeyDown={onTextInputKeyDown}
            onFocus={onTextInputFocus}
            placeholder={
              Object.values(modifierKeys).some(Boolean)
                ? `${Object.keys(modifierKeys).filter(k => modifierKeys[k]).join("+")} + key...`
                : "Type text to send..."
            }
            className="flex-1 px-3 py-2 bg-dark-600 border border-dark-400 rounded-brand text-white placeholder-dark-100 focus:outline-none focus:ring-1 focus:ring-brand-500 text-base transition-all duration-200"
            disabled={!streaming}
          />
          <Button
            variant="primary"
            size="sm"
            onClick={() => v(onSendText, streaming)}
            disabled={!streaming || !textInputValue.trim()}
          >
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}
