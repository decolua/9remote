"use client";

// Remote browser pane — host Chrome seen over a CDP screencast with full Orca-like
// features: Grab & Inspect, Annotate to AI, Markup drawing, Console REPL, Profiles & Cookies.
// Coordinates are pixel-perfect: the <img> shrink-fits the stage, so its own
// bounding box IS the drawn frame — map clientXY through its ratio, no letterbox math.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
import BrowserPickModal from "./BrowserPickModal";
import { resolveOmniboxInput } from "@/features/browser/lib/omnibox";

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
  const activeProfile = useBrowserStore((s) => s.activeProfile);
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

  // Element picking: grabIntent "pick" collects elements (tap = one, drag =
  // sweep) with highlight rings over the stream, then a review modal.
  const [picked, setPicked] = useState([]);
  const [pickOpen, setPickOpen] = useState(false);
  const [rubber, setRubber] = useState(null); // stage-relative sweep rectangle
  const [imgBox, setImgBox] = useState(null); // drawn img rect, stage-relative
  const pickDragRef = useRef(null);

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
  const navigatingRef = useRef(false);
  // TEMP DIAGNOSTIC pane: frame throughput + input send rate (1 line/s in devtools)
  const diagRef = useRef({ frames: 0, bytes: 0, lastSeq: 0, sends: 0, mark: 0, mismatchAt: 0 });

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

  // Popup gone → the parent stream restarts: the popup's stream start had
  // fronted ITS tab, and without a restart the parent keeps streaming a
  // background tab (stalled). A restart re-fronts it on the host side.
  const prevPopupIdRef = useRef(null);
  useEffect(() => {
    const had = prevPopupIdRef.current;
    prevPopupIdRef.current = popupTab?.id || null;
    if (had && had !== popupTab?.id) setRestartTick((n) => n + 1);
  }, [popupTab?.id]);

  const [prevWatched, setPrevWatched] = useState(null);
  if (prevWatched !== watchedId) {
    setPrevWatched(watchedId);
    setAddress(activeTab?.url && !/^about:blank$/.test(activeTab.url) ? activeTab.url : "");
    setPicked([]); // a different tab is a different page — picks do not carry over
  }
  // Follow in-page navigation (link clicks, redirects): the URL in the strip
  // changes, so the address bar follows — unless the user is typing in it.
  const tabUrl = activeTab?.url && !/^about:blank$/.test(activeTab.url) ? activeTab.url : null;
  useEffect(() => {
    if (tabUrl && document.activeElement !== addressRef.current) setAddress(tabUrl);
  }, [tabUrl]);

  // Screencast stream lifecycle
  useEffect(() => {
    const bus = busRef?.current;
    if (!connected || !bus?.emit || !watchedId) return;
    let stopped = false;
    const rect = stageRef.current?.getBoundingClientRect();
    if (DIAG) console.debug(`[pane] stream.start stage=${Math.round(rect?.width || 0)}x${Math.round(rect?.height || 0)} dpr=${window.devicePixelRatio || 1}`);
    bus.emit("browser:stream.start", {
      targetId: watchedId,
      profile: activeProfile || "default",
      width: Math.round(viewportPreset?.width || rect?.width || 720),
      height: Math.round(viewportPreset?.height || rect?.height || 1280),
      // Retina honesty: render at the viewer's physical pixel density.
      scale: Math.min(2, window.devicePixelRatio || 1)
    }, (res) => {
      // Host healed a stale tab id to the profile's live tab — follow it so
      // the pane streams and inputs target the same tab.
      if (res?.ok && res.targetId && res.targetId !== watchedId) setActive(res.targetId);
    });
    const onFrame = (f) => {
      if (stopped) return;
      // TEMP DIAGNOSTIC: frames arriving for another tab are normal (broadcast),
      // but a persistent mismatch means the pane never re-attached after a heal.
      if (DIAG && f?.image && f.targetId !== watchedId && Date.now() - diagRef.current.mismatchAt > 1000) {
        diagRef.current.mismatchAt = Date.now();
        console.debug(`[pane] dropping frame targetId=${f.targetId} watched=${watchedId}`);
      }
      if (f?.targetId !== watchedId || !f.image) return;
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
  }, [busRef, connected, watchedId, restartTick, viewportPreset, activeProfile]);

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
    busRef?.current?.emit?.("browser:input", {
      targetId: watchedId,
      events,
      profile: useBrowserStore.getState().activeProfile || "default"
    });
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

  // Drawn-frame box (stage-relative): rings and the sweep rect position against
  // it, so they follow the shrink-fit image on any stage resize.
  const hasFrame = !!frame;
  useLayoutEffect(() => {
    const update = () => {
      const img = imgRef.current;
      const stage = stageRef.current;
      if (!img || !stage) return setImgBox(null);
      const ir = img.getBoundingClientRect();
      const sr = stage.getBoundingClientRect();
      if (!ir.width || !ir.height) return setImgBox(null);
      const next = { left: ir.left - sr.left, top: ir.top - sr.top, width: ir.width, height: ir.height };
      setImgBox((prev) => (prev
        && Math.abs(prev.left - next.left) < 0.5 && Math.abs(prev.top - next.top) < 0.5
        && Math.abs(prev.width - next.width) < 0.5 && Math.abs(prev.height - next.height) < 0.5
        ? prev : next));
    };
    update();
    const ro = new ResizeObserver(update);
    if (stageRef.current) ro.observe(stageRef.current);
    if (imgRef.current) ro.observe(imgRef.current);
    return () => ro.disconnect();
  }, [hasFrame]);

  // Stage resized (layout settling, pane split, fullscreen) → restart the
  // stream at the new size. The stream measures the stage ONCE at start; left
  // alone it would keep serving the old resolution stretched = blurry.
  const stageSizeRef = useRef(null);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let timer = null;
    const ro = new ResizeObserver(() => {
      const r = stage.getBoundingClientRect();
      const last = stageSizeRef.current;
      stageSizeRef.current = { w: Math.round(r.width), h: Math.round(r.height) };
      if (!last) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (Math.abs(r.width - last.w) + Math.abs(r.height - last.h) > 24) {
          setRestartTick((n) => n + 1);
        }
      }, 300);
    });
    ro.observe(stage);
    return () => {
      clearTimeout(timer);
      ro.disconnect();
    };
  }, []);

  const pickKey = (el) => el?.selector || el?.tag || "element";
  const stampScroll = () => ({
    scrollX: frameRef.current?.meta?.scrollX || 0,
    scrollY: frameRef.current?.meta?.scrollY || 0
  });
  const addPicked = (els) => {
    if (!Array.isArray(els) || !els.length) return;
    setPicked((prev) => {
      const seen = new Set(prev.map(pickKey));
      const fresh = els.filter((el) => el && !seen.has(pickKey(el))).map((el) => ({ ...el, ...stampScroll() }));
      return fresh.length ? [...prev, ...fresh] : prev;
    });
  };
  const togglePicked = (el) => {
    if (!el) return;
    setPicked((prev) => {
      const idx = prev.findIndex((p) => pickKey(p) === pickKey(el));
      if (idx >= 0) return prev.filter((_, i) => i !== idx);
      return [...prev, { ...el, ...stampScroll() }];
    });
  };

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
    // Pick mode: down only records the sweep start — the pick resolves on up.
    if (grabIntent === "pick") {
      pickDragRef.current = { sx: e.clientX, sy: e.clientY, moved: false };
      return;
    }
    // Annotate mode: the tap picks an element instead of clicking.
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
    // Pick sweep: track the drag, show the rubber band once it leaves the tap slop.
    if (grabIntent === "pick" && pickDragRef.current) {
      const d = pickDragRef.current;
      if (!d.moved && Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 8) d.moved = true;
      if (d.moved) {
        const sb = stageRef.current?.getBoundingClientRect();
        if (sb) {
          setRubber({
            left: Math.min(d.sx, e.clientX) - sb.left,
            top: Math.min(d.sy, e.clientY) - sb.top,
            width: Math.abs(e.clientX - d.sx),
            height: Math.abs(e.clientY - d.sy)
          });
        }
      }
      return;
    }
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
    // Pick resolves here: a tap inspects one element (toggle), a sweep collects
    // everything inside the dragged rectangle.
    if (grabIntent === "pick" && pickDragRef.current) {
      const d = pickDragRef.current;
      pickDragRef.current = null;
      setRubber(null);
      if (d.moved) {
        const a = pagePoint(d.sx, d.sy);
        const b = point(e);
        const x = Math.min(a.x, b.x);
        const y = Math.min(a.y, b.y);
        const width = Math.abs(a.x - b.x);
        const height = Math.abs(a.y - b.y);
        if (width >= 4 && height >= 4) {
          invoke("pick.rect", { targetId: watchedId, x, y, width, height }).then((res) => {
            if (res?.ok && Array.isArray(res.elements)) addPicked(res.elements);
          });
        }
      } else {
        const gp = point(e);
        invoke("inspect", { targetId: watchedId, x: gp.x, y: gp.y }).then((res) => {
          if (res?.ok && res.element) togglePicked(res.element);
        });
      }
      return;
    }
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
    // Chrome-style omnibox: a bare host gains https://, anything else searches.
    const url = resolveOmniboxInput(String(urlOverride ?? address))?.url;
    if (!url) return;
    // One door: a second Enter before the first "open" resolves would spawn
    // another tab — watchedId is only set once the invoke returns.
    if (navigatingRef.current) return;
    navigatingRef.current = true;
    try {
      vibrate();
      setSuggest({ open: false, items: [], idx: -1 });
      setLoadError(null);
      setLoading(true);
      // No LIVE tab (none yet, or a stale persisted id after a Chrome restart):
      // the typed address boots a fresh tab instead of failing on the dead one.
      const liveTabs = useBrowserStore.getState().tabs;
      const res = watchedId && liveTabs.some((tb) => tb.id === watchedId)
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
    } finally {
      navigatingRef.current = false;
    }
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
      const omnibox = resolveOmniboxInput(q);
      const searchRow = omnibox?.isSearch ? [{
        isSearch: true,
        url: omnibox.url,
        title: `${t("sites.browserPaneSearchFor")} "${q}"`
      }] : [];
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
    if (e.key === "Enter") {
      // Stop the keydown BEFORE it also submits the form — Enter otherwise
      // navigates twice (keydown handler + onSubmit) and "open" spawns a tab
      // per call while no tab exists yet.
      e.preventDefault();
      navigate();
    }
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
        {/* No exit X: the browser is a tab like a terminal — leaving = picking
            another tab in the strip (which pushes that view on top). */}
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
              inputMode="url"
              value={address}
              onFocus={(e) => e.target.select()}
              onChange={(e) => { setAddress(e.target.value); refreshSuggestions(e.target.value); }}
              onKeyDown={onAddressKeyDown}
              onBlur={() => {
                setTimeout(() => setSuggest((s) => ({ ...s, open: false })), 150);
                // Leftover typed text without Enter: fall back to the page URL.
                const u = activeTab?.url && !/^about:blank$/.test(activeTab.url) ? activeTab.url : "";
                setTimeout(() => { if (u && addressRef.current?.value !== u) setAddress(u); }, 200);
              }}
              placeholder={t("sites.browserSearchOrUrl") || "Search or type URL"}
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

        {/* Pick elements — orca Crosshair; inverted while armed */}
        <button
          onClick={() => { vibrate(); setGrabIntent((g) => (g === "pick" ? null : "pick")); setInspectedElement(null); }}
          disabled={!frame?.src}
          className={`h-8 w-8 shrink-0 relative flex items-center justify-center rounded-[6px] transition-colors disabled:opacity-40 disabled:pointer-events-none ${
            grabIntent === "pick" ? "bg-text/80 text-surface hover:bg-text/90" : "text-text-muted hover:text-text hover:bg-surface-2"
          }`}
          title="Pick page elements"
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

        {/* ⋯ menu (profiles · cookies · viewport · keyboard · notes · markup · console) */}
        <button
          onClick={() => { setMenuSection(null); setMenuOpen(true); }}
          className="h-7 w-7 shrink-0 flex items-center justify-center rounded-[6px] text-text-muted hover:text-text hover:bg-surface-2 transition-colors"
          title="Browser menu"
        >
          <MoreHorizontal size={16} />
        </button>
      </div>

      {/* Pick/annotate armed banner (orca's status banner) */}
      {grabIntent && (
        <div className="shrink-0 bg-text/85 text-surface text-xs px-3 py-1 flex items-center justify-between gap-2">
          <span className="truncate">
            {grabIntent === "pick"
              ? `🎯 Pick — click or drag to select elements${picked.length ? ` · ${picked.length}` : ""}`
              : "💬 Annotate — click an element to add a note"}
          </span>
          <span className="flex items-center gap-2 shrink-0">
            {grabIntent === "pick" && picked.length > 0 && (
              <button onClick={() => { vibrate(); setPickOpen(true); }} className="underline text-[11px] font-medium">Review</button>
            )}
            <button onClick={() => setGrabIntent(null)} className="underline text-[11px]">Done</button>
          </span>
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
        {/* Pick rings — viewport rects mapped onto the drawn frame, drifting with
            the page's own scroll (rect was captured at pick time). */}
        {frame && imgBox && picked.length > 0 && (() => {
          const meta = frame.meta || {};
          const vW = meta.deviceWidth;
          const vH = meta.deviceHeight;
          if (!vW || !vH) return null;
          return (
            <div className="absolute pointer-events-none z-[5]" style={{ left: imgBox.left, top: imgBox.top, width: imgBox.width, height: imgBox.height }}>
              {picked.map((it, i) => {
                if (!it.rect) return null;
                const dx = (meta.scrollX || 0) - (it.scrollX || 0);
                const dy = (meta.scrollY || 0) - (it.scrollY || 0);
                const left = ((it.rect.x - dx) / vW) * 100;
                const top = ((it.rect.y - dy) / vH) * 100;
                const width = (it.rect.width / vW) * 100;
                const height = (it.rect.height / vH) * 100;
                if (left + width <= 0 || top + height <= 0 || left >= 100 || top >= 100) return null;
                return (
                  <div
                    key={`${pickKey(it)}-${i}`}
                    className="absolute rounded-[3px] border-2 border-brand-500 bg-brand-500/15 shadow-[0_0_0_1px_rgba(0,0,0,0.7)]"
                    style={{ left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` }}
                  >
                    <span className="absolute top-0.5 left-0.5 min-w-4 h-4 px-1 rounded-full bg-brand-500 text-white text-[10px] leading-4 text-center font-semibold shadow-[0_1px_2px_rgba(0,0,0,0.6)]">
                      {i + 1}
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })()}
        {rubber && (
          <div
            className="absolute pointer-events-none border border-brand-400 bg-brand-500/15 rounded-[2px] z-[6]"
            style={{ left: rubber.left, top: rubber.top, width: rubber.width, height: rubber.height }}
          />
        )}
        {picked.length > 0 && !grabIntent && !pickOpen && (
          <button
            onClick={() => { vibrate(); setPickOpen(true); }}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 px-3 py-1.5 rounded-full bg-text/85 text-surface text-xs font-medium shadow-lg transition-colors hover:bg-text/95"
          >
            🎯 {picked.length} picked — Review
          </button>
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
        <div
          className="flex items-center gap-2 p-2 border-t border-border-subtle shrink-0 bg-surface"
          style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}
        >
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

      {/* Element pick review (copy / send to a running session) */}
      {pickOpen && (
        <BrowserPickModal
          picked={picked}
          url={activeTab?.url}
          onRemoveItem={(idx) => setPicked((prev) => prev.filter((_, i) => i !== idx))}
          onClear={() => setPicked([])}
          onClose={() => setPickOpen(false)}
        />
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
          onOpenMarkup={() => setMarkupOpen(true)}
          onOpenConsole={() => setConsoleOpen(true)}
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
