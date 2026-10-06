"use client";

// Remote browser pane — the host's real Chrome seen over a CDP screencast
// (orca remote-pane pattern). Frames are ack-gated on the host, so this side
// only acks what it has painted; input rides the same stream session.
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Globe, Keyboard, Loader2, Plus, RotateCw, X } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { vibrate } from "@/shared/utils/vibration";
import { useBrowserStore, cleanTabTitle } from "@/shared/stores/browserStore";
import { useBrowserUseInvoke } from "@/shared/components/ui/BrowserUseSettings";
import { viewportPoint } from "@/features/browser/lib/pointerMap";

const SPECIAL_KEYS = {
  Enter: "enter", Tab: "tab", Escape: "escape", Backspace: "backspace", Delete: "delete",
  ArrowUp: "arrowup", ArrowDown: "arrowdown", ArrowLeft: "arrowleft", ArrowRight: "arrowright",
  Home: "home", End: "end", PageUp: "pageup", PageDown: "pagedown"
};

export default function BrowserPane({ busRef, connected = false, onBack }) {
  const { t } = useI18n();
  const invoke = useBrowserUseInvoke(busRef);
  const tabs = useBrowserStore((s) => s.tabs);
  const activeTargetId = useBrowserStore((s) => s.activeTargetId);
  const setActive = useBrowserStore((s) => s.setActive);

  const [frame, setFrame] = useState(null);
  const [address, setAddress] = useState("");
  const [textOpen, setTextOpen] = useState(false);
  const [textDraft, setTextDraft] = useState("");
  const [restartTick, setRestartTick] = useState(0);
  const stageRef = useRef(null);
  const frameRef = useRef(null);
  const addressRef = useRef(null);
  const wheelRef = useRef(null);
  const dragRef = useRef(null);
  const moveTimerRef = useRef(null);

  const activeTab = tabs.find((tb) => tb.id === activeTargetId) || tabs.find((tb) => tb.active) || tabs[0] || null;
  const watchedId = activeTab?.id || null;

  // The address bar follows the watched tab; typing is user state that a tab
  // switch resets (render-time adjust, not an effect).
  const [prevWatched, setPrevWatched] = useState(null);
  if (prevWatched !== watchedId) {
    setPrevWatched(watchedId);
    setAddress(activeTab?.url && !/^about:blank$/.test(activeTab.url) ? activeTab.url : "");
  }

  // Stream lifecycle: one subscription for the watched tab; switch/unmount stops.
  useEffect(() => {
    const bus = busRef?.current;
    if (!connected || !bus?.emit || !watchedId) return;
    let stopped = false;
    const rect = stageRef.current?.getBoundingClientRect();
    bus.emit("browserUse:stream.start", {
      targetId: watchedId,
      width: Math.round(rect?.width || 720),
      height: Math.round(rect?.height || 1280)
    });
    const onFrame = (f) => {
      if (stopped || f?.targetId !== watchedId || !f.image) return;
      const next = { src: `data:image/jpeg;base64,${f.image}`, meta: f.meta };
      frameRef.current = next;
      setFrame(next);
      bus.emit("browserUse:stream.ack", { targetId: f.targetId, seq: f.seq });
    };
    bus.on?.("browserUse:frame", onFrame);
    return () => {
      stopped = true;
      bus.off?.("browserUse:frame", onFrame);
      bus.emit("browserUse:stream.stop", { targetId: watchedId });
    };
  }, [busRef, connected, watchedId, restartTick]);

  const sendInput = useCallback((events) => {
    if (!watchedId || !events.length) return;
    busRef?.current?.emit?.("browserUse:input", { targetId: watchedId, events });
  }, [busRef, watchedId]);

  const point = useCallback((e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return viewportPoint(e.nativeEvent.offsetX, e.nativeEvent.offsetY, rect, frameRef.current?.meta);
  }, []);

  const onPointerDown = (e) => {
    if (!frameRef.current || e.button > 2) return;
    vibrate();
    dragRef.current = { sx: e.clientX, sy: e.clientY, moved: false };
    const p = point(e);
    sendInput([{ t: "pointer", type: "press", x: p.x, y: p.y, button: e.button === 2 ? "right" : "left" }]);
  };

  const onPointerMove = (e) => {
    if (!dragRef.current || !frameRef.current) return;
    const d = dragRef.current;
    if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 8) d.moved = true;
    if (!d.moved) return;
    // Coalesce moves to one in-flight event per frame window.
    if (moveTimerRef.current) return;
    const ev = e;
    moveTimerRef.current = setTimeout(() => {
      moveTimerRef.current = null;
      const p = point(ev);
      sendInput([{ t: "pointer", type: "move", x: p.x, y: p.y }]);
    }, 40);
  };

  const onPointerUp = (e) => {
    if (!dragRef.current || !frameRef.current) return;
    dragRef.current = null;
    const p = point(e);
    sendInput([{ t: "pointer", type: "release", x: p.x, y: p.y, button: e.button === 2 ? "right" : "left" }]);
  };

  // Wheel: non-passive listener so the page cannot scroll the app underneath.
  useEffect(() => {
    const el = stageRef.current;
    if (!el || !watchedId) return;
    const onWheel = (e) => {
      if (!frameRef.current) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const p = viewportPoint(e.clientX - rect.left, e.clientY - rect.top, rect, frameRef.current?.meta);
      const acc = wheelRef.current || (wheelRef.current = { x: p.x, y: p.y, deltaX: 0, deltaY: 0 });
      acc.x = p.x; acc.y = p.y;
      acc.deltaX += e.deltaX;
      acc.deltaY += e.deltaY;
      if (acc.timer) return;
      acc.timer = setTimeout(() => {
        acc.timer = null;
        sendInput([{ t: "wheel", x: acc.x, y: acc.y, deltaX: acc.deltaX, deltaY: acc.deltaY }]);
        acc.deltaX = 0; acc.deltaY = 0;
      }, 50);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [watchedId, sendInput]);

  const onKeyDown = (e) => {
    if (!frameRef.current || e.ctrlKey || e.metaKey || e.altKey) return;
    const special = SPECIAL_KEYS[e.key];
    if (special) {
      e.preventDefault();
      sendInput([{ t: "key", key: special }]);
    } else if (e.key.length === 1) {
      e.preventDefault();
      sendInput([{ t: "text", text: e.key }]);
    }
  };

  const sendText = () => {
    if (!textDraft) return;
    sendInput([{ t: "text", text: textDraft }]);
    setTextDraft("");
  };

  const navigate = () => {
    const url = address.trim();
    if (!url) return;
    vibrate();
    invoke("go", { url });
  };

  const focusTab = (id) => {
    vibrate();
    setActive(id);
    invoke("go", { tab: id });
  };

  const closeTab = (e, id) => {
    e.stopPropagation();
    vibrate();
    invoke("tabclose", { tab: id });
  };

  const copyUrl = async () => {
    if (activeTab?.url) await navigator.clipboard?.writeText?.(activeTab.url).catch(() => {});
  };

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-surface text-text transition-all duration-300 ease-out animate-in slide-in-from-bottom">
      {/* Host tab strip */}
      <div className="h-11 flex items-center gap-1 px-2 border-b border-border-subtle shrink-0 overflow-x-auto modal-scrollable">
        <button
          onClick={() => { vibrate(); onBack?.(); }}
          className="p-2 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-colors shrink-0"
          title={t("common.close")}
        >
          <ChevronLeft size={18} />
        </button>
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`group flex items-center gap-1.5 pl-3 pr-1.5 h-8 rounded-brand text-xs cursor-pointer max-w-[160px] shrink-0 transition-colors ${
              tab.id === watchedId ? "bg-surface-3 text-text" : "bg-surface-2 text-text-muted hover:bg-surface-3"
            }`}
            onClick={() => focusTab(tab.id)}
          >
            <Globe size={13} className="shrink-0" />
            <span className="truncate">{cleanTabTitle(tab.title) || tab.url}</span>
            <button
              onClick={(e) => closeTab(e, tab.id)}
              className="p-0.5 rounded opacity-60 hover:opacity-100 hover:bg-surface shrink-0"
              title={t("common.close")}
            >
              <X size={12} />
            </button>
          </div>
        ))}
        <button
          onClick={() => { vibrate(); addressRef.current?.focus(); }}
          className="p-2 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-colors shrink-0"
          title={t("sites.browserNewTab")}
        >
          <Plus size={16} />
        </button>
      </div>

      {/* Toolbar */}
      <div className="h-11 flex items-center gap-1 px-2 border-b border-border-subtle shrink-0">
        <button onClick={() => invoke("back", {})} className="p-2 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-colors shrink-0" title={t("sites.goBack")}>
          <ChevronLeft size={16} />
        </button>
        <button onClick={() => invoke("forward", {})} className="p-2 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-colors shrink-0" title={t("sites.goForward")}>
          <ChevronRight size={16} />
        </button>
        <button onClick={() => invoke("reload", {})} className="p-2 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-colors shrink-0" title={t("editor.reload")}>
          <RotateCw size={15} />
        </button>
        <input
          ref={addressRef}
          type="text" value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && navigate()}
          placeholder={t("sites.browserPaneNewTabHint")}
          spellCheck={false} autoCapitalize="off" autoCorrect="off"
          className="flex-1 min-w-0 px-3 py-1.5 bg-surface-2 rounded-brand text-sm text-text placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-brand-500/40"
        />
        <button
          onClick={() => setTextOpen((v) => !v)}
          className={`p-2 rounded-brand transition-colors shrink-0 ${textOpen ? "text-brand-500 bg-surface-2" : "text-text-muted hover:text-text hover:bg-surface-2"}`}
          title={t("sites.browserPaneSendText")}
        >
          <Keyboard size={15} />
        </button>
        <button onClick={copyUrl} className="p-2 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-colors shrink-0" title={t("sites.browserPaneCopyUrl")}>
          <Globe size={15} />
        </button>
      </div>

      {/* Stream stage */}
      <div
        ref={stageRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
        className="flex-1 min-h-0 bg-black relative overflow-hidden outline-none touch-none select-none"
      >
        {frame && <img src={frame.src} alt="browser" className="w-full h-full object-contain pointer-events-none" draggable={false} />}
        {!connected && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-text-muted bg-surface">
            {t("sites.browserPaneNotConnected")}
          </div>
        )}
        {connected && !watchedId && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center bg-surface">
            <Globe size={28} className="text-text-muted" />
            <p className="text-text text-sm font-medium">{t("sites.browserPaneNoTabs")}</p>
            <p className="text-text-muted text-xs">{t("sites.browserPaneNewTabHint")}</p>
          </div>
        )}
        {connected && watchedId && !frame && (
          <button
            onClick={() => setRestartTick((n) => n + 1)}
            className="absolute inset-0 flex items-center justify-center bg-surface text-text-muted text-sm gap-2"
          >
            <Loader2 size={14} className="animate-spin" /> {t("sites.browserPaneLoading")}
          </button>
        )}
      </div>

      {/* Mobile text input — the phone keyboard cannot reach the streamed page */}
      {textOpen && (
        <div className="flex items-center gap-2 p-2 border-t border-border-subtle shrink-0">
          <input
            type="text" value={textDraft}
            onChange={(e) => setTextDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && sendText()}
            placeholder={t("sites.browserPaneSendText")}
            autoCapitalize="off" autoCorrect="off" spellCheck={false}
            className="flex-1 px-3 py-1.5 bg-surface-2 rounded-brand text-sm text-text placeholder-text-muted focus:outline-none"
          />
          <button onClick={sendText} className="px-3 py-1.5 bg-brand-500 text-white rounded-brand text-sm">{t("sites.open")}</button>
        </div>
      )}
    </div>
  );
}
