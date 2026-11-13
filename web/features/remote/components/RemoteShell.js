"use client";

import { useState } from "react";
import RemoteCanvas from "@/features/remote/components/RemoteCanvas";
import RemoteControls from "@/features/remote/components/RemoteControls";
import RemoteSidebar from "@/features/remote/components/RemoteSidebar";
import RemoteHelpModal from "@/features/remote/components/RemoteHelpModal";
import ClipboardModal from "@/features/remote/components/ClipboardModal";

// The remote-screen chrome shared by Remote Desktop and the browser pane:
// landscape sidebar · canvas stage · key/text controls · help + clipboard modals.
// `bottomLayout` (browser pane): no sidebar, controls always below the canvas.
// `surface` is useRemoteSurface's return; `canvasProps` carries view-specific canvas
// state (lock screen, monitors, cursor shape...); `children` render over the canvas.
export default function RemoteShell({
  surface: s, connected = true, clipboard, hasFrame = true, canvasProps, controlsProps,
  Controls = RemoteControls, bottomLayout = false, canvasStyle = null,
  onBack, onRefresh, onClose, onDesktopSwitch, onToggleDebug, debugOn, placeholder, children
}) {
  const [showHelp, setShowHelp] = useState(false);
  const [showClipboard, setShowClipboard] = useState(false);
  const refresh = () => s.streaming && onRefresh?.();

  return (
    <div
      className={`bg-bg text-text flex flex-col h-full w-full ${!bottomLayout && !s.tallLandscape ? "landscape:flex-row" : ""}`}
      style={{
        ...canvasStyle,
        userSelect: "none",
        WebkitUserSelect: "none",
        WebkitTouchCallout: "none",
        WebkitTapHighlightColor: "transparent"
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="flex flex-row flex-1 min-h-0">
        {connected && !bottomLayout && (
          <RemoteSidebar
            streaming={s.streaming}
            canvasZoom={s.canvasZoom}
            pointerMode={s.pointerMode}
            handMode={s.handMode}
            keyboardOn={s.keyboardOn}
            selectionMode={s.selectionMode}
            show={s.show}
            onBack={onBack}
            onRefresh={refresh}
            onResetZoom={s.resetZoom}
            onTogglePointerMode={s.togglePointerMode}
            onToggleHandMode={s.toggleHandMode}
            onToggleKeyboard={s.toggleKeyboard}
            onShowHelp={() => setShowHelp(true)}
            onToggleSelection={s.handleToggleSelection}
          />
        )}
        {!connected ? placeholder : (
          <RemoteCanvas
            canvasRef={s.canvasRef}
            canvasContainerRef={s.canvasContainerRef}
            canvasZoom={s.canvasZoom}
            canvasPan={s.canvasPan}
            fitScale={s.fitScale}
            streaming={s.streaming}
            hasFrame={hasFrame}
            selectionRect={s.selectionRect}
            clickIndicator={s.clickIndicator}
            pointerMode={s.pointerMode}
            selectionMode={s.selectionMode}
            handMode={s.handMode}
            handHolding={s.handHolding}
            scrollLock={s.scrollLock}
            virtualCursor={s.virtualCursor}
            inputMode={s.inputMode}
            keyboardOn={s.keyboardOn}
            onPointerDown={s.interactionHandler("pointerdown")}
            onPointerMove={s.interactionHandler("pointermove")}
            onPointerUp={s.interactionHandler("pointerup")}
            onWheel={s.interactionHandler("wheel")}
            onContextMenu={s.interactionHandler("contextmenu")}
            onDoubleClick={s.interactionHandler("dblclick")}
            onTouchStart={s.interactionHandler("touch")}
            onTouchMove={s.interactionHandler("touchmove")}
            onTouchEnd={s.interactionHandler("touchend")}
            onKeyDown={s.onCanvasKeyDown}
            {...canvasProps}
          >
            {children}
          </RemoteCanvas>
        )}
      </div>

      <Controls
        streaming={s.streaming}
        canvasZoom={s.canvasZoom}
        clipboardNew={clipboard.isNew}
        clipboardText={clipboard.text}
        onOpenClipboard={() => { clipboard.setNew(false); setShowClipboard(true); }}
        onDesktopSwitch={onDesktopSwitch}
        selectionMode={s.selectionMode}
        pointerMode={s.pointerMode}
        handMode={s.handMode}
        inputMode={s.inputMode}
        onToggleHandMode={s.toggleHandMode}
        onTogglePointerMode={s.togglePointerMode}
        modifierKeys={s.modifierKeys}
        textInputValue={s.textInputValue}
        textInputRef={s.textInputRef}
        keyboardOn={s.keyboardOn}
        showTextPanel={s.showTextPanel}
        onResetZoom={s.resetZoom}
        onRefresh={refresh}
        onToggleSelection={s.handleToggleSelection}
        onToggleModifier={s.toggleModifierKey}
        onToggleKeyboard={s.toggleKeyboard}
        onToggleTextPanel={s.toggleTextPanel}
        controlsHidden={s.controlsHidden}
        onToggleControlsHidden={s.setControlsHidden}
        tallLandscape={s.tallLandscape}
        onToggleHelp={() => setShowHelp(true)}
        onEmitKey={s.emitKeyDirect}
        onTextInputChange={s.setTextInputValue}
        onTextInputFocus={s.handleTextInputFocus}
        onTextInputBlur={s.handleTextInputBlur}
        onTextInputKeyDown={(e) => s.handleModifiedTextInput(e, s.streaming, s.keyboardOn)}
        onDirectInputChange={(value) => s.handleDirectInputChange(value, s.streaming)}
        onSendText={s.sendTextInput}
        onClose={onClose}
        onToggleDebug={onToggleDebug}
        debugOn={debugOn}
        {...controlsProps}
      />

      {showHelp && (
        <RemoteHelpModal
          inputMode={s.inputMode}
          pointerMode={s.pointerMode}
          onClose={() => {
            setShowHelp(false);
            if (s.keyboardOn) s.textInputRef.current?.focus();
          }}
        />
      )}

      {showClipboard && (
        <ClipboardModal text={clipboard.text} onClose={() => setShowClipboard(false)} />
      )}
    </div>
  );
}
