"use client";

import Button from "@/shared/components/ui/Button";
import Input from "@/shared/components/ui/Input";
import { ChevronLeft, RefreshCw } from "@/shared/components/ui/Icon";

// Remote Desktop Controls component
export default function RemoteControls({
  streaming,
  connected,
  canvasZoom,
  selectionMode,
  dragMode,
  isDragging,
  modifierKeys,
  textInputValue,
  textInputRef,
  keyboardVisible,
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
  
  return (
    <div 
      className="p-3 bg-dark-600 border-t border-dark-400"
    >
      {/* Main Controls */}
      <div className="flex flex-row items-center justify-center mb-3">
        <div className="flex-1 grid grid-cols-4 gap-2">
          {/* Back - Return to terminal */}
          <button
            onClick={onClose}
            className={`${btnBase} bg-red-600 hover:bg-red-700 text-white flex items-center justify-center gap-1`}
            title="Back to Terminal"
          >
            <ChevronLeft size={16} />
          </button>

          {/* Zoom */}
          <button
            onClick={onResetZoom}
            disabled={!streaming}
            className={`${btnBase} bg-dark-500 hover:bg-dark-400 text-dark-50 border border-dark-400 hover:border-brand-500`}
          >
            {Math.round(canvasZoom * 100)}%
          </button>

          {/* Refresh */}
          <button
            onClick={onRefresh}
            disabled={!streaming}
            className={`${btnBase} bg-brand-500 hover:bg-brand-600 text-white shadow-lg shadow-brand-500/20 flex items-center justify-center`}
          >
            <RefreshCw size={14} />
          </button>

          {/* Selection */}
          <button
            onClick={onToggleSelection}
            disabled={!streaming}
            className={`${btnBase} ${selectionMode ? "bg-brand-500 text-white shadow-lg shadow-brand-500/20" : "bg-dark-500 hover:bg-dark-400 text-white border border-dark-400 hover:border-brand-500"}`}
          >
            □
          </button>
        </div>
      </div>

      {/* Navigation Controls */}
      <div className="space-y-2 mb-3">
        <div className="grid grid-cols-6 gap-1">
          <button
            onClick={() => onEscKey(streaming)}
            disabled={!streaming}
            className={`${btnBase} bg-dark-500 hover:bg-dark-400 text-white border border-dark-400 hover:border-brand-500`}
          >
            ESC
          </button>
          <button
            onClick={() => onArrowKey("up", streaming)}
            disabled={!streaming}
            className={`${btnBase} bg-dark-500 hover:bg-dark-400 text-white border border-dark-400 hover:border-brand-500`}
          >
            ↑
          </button>
          <button
            onClick={() => onArrowKey("down", streaming)}
            disabled={!streaming}
            className={`${btnBase} bg-dark-500 hover:bg-dark-400 text-white border border-dark-400 hover:border-brand-500`}
          >
            ↓
          </button>
          <button
            onMouseDown={(e) => { e.preventDefault(); onScrollUp(streaming); }}
            onMouseUp={onStopScrolling}
            onMouseLeave={onStopScrolling}
            onTouchStart={(e) => { e.preventDefault(); onScrollUp(streaming); }}
            onTouchEnd={onStopScrolling}
            disabled={!streaming}
            className={`${btnBase} bg-dark-500 hover:bg-dark-400 text-white border border-dark-400 hover:border-brand-500 select-none`}
          >
            ⇈
          </button>
          <button
            onMouseDown={(e) => { e.preventDefault(); onScrollDown(streaming); }}
            onMouseUp={onStopScrolling}
            onMouseLeave={onStopScrolling}
            onTouchStart={(e) => { e.preventDefault(); onScrollDown(streaming); }}
            onTouchEnd={onStopScrolling}
            disabled={!streaming}
            className={`${btnBase} bg-dark-500 hover:bg-dark-400 text-white border border-dark-400 hover:border-brand-500 select-none`}
          >
            ⇊
          </button>
          <button
            onClick={onToggleDrag}
            disabled={!streaming}
            className={`${btnBase} ${
              dragMode
                ? isDragging
                  ? "bg-red-500 text-white animate-pulse"
                  : "bg-green-500 text-white"
                : "bg-dark-500 hover:bg-dark-400 text-white border border-dark-400 hover:border-brand-500"
            }`}
          >
            ✋
          </button>
        </div>

        <div className="grid grid-cols-6 gap-1">
          <button
            onClick={() => onTabKey(streaming)}
            disabled={!streaming}
            className={`${btnBase} bg-dark-500 hover:bg-dark-400 text-white border border-dark-400 hover:border-brand-500`}
          >
            TAB
          </button>
          <button
            onClick={() => onArrowKey("left", streaming)}
            disabled={!streaming}
            className={`${btnBase} bg-dark-500 hover:bg-dark-400 text-white border border-dark-400 hover:border-brand-500`}
          >
            ←
          </button>
          <button
            onClick={() => onArrowKey("right", streaming)}
            disabled={!streaming}
            className={`${btnBase} bg-dark-500 hover:bg-dark-400 text-white border border-dark-400 hover:border-brand-500`}
          >
            →
          </button>
          <button
            onMouseDown={(e) => { e.preventDefault(); onScrollRight(streaming); }}
            onMouseUp={onStopScrolling}
            onMouseLeave={onStopScrolling}
            onTouchStart={(e) => { e.preventDefault(); onScrollRight(streaming); }}
            onTouchEnd={onStopScrolling}
            disabled={!streaming}
            className={`${btnBase} bg-dark-500 hover:bg-dark-400 text-white border border-dark-400 hover:border-brand-500 select-none`}
          >
            ⇇
          </button>
          <button
            onMouseDown={(e) => { e.preventDefault(); onScrollLeft(streaming); }}
            onMouseUp={onStopScrolling}
            onMouseLeave={onStopScrolling}
            onTouchStart={(e) => { e.preventDefault(); onScrollLeft(streaming); }}
            onTouchEnd={onStopScrolling}
            disabled={!streaming}
            className={`${btnBase} bg-dark-500 hover:bg-dark-400 text-white border border-dark-400 hover:border-brand-500 select-none`}
          >
            ⇉
          </button>
          <button
            onClick={() => onBackspace(streaming)}
            disabled={!streaming}
            className={`${btnBase} bg-red-600 hover:bg-red-700 text-white`}
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
              onClick={() => onToggleModifier(key)}
              disabled={!streaming}
              className={`${btnBase} ${
                modifierKeys[key]
                  ? "bg-brand-500 text-white shadow-lg shadow-brand-500/20"
                  : "bg-dark-500 hover:bg-dark-400 text-white border border-dark-400 hover:border-brand-500"
              }`}
            >
              {key === "cmd" ? "Cmd" : key.charAt(0).toUpperCase() + key.slice(1)}
            </button>
          ))}
          <button
            onClick={(e) => onEnterKey(e, streaming)}
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
            className="flex-1 px-3 py-2 bg-dark-600 border border-dark-400 rounded-brand text-white placeholder-dark-100 focus:outline-none focus:ring-2 focus:ring-brand-500 text-base transition-all duration-200"
            disabled={!streaming}
          />
          <Button
            variant="primary"
            size="sm"
            onClick={() => onSendText(streaming)}
            disabled={!streaming || !textInputValue.trim()}
          >
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}
