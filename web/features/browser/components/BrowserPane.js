"use client";

// Remote browser pane — host Chrome seen over a CDP screencast with full Orca-like
// features: Grab & Inspect, Annotate to AI, Markup drawing, Console REPL, Profiles & Cookies.
// Coordinates are pixel-perfect: the <img> shrink-fits the stage, so its own
// bounding box IS the drawn frame — map clientXY through its ratio, no letterbox math.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bot,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Globe,
  Link2,
  Loader2,
  MoreHorizontal,
  RotateCw,
  SquarePen,
  Target,
  Terminal,
  X
} from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { vibrate } from "@/shared/utils/vibration";
import { useBrowserStore } from "@/shared/stores/browserStore";
import { useBrowserInvoke } from "@/features/browser/hooks/useBrowserInvoke";
import { pinchDistance } from "@/features/browser/lib/pointerMap";
import BrowserInspectSheet from "./BrowserInspectSheet";
import BrowserAnnotationsDrawer from "./BrowserAnnotationsDrawer";
import BrowserMarkupOverlay from "./BrowserMarkupOverlay";
import BrowserConsoleDrawer from "./BrowserConsoleDrawer";
import BrowserMenuModal from "./BrowserMenuModal";
import BrowserContextMenu from "./BrowserContextMenu";
import BrowserAddressSuggestions from "./BrowserAddressSuggestions";
import BrowserPopupWindow from "./BrowserPopupWindow";

const SPECIAL_KEYS = {
  Enter: "enter", Tab: "tab", Escape: "escape", Backspace: "backspace", Delete: "delete",
  ArrowUp: "arrowup", ArrowDown: "arrowdown", ArrowLeft: "arrowleft", ArrowRight: "arrowright",
  Home: "home", End: "end", PageUp: "pageup", PageDown: "pagedown"
};
const DIAG = process.env.NODE_ENV !== "production";

export default function BrowserPane({ busRef, connected = false, onBack }) {
  const { t } = useI18n();
  const invoke = useBrowserInvoke(busRef);
  const tabs = useBrowserStore((s) => s.tabs);
  const activeTargetId = useBrowserStore((s) => s.activeTargetId);
  const setActive = useBrowserStore((s) => s.setActive);

  const [frame, setFrame] = useState(null);
  const [address, setAddress] = useState("");
  const [textOpen, setTextOpen] = useState(false);
  const [textDraft, setTextDraft] = useState("");
  const [restartTick, setRestartTick] = useState(0);
  // Viewport preset override — null = follow the stage's own size.
  const [viewportPreset, setViewportPreset] = useState(null);

  // Feature modes & panels. grabIntent mirrors orca: "copy" (grab) vs "annotate".
  const [grabIntent, setGrabIntent] = useState(null);
  const [inspectedElement, setInspectedElement] = useState(null);
  const [annotations, setAnnotations] = useState([]);
  const [showAnnotations, setShowAnnotations] = useState(false);
  const [markupOpen, setMarkupOpen] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuSection, setMenuSection] = useState(null); // "cookies" via the toolbar Import shortcut
  const [navFlags, setNavFlags] = useState({ back: false, forward: false });
  const [cursor, setCursor] = useState("default");

  // Context menu (right-click / long-press), load failure, address suggestions
  const [ctxMenu, setCtxMenu] = useState(null);
  const [reloadMenu, setReloadMenu] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [suggest, setSuggest] = useState({ open: false, items: [], idx: -1 });
  const [inspectNoteFocus, setInspectNoteFocus] = useState(false);
  const [inspectAt, setInspectAt] = useState(null); // stage-relative anchor for annotate

  const stageRef = useRef(null);
  const imgRef = useRef(null);
  const frameRef = useRef(null);
  const addressRef = useRef(null);
  const wheelRef = useRef(null);
  const dragRef = useRef(null);
  const moveTimerRef = useRef(null);
  const longPressTimer = useRef(null);
  const longPressFired = useRef(false);
  const hoverTimerRef = useRef(null);
  const lastUpRef = useRef(null);
  const touchStartRef = useRef(null);
  const touchPoints = useRef(new Map());
  const pinchRef = useRef(null);
  const suggestTimer = useRef(null);
  // TEMP DIAGNOSTIC pane: frame throughput + input send rate (1 line/s in devtools)
  const diagRef = useRef({ frames: 0, bytes: 0, lastSeq: 0, sends: 0, mark: 0 });

  const activeTab = tabs.find((tb) => tb.id === activeTargetId) || tabs.find((tb) => tb.active) || tabs[0] || null;
  const watchedId = activeTab?.id || null;

  // Popup rendering is responsive: mobile switches the whole pane to the popup
  // tab (handled in useBrowserTabs); desktop floats it over the parent stream.
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  const popupTab = !isMobile && watchedId
    ? tabs.find((t) => t.openerId === watchedId && t.id !== watchedId) || null
    : null;

  const [prevWatched, setPrevWatched] = useState(null);
  if (prevWatched !== watchedId) {
    setPrevWatched(watchedId);
    setAddress(activeTab?.url && !/^about:blank$/.test(activeTab.url) ? activeTab.url : "");
  }

  // Screencast stream lifecycle
  useEffect(() => {
    const bus = busRef?.current;
    if (!connected || !bus?.emit || !watchedId) return;
    let stopped = false;
    const rect = stageRef.current?.getBoundingClientRect();
    bus.emit("browser:stream.start", {
      targetId: watchedId,
      width: Math.round(viewportPreset?.width || rect?.width || 720),
      height: Math.round(viewportPreset?.height || rect?.height || 1280),
      // Retina honesty: render at the viewer's physical pixel density.
      scale: Math.min(2, window.devicePixelRatio || 1)
    });
    const onFrame = (f) => {
      if (stopped || f?.targetId !== watchedId || !f.image) return;
      const next = { src: `data:image/jpeg;base64,${f.image}`, meta: f.meta };
      frameRef.current = next;
      setFrame(next);
      setLoading(false); // any frame after a navigate = the page painted
      if (DIAG) {
        diagRef.current.frames += 1;
        diagRef.current.bytes += f.image.length;
        diagRef.current.lastSeq = f.seq;
      }
      bus.emit("browser:stream.ack", { targetId: f.targetId, seq: f.seq });
    };
    bus.on?.("browser:frame", onFrame);
    return () => {
      stopped = true;
      bus.off?.("browser:frame", onFrame);
      bus.emit("browser:stream.stop", { targetId: watchedId });
    };
  }, [busRef, connected, watchedId, restartTick, viewportPreset]);

  // Stream only while this tab is actually watched: hidden (switched tab /
  // minimized) → stop the screencast; back → restart with the cached frame.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) {
        busRef?.current?.emit?.("browser:stream.stop", { targetId: watchedId });
      } else {
        setRestartTick((n) => n + 1);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [busRef, watchedId]);

  // Timers own input timing — never let one fire into an unmounted pane.
  useEffect(() => () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    if (suggestTimer.current) clearTimeout(suggestTimer.current);
    if (moveTimerRef.current) clearTimeout(moveTimerRef.current);
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    if (wheelRef.current?.timer) clearTimeout(wheelRef.current.timer);
  }, []);

  // Host cursor probe → real pointer/text cursor over the streamed page.
  useEffect(() => {
    const bus = busRef?.current;
    if (!bus?.on || !watchedId) return;
    const onCursor = (c) => {
      if (c?.targetId === watchedId) setCursor(c.cursor || "default");
    };
    bus.on?.("browser:cursor", onCursor);
    return () => {
      bus.off?.("browser:cursor", onCursor);
      setCursor("default");
    };
  }, [busRef, watchedId]);

  const sendInput = useCallback((events) => {
    if (!watchedId || !events.length) return;
    if (DIAG) diagRef.current.sends += 1;
    busRef?.current?.emit?.("browser:input", { targetId: watchedId, events });
  }, [busRef, watchedId]);

  // TEMP DIAGNOSTIC pane: report once per second while the pane is open
  useEffect(() => {
    if (!DIAG) return;
    diagRef.current.mark = Date.now();
    const timer = setInterval(() => {
      const d = diagRef.current;
      const dt = Date.now() - d.mark;
      if (d.frames || d.sends) {
        console.debug(`[pane] frames/s=${(d.frames * 1000 / dt).toFixed(1)} lastSeq=${d.lastSeq} kb/s=${(d.bytes / dt).toFixed(0)} inputs/s=${(d.sends * 1000 / dt).toFixed(1)}`);
      }
      d.frames = 0; d.bytes = 0; d.sends = 0; d.mark = Date.now();
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Pixel-perfect mapping: the img shrink-fits the stage, so its rect is the
  // drawn frame; scale through the ratio into the page's own device pixels.
  const pagePoint = useCallback((clientX, clientY) => {
    const el = imgRef.current;
    const meta = frameRef.current?.meta;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return { x: 0, y: 0 };
    const vW = meta?.deviceWidth || rect.width;
    const vH = meta?.deviceHeight || rect.height;
    const x = Math.round(((clientX - rect.left) / rect.width) * vW);
    const y = Math.round(((clientY - rect.top) / rect.height) * vH);
    return { x: Math.max(0, Math.min(vW, x)), y: Math.max(0, Math.min(vH, y)) };
  }, []);
  const point = useCallback((e) => pagePoint(e.clientX, e.clientY), [pagePoint]);

  const openContextMenu = async (clientX, clientY) => {
    const p = pagePoint(clientX, clientY);
    const res = await invoke("inspect", { targetId: watchedId, x: p.x, y: p.y });
    setCtxMenu({ x: clientX, y: clientY, element: res?.ok ? res.element : null });
  };

  const clearLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const onPointerDown = (e) => {
    if (!frameRef.current || e.button > 2) return;
    vibrate();
    // Grab & Inspect mode: the tap picks an element instead of clicking.
    if (grabIntent) {
      const gp = point(e);
      const at = { x: e.clientX, y: e.clientY };
      invoke("inspect", { targetId: watchedId, x: gp.x, y: gp.y }).then((res) => {
        if (res?.ok && res.element) {
          setInspectNoteFocus(grabIntent === "annotate");
          // Annotate anchors its card at the tapped element (orca pattern);
          // grab reads better as the full-width bottom sheet.
          setInspectAt(grabIntent === "annotate" ? at : null);
          setInspectedElement(res.element);
        }
      });
      return;
    }
    if (e.pointerType === "touch") {
      touchPoints.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      // Second finger: end the touch stream, switch to pinch-zoom mode.
      if (touchPoints.current.size === 2) {
        clearLongPress();
        longPressFired.current = true; // the pending touchend for finger 1 is skipped
        sendInput([{ t: "touch", type: "end" }]);
        pinchRef.current = { dist: pinchDistance(touchPoints.current) };
        return;
      }
      clearLongPress();
      longPressFired.current = false;
      const p = point(e);
      touchStartRef.current = { x: e.clientX, y: e.clientY };
      sendInput([{ t: "touch", type: "start", points: [p] }]);
      longPressTimer.current = setTimeout(() => {
        longPressTimer.current = null;
        longPressFired.current = true;
        sendInput([{ t: "touch", type: "end" }]);
        const hit = touchPoints.current.values().next().value;
        if (hit) openContextMenu(hit.x, hit.y);
      }, 550);
      return;
    }
    // Mouse: plain press — release on up, double-click detected there too.
    dragRef.current = { sx: e.clientX, sy: e.clientY, moved: false };
    const p = point(e);
    sendInput([{ t: "pointer", type: "press", x: p.x, y: p.y, button: e.button === 2 ? "right" : e.button === 1 ? "middle" : "left" }]);
  };

  const onPointerMove = (e) => {
    if (e.pointerType === "touch") {
      if (!touchPoints.current.has(e.pointerId)) return;
      touchPoints.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      // Pinch: two fingers → ctrl+wheel (Chrome's native page zoom), throttled.
      if (pinchRef.current && touchPoints.current.size >= 2) {
        const dist = pinchDistance(touchPoints.current);
        const delta = pinchRef.current.dist - dist;
        pinchRef.current.dist = dist;
        if (Math.abs(delta) > 1 && !pinchRef.current.timer) {
          const [a, b] = [...touchPoints.current.values()];
          const mid = pagePoint((a.x + b.x) / 2, (a.y + b.y) / 2);
          pinchRef.current.timer = setTimeout(() => {
            if (pinchRef.current) pinchRef.current.timer = null;
          }, 40);
          sendInput([{ t: "wheel", x: mid.x, y: mid.y, deltaX: 0, deltaY: Math.round(delta * 4), ctrlKey: true }]);
        }
        return;
      }
      // Single-finger drag → native touch scroll (coalesced per frame window).
      if (grabIntent) return;
      const st = touchStartRef.current;
      if (st && Math.abs(e.clientX - st.x) + Math.abs(e.clientY - st.y) > 10) clearLongPress();
      if (moveTimerRef.current) return;
      const ev = e;
      moveTimerRef.current = setTimeout(() => {
        moveTimerRef.current = null;
        const p = point(ev);
        sendInput([{ t: "touch", type: "move", points: [p] }]);
      }, 16);
      return;
    }
    // Mouse drag with button down.
    if (dragRef.current && frameRef.current) {
      const d = dragRef.current;
      if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 8) {
        d.moved = true;
        clearLongPress();
      }
      if (d.moved && !moveTimerRef.current) {
        const ev = e;
        moveTimerRef.current = setTimeout(() => {
          moveTimerRef.current = null;
          const p = point(ev);
          sendInput([{ t: "pointer", type: "move", x: p.x, y: p.y, drag: true }]);
        }, 30);
      }
      return;
    }
    // Mouse hover (no button): drives :hover states and the cursor probe.
    if (grabIntent || !frameRef.current) return;
    if (hoverTimerRef.current) return;
    const ev = e;
    hoverTimerRef.current = setTimeout(() => {
      hoverTimerRef.current = null;
      const p = point(ev);
      sendInput([{ t: "pointer", type: "move", x: p.x, y: p.y }]);
    }, 80);
  };

  const onPointerUp = (e) => {
    if (e.pointerType === "touch") {
      touchPoints.current.delete(e.pointerId);
      if (touchPoints.current.size < 2 && pinchRef.current) {
        if (pinchRef.current.timer) clearTimeout(pinchRef.current.timer);
        pinchRef.current = null;
      }
      clearLongPress();
      // The long-press timer (or pinch entry) already ended the touch stream.
      if (!longPressFired.current && !pinchRef.current) {
        sendInput([{ t: "touch", type: "end" }]);
      }
      longPressFired.current = false;
      return;
    }
    clearLongPress();
    if (grabIntent || !dragRef.current || !frameRef.current) return;
    dragRef.current = null;
    const p = point(e);
    const button = e.button === 2 ? "right" : e.button === 1 ? "middle" : "left";
    // Double-click: same spot within 350ms → clickCount 2 (text select, word select).
    const now = Date.now();
    const last = lastUpRef.current;
    lastUpRef.current = { t: now, x: e.clientX, y: e.clientY };
    const isDouble = last && now - last.t < 350 &&
      Math.abs(e.clientX - last.x) + Math.abs(e.clientY - last.y) < 20;
    if (isDouble) {
      lastUpRef.current = null;
      sendInput([
        { t: "pointer", type: "press", x: p.x, y: p.y, button, clickCount: 2 },
        { t: "pointer", type: "release", x: p.x, y: p.y, button, clickCount: 2 }
      ]);
      return;
    }
    sendInput([{ t: "pointer", type: "release", x: p.x, y: p.y, button }]);
  };

  useEffect(() => {
    const el = stageRef.current;
    if (!el || !watchedId) return;
    const onWheel = (e) => {
      if (!frameRef.current || grabIntent) return;
      e.preventDefault();
      const p = pagePoint(e.clientX, e.clientY);
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
  }, [watchedId, grabIntent, sendInput, pagePoint]);

  const onKeyDown = (e) => {
    // Orca chords: Mod+L focuses the address bar; Escape disarms grab/annotate.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "l") {
      e.preventDefault();
      addressRef.current?.focus();
      return;
    }
    if (e.key === "Escape" && grabIntent) {
      setGrabIntent(null);
      return;
    }
    if (!frameRef.current || grabIntent || e.ctrlKey || e.metaKey || e.altKey) return;
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

  const navigate = async (urlOverride) => {
    const url = String(urlOverride ?? address).trim();
    if (!url) return;
    vibrate();
    setSuggest({ open: false, items: [], idx: -1 });
    setLoadError(null);
    setLoading(true);
    // No tab yet: the typed address BOOTS the browser with a fresh tab.
    const res = watchedId
      ? await invoke("go", { targetId: watchedId, url })
      : await invoke("open", { url });
    setLoading(false);
    if (res?.ok && res.id) {
      setActive(res.id);
      // Optimistic tab entry — the host's push (2s poll) replaces it; without
      // this the stream waits a full poll cycle before starting.
      const cur = useBrowserStore.getState().tabs;
      if (!cur.some((tb) => tb.id === res.id)) {
        useBrowserStore.getState().setTabs([...cur, { id: res.id, url: res.url, title: "" }]);
      }
    }
    if (res && !res.ok) setLoadError({ url, error: res.error || "Navigation failed" });
    else if (res?.ok && res.error) setLoadError({ url, error: res.error });
    refreshNav();
  };

  // ---- address suggestions (host-scored history) ------------------------------
  const refreshSuggestions = (value) => {
    if (suggestTimer.current) clearTimeout(suggestTimer.current);
    const q = value.trim();
    if (!q) {
      setSuggest({ open: false, items: [], idx: -1 });
      return;
    }
    suggestTimer.current = setTimeout(async () => {
      const res = await invoke("history.search", { q });
      const hist = res?.ok && Array.isArray(res.items) ? res.items : [];
      // Orca shape: the search-engine fallback row always leads the list.
      const searchRow = /^https?:/i.test(q) ? [] : [{
        isSearch: true,
        url: `https://www.google.com/search?q=${encodeURIComponent(q)}`,
        title: `${t("sites.browserPaneSearchFor")} "${q}"`
      }];
      // Dedupe by url — history often already holds the search-fallback url itself.
      const seen = new Set(searchRow.map((r) => r.url));
      const histRows = [];
      for (const h of hist) {
        if (seen.has(h.url)) continue;
        seen.add(h.url);
        histRows.push({ url: h.url, title: h.title || h.url, subtitle: h.title ? h.url : null });
      }
      setSuggest({ open: true, items: [...searchRow, ...histRows], idx: 0 });
    }, 150);
  };

  const onAddressKeyDown = (e) => {
    if (suggest.open && suggest.items.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const dir = e.key === "ArrowDown" ? 1 : -1;
        setSuggest((s) => ({ ...s, idx: (s.idx + dir + s.items.length) % s.items.length }));
        return;
      }
      if (e.key === "Escape") {
        setSuggest({ open: false, items: [], idx: -1 });
        return;
      }
      if (e.key === "Enter" && suggest.idx >= 0) {
        e.preventDefault();
        navigate(suggest.items[suggest.idx].url);
        return;
      }
    }
    if (e.key === "Enter") navigate();
  };

  // Navigation-history flags (orca disables back/forward off history bounds).
  const refreshNav = useCallback(async () => {
    if (!watchedId) return;
    const res = await invoke("nav", { targetId: watchedId });
    if (res?.ok) setNavFlags({ back: !!res.back, forward: !!res.forward });
  }, [invoke, watchedId]);
  useEffect(() => {
    // Deferred + cancellable: a fast tab switch must not land stale flags.
    const t = setTimeout(refreshNav, 0);
    return () => clearTimeout(t);
  }, [refreshNav]);

  const copyUrl = async () => {
    if (activeTab?.url) await navigator.clipboard?.writeText?.(activeTab.url).catch(() => {});
  };

  const handleAddAnnotation = (ann) => {
    setAnnotations((prev) => [...prev, ann]);
  };

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-surface text-text transition-all duration-300 ease-out animate-in slide-in-from-bottom">
      {/* Toolbar — orca BrowserPane layout: nav · address · tools · ⋯.
          Tabs live in the terminal header strip (orca's unified tabs). */}
      <div className="shrink-0 relative z-10 flex items-center gap-2 border-b border-border-subtle bg-surface/95 px-3 py-1.5">
        {/* Overlay exit — the phone has no other way out of the pane */}
        <button
          onClick={() => { vibrate(); onBack?.(); }}
          className="h-7 w-7 shrink-0 flex items-center justify-center rounded-[6px] text-text-muted hover:text-text hover:bg-surface-2 transition-colors"
          title={t("common.close")}
        >
          <X size={16} />
        </button>
        <button
          onClick={() => { refreshNav(); invoke("back", { targetId: watchedId }); }}
          disabled={!navFlags.back}
          className="h-7 w-7 shrink-0 flex items-center justify-center rounded-[6px] text-text-muted hover:text-text hover:bg-surface-2 disabled:opacity-40 disabled:pointer-events-none transition-colors"
          title={t("sites.goBack")}
        >
          <ChevronLeft size={16} />
        </button>
        <button
          onClick={() => { refreshNav(); invoke("forward", { targetId: watchedId }); }}
          disabled={!navFlags.forward}
          className="h-7 w-7 shrink-0 flex items-center justify-center rounded-[6px] text-text-muted hover:text-text hover:bg-surface-2 disabled:opacity-40 disabled:pointer-events-none transition-colors"
          title={t("sites.goForward")}
        >
          <ChevronRight size={16} />
        </button>
        {/* Reload: left-click reloads, right-click (or shift) = hard reload */}
        <button
          onClick={(e) => { setLoading(true); refreshNav(); invoke("reload", { targetId: watchedId, ignoreCache: e.shiftKey }); }}
          onContextMenu={(e) => { e.preventDefault(); setReloadMenu({ x: e.clientX, y: e.clientY }); }}
          disabled={!watchedId}
          className="h-7 w-7 shrink-0 flex items-center justify-center rounded-[6px] text-text-muted hover:text-text hover:bg-surface-2 disabled:opacity-40 disabled:pointer-events-none transition-colors"
          title={`${t("editor.reload")} · shift = hard`}
        >
          {loading ? <Loader2 size={16} className="animate-spin" /> : <RotateCw size={16} />}
        </button>

        <form
          className="relative flex min-w-0 flex-1 items-center"
          onSubmit={(e) => { e.preventDefault(); navigate(); }}
        >
          <div className="flex w-full items-center gap-2 rounded-xl border border-border-subtle bg-bg px-3 py-1 shadow-sm">
            <Globe size={15} className="shrink-0 text-text-muted" />
            <input
              ref={addressRef}
              type="text"
              value={address}
              onFocus={(e) => e.target.select()}
              onChange={(e) => { setAddress(e.target.value); refreshSuggestions(e.target.value); }}
              onKeyDown={onAddressKeyDown}
              onBlur={() => setTimeout(() => setSuggest((s) => ({ ...s, open: false })), 150)}
              placeholder={t("sites.browserPaneNewTabHint")}
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              className="w-full bg-transparent border-0 px-0 text-sm text-text placeholder-text-muted focus:outline-none focus:ring-0"
            />
          </div>
          <BrowserAddressSuggestions
            items={suggest.open ? suggest.items : []}
            activeIdx={suggest.idx}
            onHover={(i) => setSuggest((s) => ({ ...s, idx: i }))}
            onPick={(h) => { setAddress(h.url); navigate(h.url); }}
          />
        </form>

        {/* Import cookies (orca's address-bar Import hint pill) */}
        <button
          onClick={() => { vibrate(); setMenuSection("cookies"); setMenuOpen(true); }}
          className="h-7 px-2.5 shrink-0 rounded-full border border-border-subtle text-xs text-text-muted hover:text-text hover:border-text-muted/40 transition-colors"
        >
          Import
        </button>

        {/* Grab (copy) — orca Crosshair; inverted while armed */}
        <button
          onClick={() => { vibrate(); setGrabIntent((g) => (g === "copy" ? null : "copy")); setInspectedElement(null); }}
          disabled={!frame?.src}
          className={`h-8 w-8 shrink-0 relative flex items-center justify-center rounded-[6px] transition-colors disabled:opacity-40 disabled:pointer-events-none ${
            grabIntent === "copy" ? "bg-text/80 text-surface hover:bg-text/90" : "text-text-muted hover:text-text hover:bg-surface-2"
          }`}
          title="Grab page element"
        >
          <Target size={16} />
        </button>

        {/* Annotate — orca MessageSquarePlus; badge counts notes */}
        <button
          onClick={() => { vibrate(); setGrabIntent((g) => (g === "annotate" ? null : "annotate")); setInspectedElement(null); }}
          disabled={!frame?.src}
          className={`h-8 w-8 shrink-0 relative flex items-center justify-center rounded-[6px] transition-colors disabled:opacity-40 disabled:pointer-events-none ${
            grabIntent === "annotate" ? "bg-text/80 text-surface hover:bg-text/90" : "text-text-muted hover:text-text hover:bg-surface-2"
          }`}
          title="Annotate page element"
        >
          <Bot size={16} />
          {annotations.length > 0 && (
            <span className="absolute -top-1 -right-1 flex min-w-4 items-center justify-center rounded-full bg-brand-500 px-1 text-[10px] leading-4 text-white">
              {annotations.length}
            </span>
          )}
        </button>

        {/* Markup draw */}
        <button
          onClick={() => setMarkupOpen(true)}
          disabled={!frame?.src}
          className="h-7 w-7 shrink-0 flex items-center justify-center rounded-[6px] text-text-muted hover:text-text hover:bg-surface-2 disabled:opacity-40 disabled:pointer-events-none transition-colors"
          title="Draw markup"
        >
          <SquarePen size={16} />
        </button>

        {/* Console (our devtools stand-in) */}
        <button
          onClick={() => setConsoleOpen(true)}
          disabled={!watchedId}
          className="h-7 w-7 shrink-0 flex items-center justify-center rounded-[6px] text-text-muted hover:text-text hover:bg-surface-2 disabled:opacity-40 disabled:pointer-events-none transition-colors"
          title="Console"
        >
          <Terminal size={16} />
        </button>

        {/* Open in default browser (of the viewing device) */}
        <button
          onClick={() => activeTab?.url && window.open(activeTab.url, "_blank")}
          disabled={!activeTab?.url}
          className="h-7 w-7 shrink-0 flex items-center justify-center rounded-[6px] text-text-muted hover:text-text hover:bg-surface-2 disabled:opacity-40 disabled:pointer-events-none transition-colors"
          title="Open in default browser"
        >
          <ExternalLink size={16} />
        </button>

        {/* ⋯ menu (profiles · cookies · viewport · keyboard · notes) */}
        <button
          onClick={() => { setMenuSection(null); setMenuOpen(true); }}
          className="h-7 w-7 shrink-0 flex items-center justify-center rounded-[6px] text-text-muted hover:text-text hover:bg-surface-2 transition-colors"
          title="Browser menu"
        >
          <MoreHorizontal size={16} />
        </button>
      </div>

      {/* Grab/annotate armed banner (orca's status banner) */}
      {grabIntent && (
        <div className="shrink-0 bg-text/85 text-surface text-xs px-3 py-1 flex items-center justify-between">
          <span>
            {grabIntent === "copy"
              ? "🎯 Grab — click an element to inspect and copy"
              : "💬 Annotate — click an element to add a note"}
          </span>
          <button onClick={() => setGrabIntent(null)} className="underline text-[11px]">Done</button>
        </div>
      )}

      {/* Stream stage — the img shrink-fits, so its rect IS the frame: every
          input maps through that ratio and lands on the exact page pixel. */}
      <div
        ref={stageRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={(e) => { e.preventDefault(); openContextMenu(e.clientX, e.clientY); }}
        style={{ cursor: grabIntent ? "crosshair" : cursor }}
        className="flex-1 min-h-0 bg-black relative overflow-hidden outline-none touch-none select-none flex items-center justify-center"
      >
        {frame && (
          <img
            ref={imgRef}
            src={frame.src}
            alt="browser"
            className="max-w-full max-h-full object-contain pointer-events-none"
            draggable={false}
          />
        )}
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
        {connected && watchedId && !frame && !loadError && (
          <button
            onClick={() => setRestartTick((n) => n + 1)}
            className="absolute inset-0 flex items-center justify-center bg-surface text-text-muted text-sm gap-2"
          >
            <Loader2 size={14} className="animate-spin" /> {t("sites.browserPaneLoading")}
          </button>
        )}
        {loadError && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 p-6 text-center bg-surface">
            <Globe size={28} className="text-red-500" />
            <p className="text-text text-sm font-medium">{t("sites.browserPaneLoadError")}</p>
            <p className="text-text-muted text-xs font-mono break-all max-w-md">{loadError.url}</p>
            <p className="text-text-muted text-[11px]">{loadError.error}</p>
            <div className="flex items-center gap-2 pt-1">
              <button onClick={() => navigate(loadError.url)} className="px-3 py-1.5 bg-brand-500 hover:bg-brand-600 text-white rounded-brand text-xs font-medium">
                {t("sites.browserPaneRetry")}
              </button>
              <button onClick={() => navigator.clipboard?.writeText?.(loadError.url)} className="px-3 py-1.5 bg-surface-2 hover:bg-surface-3 text-text rounded-brand text-xs font-medium">
                {t("sites.browserPaneCopyAddress")}
              </button>
              <button onClick={() => setLoadError(null)} className="px-3 py-1.5 text-text-muted hover:text-text rounded-brand text-xs">
                {t("common.close")}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Virtual text input strip */}
      {textOpen && (
        <div className="flex items-center gap-2 p-2 border-t border-border-subtle shrink-0">
          <input
            type="text"
            value={textDraft}
            onChange={(e) => setTextDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && sendText()}
            placeholder={t("sites.browserPaneSendText")}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="flex-1 px-3 py-1.5 bg-surface-2 rounded-brand text-sm text-text placeholder-text-muted focus:outline-none"
          />
          <button onClick={sendText} className="px-3 py-1.5 bg-brand-500 text-white rounded-brand text-sm">
            {t("sites.open")}
          </button>
        </div>
      )}

      {/* Inspect Element Sheet */}
      {inspectedElement && (
        <BrowserInspectSheet
          element={inspectedElement}
          autoFocusNote={inspectNoteFocus}
          at={inspectAt}
          onAddAnnotation={handleAddAnnotation}
          onClose={() => setInspectedElement(null)}
        />
      )}

      {/* Annotations Tray */}
      {showAnnotations && (
        <BrowserAnnotationsDrawer
          annotations={annotations}
          onDelete={(id) => setAnnotations((prev) => prev.filter((a) => a.id !== id))}
          onClear={() => setAnnotations([])}
          onClose={() => setShowAnnotations(false)}
        />
      )}

      {/* Markup Drawer */}
      {markupOpen && frame?.src && (
        <BrowserMarkupOverlay
          frameImgSrc={frame.src}
          onClose={() => setMarkupOpen(false)}
        />
      )}

      {/* Console REPL */}
      {consoleOpen && (
        <BrowserConsoleDrawer
          onEval={(expr) => invoke("eval", { targetId: watchedId, expression: expr })}
          onClose={() => setConsoleOpen(false)}
        />
      )}

      {/* Menu Modal (Profiles, Cookies, Viewport) */}
      {menuOpen && (
        <BrowserMenuModal
          invoke={invoke}
          targetId={watchedId}
          url={activeTab?.url}
          initialSection={menuSection}
          keyboardOpen={textOpen}
          notesCount={annotations.length}
          onToggleKeyboard={() => setTextOpen((v) => !v)}
          onCopyUrl={copyUrl}
          onOpenNotes={() => setShowAnnotations(true)}
          onSelectViewport={async (w, h) => {
            setViewportPreset({ width: w, height: h });
            await invoke("viewport", { targetId: watchedId, width: w, height: h });
          }}
          onClose={() => setMenuOpen(false)}
        />
      )}

      {/* Page context menu (right-click / long-press) */}
      <BrowserContextMenu
        menu={ctxMenu}
        items={[
          ...(ctxMenu?.element?.href ? [
            {
              label: t("sites.browserCtxOpenNewTab"),
              icon: <ExternalLink size={13} />,
              onPick: () => invoke("open", { url: ctxMenu.element.href })
            },
            {
              label: t("sites.browserCtxCopyLink"),
              icon: <Link2 size={13} />,
              onPick: () => navigator.clipboard?.writeText?.(ctxMenu.element.href)
            }
          ] : []),
          {
            label: t("sites.browserCtxCopyUrl"),
            icon: <Globe size={13} />,
            onPick: () => navigator.clipboard?.writeText?.(activeTab?.url || "")
          },
          {
            label: t("sites.browserCtxInspect"),
            icon: <Target size={13} />,
            onPick: () => ctxMenu?.element && setInspectedElement(ctxMenu.element)
          },
          { divider: true },
          { label: t("sites.goBack"), icon: <ChevronLeft size={13} />, onPick: () => invoke("back", { targetId: watchedId }) },
          { label: t("sites.goForward"), icon: <ChevronRight size={13} />, onPick: () => invoke("forward", { targetId: watchedId }) },
          { label: t("editor.reload"), icon: <RotateCw size={13} />, onPick: () => invoke("reload", { targetId: watchedId }) },
          { divider: true },
          { label: t("sessions.deleteTitle") || "Close tab", icon: <X size={13} />, onPick: () => invoke("close", { targetId: watchedId }) }
        ]}
        onClose={() => setCtxMenu(null)}
      />

      {/* Desktop popup (window.open by the watched tab) floating over the stream */}
      {popupTab && (
        <BrowserPopupWindow
          busRef={busRef}
          connected={connected}
          targetId={popupTab.id}
          url={popupTab.url}
          onClose={() => invoke("close", { targetId: popupTab.id })}
        />
      )}

      {/* Reload dropdown: plain vs hard (ignore cache) */}
      <BrowserContextMenu
        menu={reloadMenu}
        items={[
          { label: t("editor.reload"), icon: <RotateCw size={13} />, onPick: () => invoke("reload", { targetId: watchedId }) },
          { label: t("sites.browserCtxHardReload"), icon: <RotateCw size={13} />, onPick: () => invoke("reload", { targetId: watchedId, ignoreCache: true }) }
        ]}
        onClose={() => setReloadMenu(null)}
      />
    </div>
  );
}
