"use client";

import Button from "@/shared/components/ui/Button";
import Input from "@/shared/components/ui/Input";

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
  const btnBase = "px-2 py-1.5 rounded text-xs font-semibold transition-all duration-200 shadow-sm disabled:opacity-50 disabled:cursor-not-allowed";
  
  return (
    <div 
      className="p-3 bg-slate-800 border-t border-slate-700"
    >
      {/* Main Controls */}
      <div className="flex flex-row items-center justify-center mb-3">
        <div className="flex-1 grid grid-cols-5 gap-2">
          {/* Start/Stop */}
          <div className="col-span-1">
            {!streaming ? (
              <Button
                variant="success"
                size="sm"
                onClick={onStartStreaming}
                disabled={!connected}
                className="w-full"
              >
                Start
              </Button>
            ) : (
              <Button
                variant="danger"
                size="sm"
                onClick={onStopStreaming}
                className="w-full"
              >
                Stop
              </Button>
            )}
          </div>

          {/* Zoom */}
          <button
            onClick={onResetZoom}
            disabled={!streaming}
            className={`${btnBase} bg-slate-700 hover:bg-slate-600 text-slate-300`}
          >
            {Math.round(canvasZoom * 100)}%
          </button>

          {/* Refresh */}
          <button
            onClick={onRefresh}
            disabled={!streaming}
            className={`${btnBase} bg-violet-600 hover:bg-violet-700 text-white`}
          >
            ↻
          </button>

          {/* Selection */}
          <button
            onClick={onToggleSelection}
            disabled={!streaming}
            className={`${btnBase} ${selectionMode ? "bg-amber-500 text-black" : "bg-cyan-600 hover:bg-cyan-700 text-white"}`}
          >
            □
          </button>

          {/* Exit - Close remote and return to terminal */}
          <button
            onClick={onClose}
            className="p-2 bg-red-600 hover:bg-red-700 text-white rounded transition"
            title="Close"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Navigation Controls */}
      <div className="space-y-2 mb-3">
        <div className="grid grid-cols-6 gap-1">
          <button
            onClick={() => onEscKey(streaming)}
            disabled={!streaming}
            className={`${btnBase} bg-purple-600 hover:bg-purple-700 text-white`}
          >
            ESC
          </button>
          <button
            onClick={() => onArrowKey("up", streaming)}
            disabled={!streaming}
            className={`${btnBase} bg-indigo-600 hover:bg-indigo-700 text-white`}
          >
            ↑
          </button>
          <button
            onClick={() => onArrowKey("down", streaming)}
            disabled={!streaming}
            className={`${btnBase} bg-indigo-600 hover:bg-indigo-700 text-white`}
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
            className={`${btnBase} bg-purple-600 hover:bg-purple-700 text-white select-none`}
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
            className={`${btnBase} bg-purple-600 hover:bg-purple-700 text-white select-none`}
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
                : "bg-slate-600 hover:bg-slate-500 text-white"
            }`}
          >
            ✋
          </button>
        </div>

        <div className="grid grid-cols-6 gap-1">
          <button
            onClick={() => onTabKey(streaming)}
            disabled={!streaming}
            className={`${btnBase} bg-purple-600 hover:bg-purple-700 text-white`}
          >
            TAB
          </button>
          <button
            onClick={() => onArrowKey("left", streaming)}
            disabled={!streaming}
            className={`${btnBase} bg-indigo-600 hover:bg-indigo-700 text-white`}
          >
            ←
          </button>
          <button
            onClick={() => onArrowKey("right", streaming)}
            disabled={!streaming}
            className={`${btnBase} bg-indigo-600 hover:bg-indigo-700 text-white`}
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
            className={`${btnBase} bg-purple-600 hover:bg-purple-700 text-white select-none`}
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
            className={`${btnBase} bg-purple-600 hover:bg-purple-700 text-white select-none`}
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
      <div className="border-t border-slate-600 pt-2 mb-3">
        <div className="grid grid-cols-5 gap-1">
          {["ctrl", "cmd", "alt", "shift"].map((key) => (
            <button
              key={key}
              onClick={() => onToggleModifier(key)}
              disabled={!streaming}
              className={`${btnBase} ${
                modifierKeys[key]
                  ? "bg-orange-500 text-white"
                  : "bg-slate-600 hover:bg-slate-500 text-white"
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
      <div className="border-t border-slate-600 pt-3">
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
            className="flex-1 px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 text-base"
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
