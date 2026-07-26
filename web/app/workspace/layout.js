"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { useSocket } from "@/features/session/hooks/useSocket";
import { useSessionStorage } from "@/shared/hooks/useSessionStorage";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { useUIStore } from "@/shared/stores/uiStore";
import { useFileSocket } from "@/features/fileExplorer/hooks/useFileSocket";
import { useClipboardSocket } from "@/features/clipboard/hooks/useClipboardSocket";
import { addRecentWorkspace, getRecentWorkspaces, updateRecentWorkspacePath, updateOpenedFiles } from "@/features/fileExplorer/components/WorkspaceList";
import { useNotification } from "@/shared/hooks/useNotification";
import { statusVisual } from "@/shared/utils/statusVisual";
import { updateTitle } from "@/shared/utils/titleMarquee";
import { DESKTOP_BREAKPOINT, PANE_MIN_WIDTH } from "@/features/terminal/constants/terminalConfig";
import MobileKeyboard from "@/features/terminal/components/MobileKeyboard";
import { usePwaInstallInit } from "@/features/terminal/hooks/usePwaInstallInit";
import { useSwipeTab } from "@/features/terminal/hooks/useSwipeTab";
import AnimatedBackground from "@/features/landing/components/AnimatedBackground";

const TerminalHeader = dynamic(() => import("@/features/terminal/components/TerminalHeader"), { ssr: false });
const TerminalPane = dynamic(() => import("@/features/terminal/components/TerminalPane"), { ssr: false });
const SessionList = dynamic(() => import("@/features/session/components/SessionList"), { ssr: false });
const RemoteDesktop = dynamic(() => import("@/features/remote/components/RemoteDesktop"), { ssr: false });
const WorkspaceList = dynamic(() => import("@/features/fileExplorer/components/WorkspaceList"), { ssr: false });
const FileExplorer = dynamic(() => import("@/features/fileExplorer/components/FileExplorer"), { ssr: false });
const FileEditor = dynamic(() => import("@/features/fileExplorer/components/FileEditor"), { ssr: false });
const GitPanel = dynamic(() => import("@/features/fileExplorer/components/GitPanel"), { ssr: false });
const FileWorkspaceDesktop = dynamic(() => import("@/features/fileExplorer/components/FileWorkspaceDesktop"), { ssr: false });
import ConnectionModal from "@/shared/components/ui/ConnectionModal";
import UpdateModal from "@/shared/components/ui/UpdateModal";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";
import SlideMenu from "@/shared/components/ui/SlideMenu";
import { useI18n } from "@/shared/i18n";
import { useRouteSync } from "@/shared/hooks/useRouteSync";
import { useLastRoute } from "@/shared/hooks/useLastRoute";

// Workspace shell - holds socket/state/views; child routes are URL markers only
export default function WorkspaceLayout({ children }) {
  const { t } = useI18n();
  // Hydration state for Zustand
  const [hydrated, setHydrated] = useState(false);
  // Capture PWA beforeinstallprompt as early as possible (Chromium-only).
  usePwaInstallInit();

  // UI state from Zustand store (persisted to sessionStorage)
  const {
    viewStack,
    openedSessions,
    pushView,
    popView: storePopView,
    setViewStack,
    addOpenedSession,
    removeOpenedSession,
    activeGroupId,
    setActiveGroupId,
    livePanes,
    touchLivePane,
    mountedGroups,
    markGroupMounted,
    isGroupMounted,
    reset: resetStore,
    cwdBySession
  } = useTerminalStore();

  // Lazy per-group mount: the FIRST time a group becomes active, mark it mounted so its panes'
  // XTterms initialize. Other groups stay as placeholders until visited — avoids mounting every
  // terminal across all groups at once (5+ concurrent joins → main-thread stall). Panes inside a
  // newly-active group join sequentially (focus first, rest staggered) via mountDelay.
  // (Effect body defined here; fired after isTerminalView is computed below.)

  // Hydrate Zustand on mount
  useEffect(() => {
    setHydrated(true);
  }, []);

  const router = useRouter();
  const { getAuth } = useSessionStorage();
  const { socket, socketRef, protocolRef, connected, connectionMode, transport, sessions, remoteAvailable, codespaceInfo, codespaceDisconnected, codespaceStopping, platform, agentVersion, updateAvailable, canSelfUpdate, triggerUpdate, triggerRestart, retryStatus, approvalStatus, loadSessions, createSession, deleteSession, renameSession, stopCodespace, groups, loadGroups, createGroup, renameGroup, deleteGroup, moveSession, reorderSession } = useSocket();
  const [shells, setShells] = useState([]);
  const [updating, setUpdating] = useState(false);
  const [updateMode, setUpdateMode] = useState("update");

  // Run the actual update: drive UpdateModal + suppress ConnectionModal during restart
  const doUpdate = useCallback(() => {
    if (triggerUpdate()) { setUpdateMode("update"); setUpdating(true); }
  }, [triggerUpdate]);

  // Run host restart (no reinstall): WS reconnect handles the gap (~2s).
  // No modal — ConnectionModal shows "reconnecting" while server child respawns.
  const doRestart = useCallback(() => {
    triggerRestart();
  }, [triggerRestart]);

  // Ask for confirmation before self-update (restarts connection, ~1 min)
  const handleUpdate = useCallback(() => {
    setConfirmDialog({
      isOpen: true,
      title: t("menu.updateConfirmTitle"),
      message: t("menu.updateConfirmMessage"),
      onConfirm: doUpdate,
    });
  }, [doUpdate, t]);

  // Ask for confirmation before host restart
  const handleRestart = useCallback(() => {
    setConfirmDialog({
      isOpen: true,
      title: t("menu.restartConfirmTitle"),
      message: t("menu.restartConfirmMessage"),
      onConfirm: doRestart,
    });
  }, [doRestart, t]);

  // Hardcoded Windows shell picker: Command Prompt + PowerShell only.
  // Non-Windows hides the picker. Override agent-reported list intentionally.
  useEffect(() => {
    if (!connected) return;
    if (platform === "win32") {
      setShells([
        { id: "cmd", label: "Command Prompt" },
        { id: "powershell", label: "PowerShell" }
      ]);
    } else {
      setShells([]);
    }
  }, [connected, platform]);
  const fileSocket = useFileSocket(socketRef);
  useClipboardSocket(socketRef, connected);
  const { subscribeToPush, unsubscribeFromPush, notifications, sessionStatus, clearNotification } = useNotification(socketRef, connected);

  const [systemInfo, setSystemInfo] = useState(null);
  const [confirmDialog, setConfirmDialog] = useState({ isOpen: false, title: "", message: "", onConfirm: null });
  const setKeyboardOpen = useUIStore((state) => state.setKeyboardOpen); // Selector - only subscribe to function
  // Mobile-only: file opened as overlay above the files view (no viewStack entry).
  // Keeps the explorer mounted so Back (X) returns to the same folder without reload.
  const [mobileEditor, setMobileEditor] = useState(null);
  // Desktop: stable ref so GitPanel/explorer can ask FileWorkspaceDesktop to open a file
  // in-place (add tab + activate) without pushing a new editor view onto the stack.
  const openFileRef = useRef(null);

  // Desktop split-view detection
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth >= DESKTOP_BREAKPOINT : false
  );
  const bindSwipeTab = useSwipeTab();
  useEffect(() => {
    let timerId = 0;
    const check = () => {
      clearTimeout(timerId);
      timerId = setTimeout(() => setIsDesktop(window.innerWidth >= DESKTOP_BREAKPOINT), 50);
    };
    window.addEventListener("resize", check);
    return () => {
      clearTimeout(timerId);
      window.removeEventListener("resize", check);
    };
  }, []);

  // Registry of per-pane APIs (focus, doResize) for MobileKeyboard callbacks
  const paneApisRef = useRef({});
  const registerPaneApi = useCallback((sessionId, api) => {
    if (api) paneApisRef.current[sessionId] = api;
    else delete paneApisRef.current[sessionId];
  }, []);

  // Registry of pane DOM elements for auto-scroll into view
  const paneElementsRef = useRef({});
  const registerPaneElement = useCallback((sessionId, el) => {
    if (el) paneElementsRef.current[sessionId] = el;
    else delete paneElementsRef.current[sessionId];
  }, []);

  // Desktop: measure focused pane rect so the shared input bar aligns to it (width + left offset).
  const panesContainerRef = useRef(null);
  const [focusPaneRect, setFocusPaneRect] = useState(null);
  // Per-inactive-pane rects (desktop) so ghost inputs align with the real overlay input.
  const [ghostRects, setGhostRects] = useState([]);

  // MobileKeyboard text-input API (for long-press paste fallback)
  const keyboardTextApiRef = useRef(null);
  const registerKeyboardTextApi = useCallback((api) => {
    keyboardTextApiRef.current = api;
  }, []);
  const handlePasteFallback = useCallback(() => {
    keyboardTextApiRef.current?.openTextPanel?.();
  }, []);

  // Current view is top of stack (guard against empty/corrupted viewStack)
  const currentView = viewStack[viewStack.length - 1] || { type: "list" };
  // Active session at component scope (needed by terminal IIFE)
  const isTerminalView = currentView?.type === "terminal";
  const activeSessionId = isTerminalView ? currentView?.sessionId : null;

  // Measure focused pane rect (desktop only) so the input bar matches its width + left offset.
  // Re-measures on focus change, pane/container resize, and horizontal scroll of the panes row.
  // Coalesced via rAF so rapid scroll/mount churn doesn't storm re-renders (jank on last tab).
  useEffect(() => {
    if (!isDesktop) { setFocusPaneRect(null); return; }
    const container = panesContainerRef.current;
    const pane = activeSessionId ? paneElementsRef.current[activeSessionId] : null;
    if (!container || !pane) { setFocusPaneRect(null); return; }
    let rafId = 0;
    const measure = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        const c = container.getBoundingClientRect();
        const p = pane.getBoundingClientRect();
        setFocusPaneRect({ left: p.left - c.left, width: p.width });
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(pane);
    ro.observe(container);
    container.addEventListener("scroll", measure, { passive: true });
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      ro.disconnect();
      container.removeEventListener("scroll", measure);
    };
  }, [isDesktop, activeSessionId, sessions, activeGroupId]);

  // Measure every desktop pane (except focused) so ghost inputs overlay the panes row aligned
  // with the real MobileKeyboard below. Re-measures on resize + horizontal scroll (parity with
  // the focused-pane measure above).
  useEffect(() => {
    if (!isDesktop) { setGhostRects([]); return; }
    const container = panesContainerRef.current;
    if (!container) { setGhostRects([]); return; }
    let rafId = 0;
    const measure = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        const c = container.getBoundingClientRect();
        const activeGroup = new Set(
          sessions.filter((s) => (s.groupId || null) === activeGroupId).map((s) => s.id)
        );
        const rects = [];
        for (const [sid, el] of Object.entries(paneElementsRef.current)) {
          if (!el || sid === activeSessionId) continue;
          if (!activeGroup.has(sid)) continue;
          const p = el.getBoundingClientRect();
          rects.push({ sessionId: sid, left: p.left - c.left, width: p.width });
        }
        setGhostRects(rects);
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(container);
    Object.values(paneElementsRef.current).forEach((el) => el && ro.observe(el));
    container.addEventListener("scroll", measure, { passive: true });
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      ro.disconnect();
      container.removeEventListener("scroll", measure);
    };
  }, [isDesktop, activeSessionId, sessions, activeGroupId]);

  // Lazy per-group mount: the FIRST time a group becomes active, mark it mounted so its panes'
  // XTterms initialize. Other groups stay as placeholders until visited — avoids mounting every
  // terminal across all groups at once (5+ concurrent joins → main-thread stall). Panes inside a
  // newly-active group join sequentially (focus first, rest staggered) via mountDelay.
  useEffect(() => {
    if (!isTerminalView || activeGroupId === undefined) return;
    markGroupMounted(activeGroupId);
  }, [isTerminalView, activeGroupId, markGroupMounted]);

  // Reflect unseen finished-terminal count (or active session name when idle) in browser tab title
  const activeSession = activeSessionId ? sessions.find((s) => s.id === activeSessionId) : null;
  const activeSessionName = activeSession ? (activeSession.name || t("terminal.defaultName")) : null;
  useEffect(() => { updateTitle(Object.keys(notifications).length, activeSessionName); return () => updateTitle(0); }, [notifications, activeSessionName]);

  // Enable slide animation only after settled in terminal view (avoids slide-through when entering from list)
  const [swipeAnimEnabled, setSwipeAnimEnabled] = useState(false);
  useEffect(() => {
    if (currentView.type !== "terminal") return setSwipeAnimEnabled(false);
    const id = requestAnimationFrame(() => setSwipeAnimEnabled(true));
    return () => cancelAnimationFrame(id);
  }, [currentView.type]);
  // Slide direction for mobile tab switch ("", "term-slide-left", "term-slide-right")
  const prevActiveRef = useRef(null);
  const [slideClass, setSlideClass] = useState("");
  useEffect(() => {
    const active = currentView.type === "terminal" ? currentView.sessionId : null;
    const prev = prevActiveRef.current;
    prevActiveRef.current = active;
    if (!swipeAnimEnabled || !active || !prev || active === prev) return setSlideClass("");
    const ids = openedSessions;
    setSlideClass(ids.indexOf(active) > ids.indexOf(prev) ? "term-slide-right" : "term-slide-left");
  }, [currentView, swipeAnimEnabled, openedSessions]);

  // Sync URL <-> viewStack (deep-link, F5, back/forward)
  useRouteSync(hydrated);

  // Pop view via browser history — history is the single source of truth, store
  // syncs from URL via useRouteSync. Fallback to storePopView for deep-links with
  // no prior entry.
  const popView = useCallback(() => {
    // Mobile: close editor overlay first (it's not in the viewStack) before navigating back
    if (!isDesktop && mobileEditor) { setMobileEditor(null); return; }
    if (typeof history !== "undefined" && history.length > 1) router.back();
    else storePopView();
  }, [router, storePopView, isDesktop, mobileEditor]);

  // Load sessions + groups when socket connects
  useEffect(() => {
    if (socket) {
      loadSessions();
      loadGroups();
    }
  }, [socket, loadSessions, loadGroups]);

  // Retry fetching sessions/groups once after 1s if still empty in terminal view
  // (guards against rare connect race where terminal:ready reply arrives too late)
  useEffect(() => {
    if (currentView.type !== "terminal") return;
    if (sessions.length || groups.length) return;
    const timer = setTimeout(() => { loadSessions(); loadGroups(); }, 1000);
    return () => clearTimeout(timer);
  }, [currentView.type, sessions.length, groups.length, loadSessions, loadGroups]);

  // Cleanup openedSessions - remove sessions that no longer exist
  // Delay to avoid race with newly-created sessions (server create → loadSessions is async)
  useEffect(() => {
    if (sessions.length === 0 || openedSessions.length === 0) return;
    const timer = setTimeout(() => {
      const validSessionIds = sessions.map(s => s.id);
      const invalidSessions = openedSessions.filter(sid => !validSessionIds.includes(sid));
      if (invalidSessions.length > 0) {
        invalidSessions.forEach(sid => removeOpenedSession(sid));
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [sessions, openedSessions, removeOpenedSession]);

  // VisualViewport height - handle mobile keyboard
  useEffect(() => {
    let lastKeyboardState = false;

    const updateAppHeight = () => {
      const vv = window.visualViewport;
      const vvHeight = vv?.height || window.innerHeight;
      const offsetTop = vv?.offsetTop || 0;
      const isKeyboardOpen = vvHeight < window.innerHeight - 100;

      if (lastKeyboardState !== isKeyboardOpen) {
        lastKeyboardState = isKeyboardOpen;
        setKeyboardOpen(isKeyboardOpen);
      }

      // Always follow visualViewport height so terminal fits exact visible area
      document.documentElement.style.setProperty("--app-height", `${vvHeight}px`);

      // iOS 26 Safari bug (FB20191055): offsetTop stays > 0 after keyboard dismiss
      if (!isKeyboardOpen && offsetTop > 0) {
        document.documentElement.style.transform = `translateY(${-offsetTop}px)`;
      } else {
        document.documentElement.style.transform = "";
      }
      window.scrollTo(0, 0);
    };

    document.documentElement.classList.add("terminal-page");

    let timerId = 0;
    const onResize = () => {
      clearTimeout(timerId);
      timerId = setTimeout(updateAppHeight, 100);
    };

    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", onResize);
      window.visualViewport.addEventListener("scroll", onResize);
    }
    window.addEventListener("resize", onResize);
    onResize();

    return () => {
      clearTimeout(timerId);
      document.documentElement.classList.remove("terminal-page");
      document.documentElement.style.transform = "";
      if (window.visualViewport) {
        window.visualViewport.removeEventListener("resize", onResize);
        window.visualViewport.removeEventListener("scroll", onResize);
      }
      window.removeEventListener("resize", onResize);
    };
  }, [setKeyboardOpen]);

  // Prevent body scroll on touchmove (allow scroll in specific containers)
  useEffect(() => {
    const preventScroll = (e) => {
      if (
        e.target.closest(".xterm-viewport") ||
        e.target.closest(".xterm-screen") ||
        e.target.closest(".terminal-scroll") ||
        e.target.closest(".cm-scroller") ||
        e.target.closest(".cm-content") ||
        e.target.closest(".overflow-auto") ||
        e.target.closest(".overflow-x-auto") ||
        e.target.closest(".overflow-y-auto") ||
        e.target.closest(".modal-scrollable")
      ) return;
      e.preventDefault();
    };
    document.addEventListener("touchmove", preventScroll, { passive: false });
    return () => document.removeEventListener("touchmove", preventScroll);
  }, []);

  // Prevent iOS auto-scroll pushing fixed layout when focusing inputs
  useEffect(() => {
    const handleFocusIn = (e) => {
      if (e.target.matches("input, textarea")) {
        requestAnimationFrame(() => window.scrollTo(0, 0));
      }
    };
    document.addEventListener("focusin", handleFocusIn);
    return () => document.removeEventListener("focusin", handleFocusIn);
  }, []);

  // Inherit cwd from the last session in the same group (null when none/ungrouped)
  const lastGroupCwd = useCallback((groupId) => {
    const groupSessions = sessions.filter((s) => (s.groupId || null) === groupId && s.cwd);
    return groupSessions.length ? groupSessions[groupSessions.length - 1].cwd : null;
  }, [sessions]);

  const handleCreateSession = useCallback((name, groupId = null, shellId = null) => {
    createSession(name, shellId, groupId, lastGroupCwd(groupId), (result) => {
      if (!result.success) {
        alert(t("workspace.failedCreateSession", { error: result.error }));
      } else if (result.sessionId) {
        addOpenedSession(result.sessionId);
        // Auto-select new terminal when created from within terminal view
        if (currentView.type === "terminal") {
          const newStack = [...viewStack];
          newStack[newStack.length - 1] = { type: "terminal", sessionId: result.sessionId };
          setViewStack(newStack);
        }
      }
    });
  }, [createSession, addOpenedSession, t, currentView, viewStack, setViewStack]);

  // Smooth-scroll focused pane to center of viewport (desktop split-view only)
  useEffect(() => {
    if (!isDesktop || currentView.type !== "terminal") return;
    const el = paneElementsRef.current[currentView.sessionId];
    if (!el) return;
    // Defer to next frame so layout is stable (e.g. after mount)
    const id = requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    });
    return () => cancelAnimationFrame(id);
  }, [isDesktop, currentView, openedSessions]);

  // Entering terminal view: open sessions of the selected session's group, set active group
  const handleSelectSession = useCallback((sessionId) => {
    const selected = sessions.find(s => s.id === sessionId);
    const groupId = selected?.groupId || null;
    setActiveGroupId(groupId);
    const groupIds = sessions.filter(s => (s.groupId || null) === groupId).map(s => s.id);
    groupIds.forEach(id => addOpenedSession(id));
    addOpenedSession(sessionId);
    touchLivePane([...groupIds, sessionId]); // Keep this group's panes alive (LRU)
    clearNotification?.(sessionId); // Clear badge on switching into a session (B)

    if (currentView.type === "terminal") {
      const newStack = [...viewStack];
      newStack[newStack.length - 1] = { type: "terminal", sessionId };
      setViewStack(newStack);
    } else {
      pushView({ type: "terminal", sessionId });
    }
  }, [sessions, addOpenedSession, touchLivePane, setActiveGroupId, currentView, viewStack, setViewStack, pushView, clearNotification]);

  // Deep-link from push notification tap (SW postMessage): open the right terminal
  useEffect(() => {
    const onMessage = (e) => {
      if (e.data?.type !== "NOTIFICATION_CLICK") return;
      const sid = new URLSearchParams(new URL(e.data.url || "", location.origin).search).get("t");
      if (sid) handleSelectSession(sid);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [handleSelectSession]);
  // Keep activeGroupId unchanged (new session belongs to it); don't call handleSelectSession
  // because the session isn't in `sessions` yet (loadSessions is async) → would reset group.
  // Tab/Shift+Tab in the PC input bar cycles sessions within the active group (wrap-round).
  const switchSession = useCallback((direction) => {
    const groupIds = sessions.filter((s) => (s.groupId || null) === activeGroupId).map((s) => s.id);
    if (groupIds.length < 2) return;
    const idx = groupIds.indexOf(activeSessionId);
    if (idx === -1) return;
    const next = direction === "prev"
      ? (idx - 1 + groupIds.length) % groupIds.length
      : (idx + 1) % groupIds.length;
    handleSelectSession(groupIds[next]);
  }, [sessions, activeGroupId, activeSessionId, handleSelectSession]);

  // Ctrl+1..9 in the PC input bar jumps to the Nth session in the active group.
  const switchToIndex = useCallback((i) => {
    const groupIds = sessions.filter((s) => (s.groupId || null) === activeGroupId).map((s) => s.id);
    if (i < 0 || i >= groupIds.length) return;
    handleSelectSession(groupIds[i]);
  }, [sessions, activeGroupId, handleSelectSession]);

  const handleQuickCreateSession = useCallback((shellId) => {
    createSession(null, shellId, activeGroupId, lastGroupCwd(activeGroupId), (result) => {
      if (!result.success) {
        alert(t("workspace.failedCreateSession", { error: result.error }));
        return;
      }
      if (result.sessionId) {
        addOpenedSession(result.sessionId);
        const newStack = [...viewStack];
        newStack[newStack.length - 1] = { type: "terminal", sessionId: result.sessionId };
        setViewStack(newStack);
      }
    });
  }, [createSession, activeGroupId, addOpenedSession, viewStack, setViewStack, t]);

  // Switch active group in terminal view — focus first session of that group
  const handleSelectGroup = useCallback((groupId) => {
    setActiveGroupId(groupId);
    const groupSessions = sessions.filter(s => (s.groupId || null) === groupId);
    groupSessions.forEach(s => addOpenedSession(s.id));
    touchLivePane(groupSessions.map(s => s.id)); // Keep this group's panes alive (LRU)
    const first = groupSessions[0];
    if (first) {
      const newStack = [...viewStack];
      newStack[newStack.length - 1] = { type: "terminal", sessionId: first.id };
      setViewStack(newStack);
    }
  }, [sessions, setActiveGroupId, addOpenedSession, touchLivePane, viewStack, setViewStack]);

  // Create session from FileExplorer bottom panel - stay in current view
  const handleCreateSessionInline = useCallback((onCreated) => {
    createSession(null, (result) => {
      if (!result.success) {
        alert(t("workspace.failedCreateSession", { error: result.error }));
        return;
      }
      if (result.sessionId) {
        addOpenedSession(result.sessionId);
        onCreated?.(result.sessionId);
      }
    });
  }, [createSession, addOpenedSession, t]);

  const handleDeleteSession = useCallback((sessionId) => {
    deleteSession(sessionId, () => {
      removeOpenedSession(sessionId);
    });
  }, [deleteSession, removeOpenedSession]);

  const handleRenameSession = useCallback((sessionId, newName) => {
    renameSession(sessionId, newName, (result) => {
      if (!result.success) {
        alert(t("workspace.failedRenameSession", { error: result.error }));
      }
    });
  }, [renameSession, t]);

  const handleOpenRemote = useCallback(() => {
    pushView({ type: "remote" });
  }, [pushView]);

  const handleOpenWorkspaceList = useCallback(async () => {
    // Fetch system info when opening workspaces view
    if (!systemInfo) {
      const info = await fileSocket.getSystemInfo();
      if (info.success) {
        setSystemInfo(info);
      }
    }
    pushView({ type: "workspaces" });
  }, [pushView, fileSocket, systemInfo]);

  const handleOpenFiles = useCallback(async () => {
    // From terminal: open explorer at the active terminal's cwd
    if (currentView.type === "terminal") {
      const cwd = currentView.sessionId ? cwdBySession[currentView.sessionId] : null;
      if (cwd) {
        addRecentWorkspace(cwd);
        pushView({ type: "files", workspace: cwd, currentPath: cwd });
        return;
      }
    }
    // Fallback: auto-open most recent workspace (restore last visited folder); else show list
    const recent = getRecentWorkspaces();
    if (recent.length > 0) {
      const last = recent[0];
      pushView({ type: "files", workspace: last.path, currentPath: last.lastPath || last.path });
      return;
    }
    handleOpenWorkspaceList();
  }, [pushView, handleOpenWorkspaceList, currentView, cwdBySession, addRecentWorkspace]);

  const handleSelectWorkspace = useCallback((workspacePath) => {
    addRecentWorkspace(workspacePath);
    // Replace any existing workspaces/files views in stack with fresh files view
    // so Back doesn't revisit old workspace or the selector
    const cleaned = viewStack.filter(v => v.type !== "workspaces" && v.type !== "files");
    setViewStack([...cleaned, { type: "files", workspace: workspacePath }]);
  }, [viewStack, setViewStack]);

  const handleBrowseFolder = useCallback((startPath) => {
    pushView({ type: "browse", path: startPath });
  }, [pushView]);

  const handlePathChange = useCallback((workspacePath, currentPath) => {
    // Persist last visited folder per workspace so next open restores it.
    // NOTE: do NOT patch viewStack here — FileExplorer's onPathChange fires on
    // every currentPath change (incl. agent-normalized paths), and writing it
    // back into the view triggers a re-mount loop. Folder is saved on file open
    // instead (handleOpenFile derives it from the file path).
    updateRecentWorkspacePath(workspacePath, currentPath);
  }, []);

  const handleOpenFile = useCallback((filePath, folderPath, opts = {}) => {
    // Mobile: render editor as an overlay above the current view (no viewStack push),
    // so the explorer/git panel stays mounted and Back (X) returns to it.
    if (!isDesktop) {
      setMobileEditor({ path: filePath, line: opts.line, column: opts.column, workspace: currentView.workspace });
      return;
    }
    // Desktop: open in-place via the workspace tabs (no viewStack push → no nested back).
    openFileRef.current?.(filePath, opts);
  }, [isDesktop, currentView.workspace]);

  const handleOpenGit = useCallback(() => {
    const filesView = viewStack.find(v => v.type === "files");
    if (filesView?.workspace) {
      pushView({ type: "git", workspace: filesView.workspace });
    }
  }, [pushView, viewStack]);

  const handleSetWorkspace = useCallback((workspacePath) => {
    // Replace browse/workspaces/files views with fresh files view
    // so Back doesn't revisit browse selector or old workspace
    addRecentWorkspace(workspacePath);
    const cleaned = viewStack.filter(v => v.type !== "browse" && v.type !== "workspaces" && v.type !== "files");
    setViewStack([...cleaned, { type: "files", workspace: workspacePath }]);
  }, [viewStack, setViewStack]);

  const handleOpenSite = useCallback((site) => {
    // Open local site in new tab via proxy
    if (site?.port) {
      const auth = getAuth();
      const proxyUrl = `${auth?.tunnelUrl}/proxy/${site.port}`;
      window.open(proxyUrl, "_blank");
    }
  }, [getAuth]);

  const handleDisconnect = useCallback(() => {
    resetStore();
    sessionStorage.clear();
    router.push("/login");
  }, [resetStore, router]);

  // Redirect to login when codespace is stopping
  useEffect(() => {
    if (codespaceStopping) {
      handleDisconnect();
    }
  }, [codespaceStopping, handleDisconnect]);

  // Logout with confirmation dialog
  const handleLogoutWithConfirm = useCallback(() => {
    setConfirmDialog({
      isOpen: true,
      title: t("workspace.logoutTitle"),
      message: t("workspace.logoutMessage"),
      onConfirm: handleDisconnect
    });
  }, [handleDisconnect, t]);

  const closeConfirmDialog = useCallback(() => {
    setConfirmDialog({ isOpen: false, title: "", message: "", onConfirm: null });
  }, []);

  // Only show loading on initial mount or hydration
  const auth = getAuth();
  // Persist current URL per-agent so switching agents restores the last view
  useLastRoute(auth?.apiKey);
  const isInitializing = !hydrated || (!socket && !auth?.tunnelUrl);

  if (isInitializing) {
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center">
        <div className="text-text-muted">{t("workspace.loading")}</div>
      </div>
    );
  }

  return (
    <>
      <AnimatedBackground />
      <div className="terminal-container h-[var(--app-height,100vh)] fixed inset-0 overflow-hidden overscroll-none">
        {/* Session List */}
        <div
          className={`absolute inset-0 transition-all duration-150 ease-out ${currentView.type === "list"
            ? "translate-x-0 opacity-100 z-10"
            : "-translate-x-full opacity-0 z-0 pointer-events-none"
            }`}
        >
          <SessionList
            sessions={sessions}
            connected={connected}
            onSelect={handleSelectSession}
            onCreate={handleCreateSession}
            onDelete={handleDeleteSession}
            onRename={handleRenameSession}
            onLogout={handleLogoutWithConfirm}
            onOpenRemote={connected && remoteAvailable && !codespaceInfo?.isCodespaces ? handleOpenRemote : null}
            onOpenFiles={handleOpenFiles}
            tunnelUrl={auth?.tunnelUrl}
            apiKey={auth?.apiKey}
            connectionMode={connectionMode}
            codespaceInfo={codespaceInfo}
            codespaceDisconnected={codespaceDisconnected}
            onStopCodespace={stopCodespace}
            onUpdate={handleUpdate}
            onRestart={handleRestart}
            retryStatus={retryStatus}
            isActive={currentView.type === "list"}
            socketRef={socketRef}
            subscribeToPush={subscribeToPush}
            unsubscribeFromPush={unsubscribeFromPush}
            notifications={notifications}
            sessionStatus={sessionStatus}
            clearNotification={clearNotification}
            agentVersion={agentVersion}
            updateAvailable={updateAvailable}
            canSelfUpdate={canSelfUpdate}
            transport={transport}
            groups={groups}
            onCreateGroup={createGroup}
            onRenameGroup={renameGroup}
            onDeleteGroup={deleteGroup}
            onMoveSession={moveSession}
            onReorderSession={reorderSession}
            shells={shells}
          />
        </div>

        {/* Terminal view: shared header + multi-pane layout */}
        {openedSessions.length > 0 && (() => {
          // Active-group panes drive tabs/visibility; LRU union stays mounted (no remount on group switch)
          const groupSessionIds = new Set(sessions.filter(s => (s.groupId || null) === activeGroupId).map(s => s.id));
          const groupOpenedSessions = openedSessions.filter(sid => groupSessionIds.has(sid));
          const liveSet = new Set([...groupOpenedSessions, ...livePanes.filter(sid => openedSessions.includes(sid))]);
          const renderedSessions = openedSessions.filter(sid => liveSet.has(sid));
          // sessionId → groupId lookup; pane mounts only if its group has been visited once
          // (active group auto-marks mounted on selection). Desktop keeps panes from other VISITED
          // groups mounted (split/LRU); mobile mounts ONLY the active group (one visible pane at a
          // time — keeping other groups alive wastes memory + joins). Switching tabs within a group
          // never remounts: panes stay mounted, only the focused one is shown.
          const sessionGroup = new Map(sessions.map(s => [s.id, s.groupId ?? null]));
          const mountedSet = new Set(openedSessions.filter(sid => {
            if (groupSessionIds.has(sid)) return true; // active group always mounts
            if (!isDesktop) return false; // mobile: don't keep other groups alive
            const gid = sessionGroup.get(sid);
            return !!mountedGroups[gid ?? "__ungrouped__"];
          }));
          // Sequential join within a freshly-active group: focus first (0ms), then stagger the rest
          // (~120ms each) so concurrent joins don't pile up and stall the main thread.
          const STAGGER_MS = 120;
          const groupOrder = groupOpenedSessions; // order within active group (tab order)
          const groupIndex = new Map(groupOrder.map((sid, i) => [sid, i]));
          return (
            <div
              className={`absolute inset-0 flex flex-col ${isTerminalView ? "translate-x-0 opacity-100 z-10" : "translate-x-full opacity-0 z-0 pointer-events-none"
                }`}
            >
              <TerminalHeader
                sessions={sessions.filter(s => (s.groupId || null) === activeGroupId)}
                allSessions={sessions}
                activeSessionId={activeSessionId}
                isActive={isTerminalView}
                connected={connected}
                notifications={notifications}
            sessionStatus={sessionStatus}
                onSwitchSession={handleSelectSession}
                onCreateSession={handleQuickCreateSession}
                onRenameSession={handleRenameSession}
                onDeleteSession={handleDeleteSession}
                onCreateNamedSession={handleCreateSession}
                onBack={popView}
                groups={groups}
                activeGroupId={activeGroupId}
                onSelectGroup={handleSelectGroup}
                hasUngrouped={sessions.some(s => !s.groupId)}
                onOpenRemote={connected && remoteAvailable && !codespaceInfo?.isCodespaces ? handleOpenRemote : null}
                onOpenFiles={handleOpenFiles}
                onLogout={handleLogoutWithConfirm}
                onStopCodespace={stopCodespace}
                onUpdate={handleUpdate}
                onRestart={handleRestart}
                codespaceInfo={codespaceInfo}
                tunnelUrl={auth?.tunnelUrl}
                apiKey={auth?.apiKey}
                connectionMode={connectionMode}
                subscribeToPush={subscribeToPush}
                unsubscribeFromPush={unsubscribeFromPush}
                agentVersion={agentVersion}
                socketRef={socketRef}
                transport={transport}
                shells={shells}
              />

              {/* Panes container: desktop = horizontal scroll split, mobile = overlay active pane */}
              <div
                ref={panesContainerRef}
                className={`flex-1 min-h-0 ${isDesktop ? "flex flex-row gap-2 overflow-x-auto overflow-y-hidden px-2 pb-14" : "relative"}`}
                {...bindSwipeTab({
                  enabled: !isDesktop,
                  sessionIds: groupOpenedSessions,
                  activeSessionId,
                  onSwitch: handleSelectSession
                })}
              >
                {renderedSessions.map((sessionId) => {
                  const inActiveGroup = groupSessionIds.has(sessionId);
                  const isFocused = sessionId === activeSessionId;
                  const isVisible = inActiveGroup && (isDesktop || isFocused);
                  // Panes outside active group stay mounted (LRU) but fully hidden
                  return (
                    <div
                      key={sessionId}
                      ref={(el) => registerPaneElement(sessionId, el)}
                      className={
                        !inActiveGroup
                          ? "hidden"
                          : isDesktop
                          ? `flex-1 h-full rounded-xl overflow-hidden ${(() => {
                              if (isFocused) return "p-0 border-2 border-brand-500";
                              const st = sessionStatus[sessionId]?.state || "idle";
                              if (st === "working") return "p-px border border-dashed status-border-working";
                              if (st === "blocked") return "p-px border border-dashed status-border-blocked";
                              if (st === "done") return "p-px border border-dashed status-border-done";
                              return "p-px border border-text-muted/25";
                            })()}`
                          : `absolute inset-0 ${isFocused ? `opacity-100 z-10 ${slideClass}` : "opacity-0 z-0 pointer-events-none"}`
                      }
                      style={inActiveGroup && isDesktop ? { minWidth: `${PANE_MIN_WIDTH}px` } : undefined}
                    >
                      {mountedSet.has(sessionId) ? (
                        <TerminalPane
                          socket={socket}
                          connected={connected}
                          sessionId={sessionId}
                          isVisible={isVisible}
                          isFocused={isFocused}
                          onActivate={handleSelectSession}
                          onRegisterApi={registerPaneApi}
                          onPasteFallback={handlePasteFallback}
                          showFocusBorder={false}
                          notifications={notifications}
                          sessionStatus={sessionStatus}
                          clearNotification={clearNotification}
                          fileSocket={fileSocket}
                          mountDelay={(() => {
                            // Focus pane joins immediately; other panes in the freshly-active group
                            // stagger by tab order so joins don't pile up. Panes already alive
                            // (revisit) pass 0 — no delay, their PTY is already running.
                            if (!isFocused && groupIndex.has(sessionId)) return groupIndex.get(sessionId) * STAGGER_MS;
                            return 0;
                          })()}
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-text-muted text-xs">
                          {/* Placeholder — group not yet visited; mount on first entry */}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Ghost inputs — one per inactive desktop pane, aligned with the real overlay input.
                  Click switches the tab and focuses the shared MobileKeyboard. */}
              {isDesktop && ghostRects.map(({ sessionId, left, width }) => (
                <button
                  key={`ghost-${sessionId}`}
                  type="button"
                  tabIndex={-1}
                  onClick={() => {
                    handleSelectSession(sessionId);
                    setTimeout(() => keyboardTextApiRef.current?.focus?.(), 60);
                  }}
                  className="group absolute bottom-0 z-10 px-2 py-2 hover:z-20"
                  style={{ left: `${left}px`, width: `${width}px` }}
                  aria-label="Focus this terminal input"
                >
                  <span className="block w-full text-left text-sm text-text-muted/60 rounded-xl bg-surface-2/40 border border-dashed border-border/50 px-3 py-2 group-hover:border-brand-500/60 group-hover:bg-surface-2/70 group-hover:text-text-muted transition-colors">
                    {t("mobileKeyboard.typeCommand")}
                  </span>
                </button>
              ))}

              {/* Shared MobileKeyboard - routes to focused pane.
                  Desktop: overlays the panes (absolute) so its height changes never resize
                  the terminal above; width + left offset match the focused pane. Mobile: full width. */}
              {activeSessionId && (
                <div
                  className={isDesktop ? "absolute left-0 right-0 bottom-0 z-20" : ""}
                  style={isDesktop && focusPaneRect
                    ? { width: `${focusPaneRect.width}px`, marginLeft: `${focusPaneRect.left}px` }
                    : undefined}
                >
                <MobileKeyboard
                  socket={socket}
                  sessionId={activeSessionId}
                  onExpandChange={() => {
                    // Desktop: overlay now — terminal no longer resizes; nothing to refit.
                  }}
                  onRefocus={() => paneApisRef.current[activeSessionId]?.focus?.()}
                  onRegisterTextApi={registerKeyboardTextApi}
                  platform={platform}
                  onInput={clearNotification}
                  onSwitchSession={switchSession}
                  onSwitchToIndex={switchToIndex}
                />
                </div>
              )}
            </div>
          );
        })()}

        {/* Remote Desktop - conditional render */}
        {currentView.type === "remote" && (
          <div className="absolute inset-0 z-20 transition-all duration-300 ease-out animate-in slide-in-from-right">
            <RemoteDesktop onClose={popView} socketRef={socketRef} protocolRef={protocolRef} connected={connected} connectionMode={connectionMode} transport={transport} hostPlatform={platform} />
          </div>
        )}

        {/* Workspace List */}
        {currentView.type === "workspaces" && (
          <div className="absolute inset-0 z-20 transition-all duration-300 ease-out animate-in slide-in-from-bottom">
            <WorkspaceList
              onSelect={handleSelectWorkspace}
              onBrowse={handleBrowseFolder}
              onBack={popView}
              isCodespaces={codespaceInfo?.isCodespaces}
              systemInfo={systemInfo}
            />
          </div>
        )}

        {/* Browse Folder (selecting workspace) */}
        {currentView.type === "browse" && (
          <div className="absolute inset-0 z-20 transition-all duration-300 ease-out animate-in slide-in-from-bottom">
            <FileExplorer
              workspace={currentView.path}
              fileSocket={fileSocket}
              onBack={popView}
              onSetWorkspace={handleSetWorkspace}
              isBrowsing={true}
            />
          </div>
        )}

        {/* Desktop VSCode-like layout: replaces files/editor/git when wide screen */}
        {isDesktop && (currentView.type === "files" || currentView.type === "editor" || currentView.type === "git") && (() => {
          // files view = currentView when opening explorer; for editor/git, fall back to the
          // most recently pushed files view (last in stack, not first — stale files views may
          // linger after group switches that only replace the top view).
          const filesView = currentView.type === "files"
            ? currentView
            : [...viewStack].reverse().find(v => v.type === "files");
          const ws = filesView?.workspace || currentView.workspace;
          const recentInitial = (() => {
            const all = getRecentWorkspaces();
            return all.find(w => w.path === ws)?.openedFiles || [];
          })();
          const recentActive = (() => {
            const all = getRecentWorkspaces();
            return all.find(w => w.path === ws)?.activeFile || null;
          })();
          return (
            <div className="absolute inset-0 z-20 transition-all duration-300 ease-out animate-in slide-in-from-bottom">
              <FileWorkspaceDesktop
                workspace={ws}
                fileSocket={fileSocket}
                onBack={popView}
                onSwitchWorkspace={handleOpenWorkspaceList}
                initialOpenedFiles={recentInitial}
                initialActiveFile={recentActive}
                onOpenedFilesChange={(files, activeFile) => updateOpenedFiles(ws, files, activeFile)}
                socket={socket}
                connected={connected}
                sessions={sessions}
                onCreateTerminalSession={handleCreateSessionInline}
                onDeleteTerminalSession={handleDeleteSession}
                onRenameTerminalSession={handleRenameSession}
                viewType={currentView.type}
                openFileRef={openFileRef}
              />
            </div>
          );
        })()}

        {/* File Explorer (workspace mode) - mobile only. */}
        {!isDesktop && currentView.type === "files" && (
          <div className="absolute inset-0 z-20 transition-all duration-300 ease-out animate-in slide-in-from-bottom">
            <FileExplorer
              workspace={currentView.workspace}
              initialPath={currentView.currentPath}
              fileSocket={fileSocket}
              onBack={popView}
              onOpenFile={handleOpenFile}
              onOpenGit={handleOpenGit}
              onSwitchWorkspace={handleOpenWorkspaceList}
              onPathChange={(p) => handlePathChange(currentView.workspace, p)}
              hideSwitchWorkspace={currentView.fromTerminal}
            />
          </div>
        )}

        {/* Git Panel - mobile only */}
        {!isDesktop && currentView.type === "git" && (
          <div className="absolute inset-0 z-30 transition-all duration-300 ease-out animate-in slide-in-from-right">
            <GitPanel
              workspace={currentView.workspace}
              fileSocket={fileSocket}
              onBack={popView}
              onOpenFile={handleOpenFile}
            />
          </div>
        )}

        {/* Mobile editor overlay — rendered above whichever view opened it (files or git),
            so Back (X) returns to that view without a viewStack push. */}
        {!isDesktop && mobileEditor && (
          <div className="absolute inset-0 z-40 transition-all duration-300 ease-out animate-in slide-in-from-right">
            <FileEditor
              filePath={mobileEditor.path}
              line={mobileEditor.line}
              column={mobileEditor.column}
              fileSocket={fileSocket}
              onBack={() => setMobileEditor(null)}
              workspace={mobileEditor.workspace || currentView.workspace}
            />
          </div>
        )}

        {/* Connection Modal - overlay when retrying/failed (suppressed during self-update) */}
        {!updating && <ConnectionModal retryStatus={retryStatus} approvalStatus={approvalStatus} onLogout={handleDisconnect} />}

        {/* Update Modal - progress overlay during agent self-update */}
        <UpdateModal open={updating} connected={connected} mode={updateMode} />

        {/* Global Slide Menu - single instance at page level */}
        <SlideMenu />

        {/* Confirm Dialog - page level for logout confirmation */}
        <ConfirmDialog
          isOpen={confirmDialog.isOpen}
          onClose={closeConfirmDialog}
          onConfirm={confirmDialog.onConfirm}
          title={confirmDialog.title}
          message={confirmDialog.message}
        />
      </div>
      {/* Child routes are URL markers only (render nothing) */}
      <div hidden>{children}</div>
    </>
  );
}
