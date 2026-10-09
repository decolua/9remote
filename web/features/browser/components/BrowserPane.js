"use client";

// Remote browser pane — host Chrome seen over a CDP screencast with full Orca-like
// features: Grab & Inspect, Annotate to AI, Markup drawing, Console REPL, Profiles & Cookies.
// Coordinates are pixel-perfect: the <img> shrink-fits the stage, so its own
// bounding box IS the drawn frame — map clientXY through its ratio, no letterbox math.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Globe,
  Link2,
  Loader2,
  RotateCw,
  Smartphone,
  SquarePen,
  Target,
  Terminal,
  X
} from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { vibrate } from "@/shared/utils/vibration";
import { useBrowserStore } from "@/shared/stores/browserStore";
import { useConnectionStore } from "@/shared/stores/connectionStore";
import { isLocalLink, localStreamParams, STREAM_QUALITY_LOCAL } from "@/features/browser/lib/browserFrame";
import { useBrowserInvoke } from "@/features/browser/hooks/useBrowserInvoke";
import { useBrowserFrame } from "@/features/browser/hooks/useBrowserFrame";
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
import { ProfileAvatar } from "@/features/browser/lib/profileAvatar";

// Stable empty list: a selector returning a fresh [] every call makes
// useSyncExternalStore re-render forever ("getSnapshot should be cached").
const NO_TABS = [];

// Stable hue per port — every shortcut keeps its own color, like favicons.
const siteHue = (port) => {
  let h = 0;
  for (const c of String(port)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 55% 45%)`;
};
// ~4MB/s per 3s — above this the stream costs more than a remote link carries.
// Local links run 2x raster @ q95: the budget scales with it.
const ADAPTIVE_BUDGET_BYTES = 12_000_000;
const ADAPTIVE_BUDGET_LOCAL_MULT = 2;
const SPECIAL_KEYS = {
  Enter: "enter", Tab: "tab", Escape: "escape", Backspace: "backspace", Delete: "delete",
  ArrowUp: "arrowup", ArrowDown: "arrowdown", ArrowLeft: "arrowleft", ArrowRight: "arrowright",
  Home: "home", End: "end", PageUp: "pageup", PageDown: "pagedown"
};

export default function BrowserPane({ busRef, connected = false, onBack, profile = "default", onProfileChange, workspaceId = "default" }) {
  const { t } = useI18n();
  const invoke = useBrowserInvoke(busRef, profile);
  const wsKey = workspaceId || "default";
  const tabs = useBrowserStore((s) => s.tabsByWorkspace[wsKey] ?? NO_TABS);
  const activeTargetId = useBrowserStore((s) => s.activeByWorkspace[wsKey] || null);
  const setActive = useBrowserStore((s) => s.setActive);
  const setWindowFor = useBrowserStore((s) => s.setWindowFor);
  // LAN/loopback link can carry the sharp stream; tunnel keeps host defaults.
  const isLocal = isLocalLink(useConnectionStore((s) => s.connectionMode));

  const [address, setAddress] = useState("");
  const [textOpen, setTextOpen] = useState(false);
  const [textDraft, setTextDraft] = useState("");
  const [restartTick, setRestartTick] = useState(0);
  // Adaptive quality: null = host default (85, or 95 while local). The pane
  // watches outgoing bytes and steps quality down when a 3s window exceeds
  // the budget —
  // a static page sends nothing and is never throttled.
  const [quality, setQuality] = useState(null);
  const qualityRef = useRef(quality);
  useEffect(() => { qualityRef.current = quality; }, [quality]);
  // Viewport preset override — null = follow the stage's own size.
  const [viewportPreset, setViewportPreset] = useState(null);
  const [vpMenu, setVpMenu] = useState(false);

  // Feature modes & panels. grabIntent mirrors orca: "copy" (grab) vs "annotate".
  const [grabIntent, setGrabIntent] = useState(null);
  const [inspectedElement, setInspectedElement] = useState(null);
  const [annotations, setAnnotations] = useState([]);
  const [showAnnotations, setShowAnnotations] = useState(false);
  const [markupOpen, setMarkupOpen] = useState(false);
  const [markupBase, setMarkupBase] = useState(null);
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
  const [hoverRect, setHoverRect] = useState(null); // pick-mode element under the cursor
  const [localSites, setLocalSites] = useState(null);
  const [imgBox, setImgBox] = useState(null); // drawn img rect, stage-relative
  const pickDragRef = useRef(null);
  const streamedTargetIdRef = useRef(null);

  const stageRef = useRef(null);
  const bytesWindowRef = useRef({ bytes: 0, mark: 0, applied: 0 });
  const addressRef = useRef(null);
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
    if (!connected || !bus?.emit || !watchedId) {
      console.log("TEMP DIAGNOSTIC pane stream.start SKIPPED", {
        connected, hasBus: !!bus?.emit, watchedId, tabsCount: tabs.length, activeTargetId
      });
      return;
    }
    let stopped = false;
    const rect = stageRef.current?.getBoundingClientRect();
    // A failed start leaves the pane input-dead (every browser:input throws
    // "No stream active") — retry a few times instead of waiting for the user
    // to poke the stage.
    let retries = 0;
    let currentStartedId = watchedId;
    streamedTargetIdRef.current = watchedId;
    const start = () => {
      // Retina honesty on a local link: render at the viewer's physical pixel
      // density + top jpeg quality. Tunnel omits both → host defaults (1.2x, 85).
      const boost = localStreamParams(isLocal);
      const params = {
        targetId: watchedId,
        profile,
        width: Math.round(viewportPreset?.width || rect?.width || 720),
        height: Math.round(viewportPreset?.height || rect?.height || 1280),
        mobile: !!viewportPreset?.mobile,
        scale: boost.scale,
        quality: qualityRef.current || boost.quality
      };
      console.log(`TEMP DIAGNOSTIC pane stream.start tid=${String(watchedId).slice(-6)} local=${isLocal} scale=${params.scale ?? "default"} quality=${params.quality ?? "default"}`);
      bus.emit("browser:stream.start", params, (res) => {
        console.log("TEMP DIAGNOSTIC pane stream.start cb", res);
        // Host healed a stale tab id to the profile's live tab — follow it so
        // the pane streams and inputs target the same tab.
        if (res?.ok && res.targetId) {
          currentStartedId = res.targetId;
          streamedTargetIdRef.current = res.targetId;
          if (res.targetId !== watchedId) setActive(wsKey, res.targetId);
        }
        if (res?.ok && res.quality) setQuality(res.quality);
        if (!res?.ok && !stopped && retries < 3) {
          retries += 1;
          setTimeout(() => { if (!stopped) setRestartTick((n) => n + 1); }, 1500 * retries);
        }
      });
    };
    start();
    return () => {
      stopped = true;
      const toStop = streamedTargetIdRef.current || currentStartedId || watchedId;
      bus.emit("browser:stream.stop", { targetId: toStop });
    };
  }, [busRef, connected, watchedId, restartTick, viewportPreset, profile, isLocal, setActive, wsKey]);

  // Binary frames arrive on the file lane — reassembled, decoded off-thread
  // and painted to the canvas by the hook; the pane only tracks paint events
  // (loading UX + the adaptive-bytes watchdog).
  const { canvasRef: imgRef, frame, frameRef } = useBrowserFrame({
    busRef, connected, targetId: watchedId,
    onPainted: (meta, bytes) => {
      bytesWindowRef.current.bytes += bytes;
      setLoading(false); // any frame after a navigate = the page painted
    }
  });

  // Markup snapshots the canvas at OPEN time — later frames cannot change the
  // drawing base out from under the strokes.
  useEffect(() => {
    if (markupOpen) setMarkupBase(imgRef.current?.toDataURL("image/jpeg", 0.9) || null);
  }, [markupOpen, imgRef, frame]);

  // Bandwidth watchdog: > ADAPTIVE_BUDGET_BYTES per 3s window means the link
  // (or the encoder) is the bottleneck — step jpeg quality down one notch.
  // Only one step per window, floor at 55; restart carries the new quality.
  useEffect(() => {
    const w = bytesWindowRef.current;
    w.mark = Date.now();
    const budget = ADAPTIVE_BUDGET_BYTES * (isLocal ? ADAPTIVE_BUDGET_LOCAL_MULT : 1);
    const timer = setInterval(() => {
      const now = Date.now();
      const bytes = w.bytes;
      w.bytes = 0;
      w.mark = now;
      if (bytes > budget && now - w.applied > 3000) {
        w.applied = now;
        setQuality((q) => Math.max(55, (q ?? 85) - 15));
        console.warn(`TEMP DIAGNOSTIC pane quality step-down tid=${String(watchedId).slice(-6)} bytes=${bytes} budget=${budget} local=${isLocal}`);
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [isLocal, watchedId]);

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

  // Chrome cold start costs seconds — boot the profile's browser the moment
  // the pane opens, not when the first URL is typed. Fire-and-forget.
  useEffect(() => {
    if (connected) invoke("warm");
  }, [connected, invoke]);

  // New-tab page: a blank tab lists the host's running dev servers.
  const blankTab = !activeTab?.url || /^about:blank$/.test(activeTab.url || "");
  useEffect(() => {
    if (!connected || !(blankTab || !watchedId)) return;
    const bus = busRef?.current;
    if (!bus?.emit) return;
    bus.emit("getLocalSites", (res) => {
      if (Array.isArray(res?.sites)) setLocalSites(res.sites);
    });
  }, [busRef, connected, blankTab, watchedId]);

  // Timers own input timing — never let one fire into an unmounted pane.
  useEffect(() => () => {
    if (wheelRef.current?.timer) clearTimeout(wheelRef.current.timer);
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    if (suggestTimer.current) clearTimeout(suggestTimer.current);
    if (moveTimerRef.current) clearTimeout(moveTimerRef.current);
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
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
    busRef?.current?.emit?.("browser:input", {
      targetId: watchedId,
      events,
      profile
    });
  }, [busRef, watchedId]);

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
  // Wheel coalescing: CDP mouseWheel costs 18-45ms host-side, so one-message-
  // per-event saturates the serial input queue (measured). 50ms keeps ~20
  // dispatches/s while deltas arrive in order (host serializes).
  const wheelRef = useRef(null);
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
    // Pick mode + mouse: down records the sweep start — resolves on up.
    // Touch keeps its NATIVE path (scrolling stays live); the tap-pick is
    // detected on release instead.
    if (grabIntent === "pick" && e.pointerType !== "touch") {
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
      const st = touchStartRef.current;
      if (st && Math.abs(e.clientX - st.x) + Math.abs(e.clientY - st.y) > 10) clearLongPress();
      const p = point(e);
      sendInput([{ t: "touch", type: "move", points: [p] }]);
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
    if (!frameRef.current) return;
    if (hoverTimerRef.current) return;
    const ev = e;
    hoverTimerRef.current = setTimeout(() => {
      hoverTimerRef.current = null;
      const p = point(ev);
      if (grabIntent === "pick") {
        // Pick mode: highlight the element under the cursor instead of driving
        // the page's own :hover — the pane glows what a click would collect.
        invoke("inspect", { targetId: watchedId, x: p.x, y: p.y }).then((res) => {
          const r = res?.ok && res.element ? res.element.rect : null;
          if (!r || !r.width) return setHoverRect(null);
          // Containers wrapping most of the page read as "highlighting
          // everything" — only glow reasonably-sized elements (< ~60% of the
          // viewport area, like DevTools' practical pick).
          const meta = frameRef.current?.meta || {};
          const vW = meta.deviceWidth || 0;
          const vH = meta.deviceHeight || 0;
          const tooBig = vW && vH && (r.width * r.height) / (vW * vH) > 0.6;
          setHoverRect(tooBig ? null : { ...r, ...stampScroll() });
        });
        return;
      }
      if (!grabIntent) sendInput([{ t: "pointer", type: "move", x: p.x, y: p.y }]);
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
        // Pick mode tap (finger down/up without dragging): toggle the element
        // under the finger — scrolling stays a first-class gesture.
        if (grabIntent === "pick" && touchStartRef.current) {
          const st = touchStartRef.current;
          const moved = Math.abs(e.clientX - st.x) + Math.abs(e.clientY - st.y) > 10;
          if (!moved) {
            const gp = pagePoint(e.clientX, e.clientY);
            invoke("inspect", { targetId: watchedId, x: gp.x, y: gp.y }).then((res) => {
              if (res?.ok && res.element) togglePicked(res.element);
            });
          }
        }
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
      if (!frameRef.current) return;
      e.preventDefault();
      const p = pagePoint(e.clientX, e.clientY);
      const acc = wheelRef.current || (wheelRef.current = { x: p.x, y: p.y, deltaX: 0, deltaY: 0, ctrlKey: false });
      acc.x = p.x; acc.y = p.y;
      acc.deltaX += e.deltaX;
      acc.deltaY += e.deltaY;
      acc.ctrlKey = acc.ctrlKey || e.ctrlKey;
      if (acc.timer) return;
      acc.timer = setTimeout(() => {
        acc.timer = null;
        sendInput([{ t: "wheel", x: acc.x, y: acc.y, deltaX: acc.deltaX, deltaY: acc.deltaY, ctrlKey: acc.ctrlKey }]);
        acc.deltaX = 0; acc.deltaY = 0; acc.ctrlKey = false;
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
      const liveTabs = useBrowserStore.getState().tabsByWorkspace[wsKey] || [];
      const goLive = watchedId && liveTabs.some((tb) => tb.id === watchedId);
      // Boot placeholder: the strip (and this pane's loading state) shows the
      // tab WHILE Chrome launches — swapped for the real id once open resolves.
      const bootId = goLive ? null : `boot_${Date.now()}`;
      if (bootId) {
        const st = useBrowserStore.getState();
        st.setTabs(wsKey, [...(st.tabsByWorkspace[wsKey] || []), { id: bootId, url, title: "", booting: true }]);
        setActive(wsKey, bootId);
      }
      const res = goLive
        ? await invoke("go", { targetId: watchedId, url })
        : await invoke("open", { url });
      setLoading(false);
      if (bootId) {
        const st = useBrowserStore.getState();
        const cur = (st.tabsByWorkspace[wsKey] || []).filter((tb) => tb.id !== bootId);
        if (res?.ok && res.id && !cur.some((tb) => tb.id === res.id)) cur.push({ id: res.id, url: res.url, title: "" });
        st.setTabs(wsKey, cur);
        st.setActive(wsKey, (res?.ok && res.id) || cur[cur.length - 1]?.id || null);
      }
      if (res?.ok && res.id) {
        setActive(wsKey, res.id);
        // The opened (or heal-opened) tab names the workspace's Chrome window —
        // without it useBrowserTabs watches nothing and the strip never gets
        // host pushes, so dead tabs pile up after a Chrome restart.
        if (res.windowId != null) setWindowFor(wsKey, res.windowId);
        // Optimistic tab entry — the host's push (2s poll) replaces it; without
        // this the stream waits a full poll cycle before starting.
        const cur = useBrowserStore.getState().tabsByWorkspace[wsKey] || [];
        if (!cur.some((tb) => tb.id === res.id)) {
          useBrowserStore.getState().setTabs(wsKey, [...cur, { id: res.id, url: res.url, title: "" }]);
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
              placeholder={t("sites.browserPaneSearchOrUrl")}
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
          onClick={() => { vibrate(); setGrabIntent((g) => (g === "pick" ? null : "pick")); setInspectedElement(null); setHoverRect(null); }}
          disabled={!frame}
          className={`h-8 w-8 shrink-0 relative flex items-center justify-center rounded-[6px] transition-colors disabled:opacity-40 disabled:pointer-events-none ${
            grabIntent === "pick" ? "bg-text/80 text-surface hover:bg-text/90" : "text-text-muted hover:text-text hover:bg-surface-2"
          }`}
          title="Pick page elements"
        >
          <Target size={16} />
        </button>

        {/* Profile chip — Chrome's avatar button: the ONLY menu door now
            (tools, profiles, import, viewport all live behind it) */}
        <button
          onClick={() => { setMenuSection(null); setMenuOpen(true); }}
          className="h-7 shrink-0 flex items-center gap-1.5 px-1.5 rounded-[6px] text-text-muted hover:text-text hover:bg-surface-2 transition-colors"
          title={profile}
        >
          <ProfileAvatar name={profile} size={16} />
          <span className="hidden md:inline text-[11px] font-medium max-w-[80px] truncate">{profile}</span>
        </button>
      </div>

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
        onPointerLeave={() => { setHoverRect(null); if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; } }}
        style={{ cursor: grabIntent ? "crosshair" : cursor }}
        className="flex-1 min-h-0 bg-black relative overflow-hidden outline-none touch-none select-none flex items-center justify-center"
      >
        {/* Always mounted — paint() needs the canvas BEFORE the first frame
            state exists; hiding it via opacity breaks that chicken-and-egg. */}
        <canvas
          ref={imgRef}
          width={frame?.w || 16}
          height={frame?.h || 16}
          className={`max-w-full max-h-full object-contain pointer-events-none ${frame ? "" : "opacity-0"}`}
        />
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
                    className="absolute rounded-[3px] border-2 border-brand-500 bg-brand-500/15 shadow-[0_0_0_1px_rgba(0,0,0,0.4)]"
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
        {hoverRect && grabIntent === "pick" && frame && imgBox && (() => {
          const meta = frame.meta || {};
          const vW = meta.deviceWidth;
          const vH = meta.deviceHeight;
          if (!vW || !vH || !hoverRect.width) return null;
          const dx = (meta.scrollX || 0) - (hoverRect.scrollX || 0);
          const dy = (meta.scrollY || 0) - (hoverRect.scrollY || 0);
          return (
            <div
              className="absolute pointer-events-none z-[6] rounded-[3px] border-2 border-amber-400 bg-amber-400/15 shadow-[0_0_0_1px_rgba(0,0,0,0.4)]"
              style={{
                left: imgBox.left + ((hoverRect.x - dx) / vW) * imgBox.width,
                top: imgBox.top + ((hoverRect.y - dy) / vH) * imgBox.height,
                width: (hoverRect.width / vW) * imgBox.width,
                height: (hoverRect.height / vH) * imgBox.height
              }}
            />
          );
        })()}
        {rubber && (
          <div
            className="absolute pointer-events-none border border-brand-400 bg-brand-500/15 rounded-[2px] z-[6]"
            style={{ left: rubber.left, top: rubber.top, width: rubber.width, height: rubber.height }}
          />
        )}
        {/* Device size — on-stage control, always reachable while browsing */}
        <div className="absolute bottom-3 left-3 z-10">
          {vpMenu && (
            <div className="absolute bottom-10 left-0 flex flex-col p-1 rounded-xl card-elev animate-in fade-in duration-100 min-w-[150px]">
              {[
                { label: "Fit (follow pane)", w: null, h: null },
                { label: "Mobile 375×667", w: 375, h: 667, mobile: true },
                { label: "Tablet 768×1024", w: 768, h: 1024 },
                { label: "Desktop 1120×780", w: 1120, h: 780 }
              ].map((opt) => (
                <button
                  key={opt.label}
                  onClick={() => {
                    vibrate();
                    setViewportPreset(opt.w ? { width: opt.w, height: opt.h, mobile: !!opt.mobile } : null);
                    if (opt.w) invoke("viewport", { targetId: watchedId, width: opt.w, height: opt.h, mobile: !!opt.mobile });
                    else invoke("viewport", { targetId: watchedId, reset: true });
                    setRestartTick((n) => n + 1);
                    setVpMenu(false);
                  }}
                  className={`text-left px-2.5 py-1.5 rounded-brand text-xs transition-colors ${
                    (opt.w ? viewportPreset?.width === opt.w : !viewportPreset) ? "bg-surface-3 text-text font-medium" : "text-text-muted hover:bg-surface-2 hover:text-text"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
          <button
            onClick={() => { vibrate(); setVpMenu((v) => !v); }}
            className={`h-8 w-8 flex items-center justify-center rounded-full shadow-[0_2px_10px_rgba(0,0,0,0.4)] transition-colors ${
              viewportPreset ? "bg-brand-500 text-white" : "bg-surface/90 text-text-muted hover:text-text backdrop-blur"
            }`}
            title="Device size"
          >
            <Smartphone size={15} />
          </button>
        </div>

        {/* Pick chip — bottom-right: send picks or exit pick mode */}
        {(grabIntent === "pick" || picked.length > 0) && !pickOpen && (
          <div className="absolute bottom-3 right-3 z-10 flex items-center gap-1.5 rounded-full shadow-xl p-0.5">
            {picked.length > 0 ? (
              <button
                onClick={() => { vibrate(); setPickOpen(true); }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-brand-500 hover:bg-brand-600 text-white text-xs font-medium shadow-md transition-colors"
              >
                <Target size={13} />
                <span>{`${picked.length} picked — Send`}</span>
              </button>
            ) : (
              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface/95 text-text border border-border-subtle text-xs font-medium backdrop-blur">
                <Target size={13} className="text-brand-500" />
                <span>Pick elements</span>
              </div>
            )}
            {grabIntent === "pick" && (
              <button
                onClick={() => { vibrate(); setGrabIntent(null); }}
                className="w-7 h-7 flex items-center justify-center rounded-full bg-surface/90 hover:bg-surface text-text-muted hover:text-text border border-border-subtle transition-colors"
                title="Exit pick mode"
              >
                <X size={12} />
              </button>
            )}
          </div>
        )}
        {!connected && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-text-muted bg-surface">
            {t("sites.browserPaneNotConnected")}
          </div>
        )}
        {(connected && (!watchedId || blankTab)) && localSites !== null && localSites.length > 0 && (
          <div className="absolute inset-0 z-[7] overflow-y-auto bg-surface">
            <div className="pt-[14vh] flex flex-wrap justify-center gap-x-1 gap-y-5 px-6 max-w-2xl mx-auto">
              {localSites.map((site) => {
                const label = site.name && !/^localhost:\d+$/.test(site.name) ? site.name : null;
                return (
                  <button
                    key={site.port}
                    onClick={() => { vibrate(); navigate(site.url); }}
                    className="group flex w-[84px] flex-col items-center gap-1.5 p-2 rounded-lg hover:bg-surface-2/70 transition-colors"
                    title={site.url}
                  >
                    <span
                      className="w-11 h-11 rounded-full flex items-center justify-center text-white text-[13px] font-bold font-mono"
                      style={{ backgroundColor: siteHue(site.port) }}
                    >
                      {site.port}
                    </span>
                    <span className="text-xs text-text font-medium font-mono">:{site.port}</span>
                    {label && <span className="w-full text-center text-[10px] text-text-muted truncate">{label}</span>}
                  </button>
                );
              })}
            </div>
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
          invoke={invoke}
          targetId={watchedId}
          frameMeta={frame?.meta}
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

      {/* Markup Drawer — snapshots the live canvas as its base image */}
      {markupOpen && (
        <BrowserMarkupOverlay
          frameImgSrc={markupBase}
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
          profile={profile}
          onSelectProfile={onProfileChange}
          targetId={watchedId}
          url={activeTab?.url}
          initialSection={menuSection}
          onCopyUrl={copyUrl}
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
          profile={profile}
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
