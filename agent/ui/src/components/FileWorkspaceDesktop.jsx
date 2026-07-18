import { useState, useCallback, useEffect, useRef } from "preact/hooks";
import ActivityBar from "./ActivityBar";
import SidebarPanel from "./SidebarPanel";
import EditorArea from "./EditorArea";
import StatusBar from "./StatusBar";
import CommandPalette from "./CommandPalette";
import BottomPanel from "./BottomPanel";
import { usePersistedState } from "../lib/usePersistedState";
import { useFileExplorerShortcuts } from "../lib/fileExplorer/useFileExplorerShortcuts";
import {
  ACTIVITY_PANELS,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  BOTTOM_PANEL_DEFAULT_HEIGHT,
  STORAGE_KEYS,
  MAX_OPEN_TABS,
} from "../lib/fileExplorer/constants";

// Desktop VSCode-like layout: ActivityBar | Sidebar | EditorArea + StatusBar.
// Ported from web; uses usePersistedState + useFileExplorerShortcuts (Preact).
export default function FileWorkspaceDesktop({ workspace, fileSocket, onBack, socket, connected, sessions, onCreateTerminalSession, onDeleteTerminalSession, onRenameTerminalSession, initialPanel }) {
  const [activePanel, setActivePanel] = usePersistedState(STORAGE_KEYS.activityPanel, initialPanel || ACTIVITY_PANELS.explorer);
  const [sidebarVisible, setSidebarVisible] = usePersistedState(STORAGE_KEYS.sidebarVisible, true);
  const [sidebarWidth, setSidebarWidth] = usePersistedState(STORAGE_KEYS.sidebarWidth, SIDEBAR_DEFAULT_WIDTH);
  const [bottomVisible, setBottomVisible] = usePersistedState(STORAGE_KEYS.bottomPanelVisible, false);
  const [bottomHeight, setBottomHeight] = usePersistedState(STORAGE_KEYS.bottomPanelHeight, BOTTOM_PANEL_DEFAULT_HEIGHT);
  const containerRef = useRef(null);

  const startResize = useCallback((e) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const onMove = (ev) => {
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      const clamped = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, pct));
      setSidebarWidth(clamped);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [setSidebarWidth]);

  const [openedFiles, setOpenedFiles] = useState([]);
  const [activeFile, setActiveFile] = useState(null);
  const [editorState, setEditorState] = useState({ line: 1, column: 1, language: "", encoding: "UTF-8" });
  const [gitBranch, setGitBranch] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteMode, setPaletteMode] = useState("commands");

  const handleOpenFile = useCallback((filePath) => {
    // Newest at head (LRU); cap at MAX_OPEN_TABS, evicting oldest from the tail
    setOpenedFiles((prev) => [filePath, ...prev.filter((p) => p !== filePath)].slice(0, MAX_OPEN_TABS));
    setActiveFile(filePath);
  }, []);

  const handleCloseFile = useCallback((filePath) => {
    setOpenedFiles((prev) => {
      const next = prev.filter((p) => p !== filePath);
      if (activeFile === filePath) setActiveFile(next[0] || null);
      return next;
    });
  }, [activeFile]);

  const handleCloseOthers = useCallback((filePath) => {
    setOpenedFiles([filePath]);
    setActiveFile(filePath);
  }, []);

  const handleCloseAll = useCallback(() => {
    setOpenedFiles([]);
    setActiveFile(null);
  }, []);

  useEffect(() => {
    if (!workspace || !fileSocket) return;
    fileSocket.gitBranch?.(workspace).then((r) => { if (r?.success) setGitBranch(r.branch || ""); }).catch(() => {});
  }, [workspace, fileSocket]);

  useFileExplorerShortcuts({
    onToggleSidebar: () => setSidebarVisible((v) => !v),
    onTogglePanel: () => setBottomVisible((v) => !v),
    onSave: () => { if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("fileExplorer:save")); },
    onCloseTab: () => activeFile && handleCloseFile(activeFile),
    onCommandPalette: () => { setPaletteMode("commands"); setPaletteOpen(true); },
    onQuickOpen: () => { setPaletteMode("files"); setPaletteOpen(true); },
  });

  return (
    <div className="h-full flex flex-col" style={{ background: "var(--bg-body)" }}>
      <div className="flex-1 min-h-0 flex">
        <ActivityBar
          activePanel={activePanel}
          onSelectPanel={(p) => {
            if (activePanel === p && sidebarVisible) setSidebarVisible(false);
            else { setActivePanel(p); setSidebarVisible(true); }
          }}
          onBack={onBack}
        />

        <div ref={containerRef} className="flex-1 min-w-0 min-h-0 flex relative">
          {sidebarVisible && (
            <>
              <div className="bg-surface flex-shrink-0 overflow-hidden min-h-0 flex flex-col" style={{ width: `${sidebarWidth}%` }}>
                <SidebarPanel
                  activePanel={activePanel}
                  workspace={workspace}
                  fileSocket={fileSocket}
                  onOpenFile={handleOpenFile}
                  activeFile={activeFile}
                />
              </div>
              <div
                onMouseDown={startResize}
                className="w-1 cursor-col-resize bg-border hover:bg-brand-500/50 transition-colors flex-shrink-0"
              />
            </>
          )}
          <div className="flex-1 min-w-0 min-h-0 flex flex-col">
            <EditorArea
              workspace={workspace}
              fileSocket={fileSocket}
              openedFiles={openedFiles}
              activeFile={activeFile}
              onActivateFile={setActiveFile}
              onCloseFile={handleCloseFile}
              onCloseOthers={handleCloseOthers}
              onCloseAll={handleCloseAll}
              onOpenFile={handleOpenFile}
              onEditorStateChange={setEditorState}
            />
            {bottomVisible && socket && (
              <BottomPanel
                height={bottomHeight}
                onResize={setBottomHeight}
                onClose={() => setBottomVisible(false)}
                socket={socket}
                connected={connected}
                sessions={sessions}
                onCreateSession={onCreateTerminalSession}
                onDeleteSession={onDeleteTerminalSession}
                onRenameSession={onRenameTerminalSession}
              />
            )}
          </div>
        </div>
      </div>

      <StatusBar
        gitBranch={gitBranch}
        line={editorState.line}
        column={editorState.column}
        language={editorState.language}
        encoding={editorState.encoding}
        activeFile={activeFile}
        sidebarVisible={sidebarVisible}
        onToggleSidebar={() => setSidebarVisible((v) => !v)}
        bottomVisible={bottomVisible}
        onTogglePanel={() => setBottomVisible((v) => !v)}
      />

      {paletteOpen && (
        <CommandPalette
          mode={paletteMode}
          workspace={workspace}
          fileSocket={fileSocket}
          onClose={() => setPaletteOpen(false)}
          onOpenFile={handleOpenFile}
          onSetMode={setPaletteMode}
          onAction={(actionId) => {
            setPaletteOpen(false);
            if (actionId === "toggleSidebar") setSidebarVisible((v) => !v);
            else if (actionId === "togglePanel") setBottomVisible((v) => !v);
            else if (actionId === "closeAll") handleCloseAll();
            else if (actionId === "openExplorer") { setActivePanel(ACTIVITY_PANELS.explorer); setSidebarVisible(true); }
            else if (actionId === "openSearch") { setActivePanel(ACTIVITY_PANELS.search); setSidebarVisible(true); }
            else if (actionId === "openScm") { setActivePanel(ACTIVITY_PANELS.scm); setSidebarVisible(true); }
            else if (actionId === "openSettings") { setActivePanel(ACTIVITY_PANELS.settings); setSidebarVisible(true); }
          }}
        />
      )}
    </div>
  );
}
