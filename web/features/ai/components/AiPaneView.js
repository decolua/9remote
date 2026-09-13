"use client";

import { memo, useState, useCallback, useMemo } from "react";
import { useAiSession } from "../hooks/useAiSession";
import { useAiStore } from "@/shared/stores/aiStore";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { useTheme } from "@/shared/theme/ThemeProvider";
import { useI18n } from "@/shared/i18n";
import { RefreshCw, Folder, ListChecks, Sparkles } from "@/shared/components/ui/Icon";
import { AiMessagesList } from "./AiMessagesList";
import { Composer } from "./Composer";
import { AiStatusBar } from "./AiStatusBar";
import { SkillsModal } from "./modals/SkillsModal";
import { McpModal } from "./modals/McpModal";
import { ModelModal } from "./modals/ModelModal";
import { SessionsModal } from "./modals/SessionsModal";
import { ConfigModal } from "./modals/ConfigModal";
import { ModeModal } from "./modals/ModeModal";
import { DoctorModal } from "./modals/DoctorModal";
import { TasksModal } from "./modals/TasksModal";
import { RewindModal } from "./modals/RewindModal";
import { AiPermissionCard } from "./cards/AiPermissionCard";
import { AiBlockedCard } from "./cards/AiBlockedCard";
import { AiQuestionCard } from "./cards/AiQuestionCard";
import { AiTaskCard } from "./cards/AiTaskCard";
import { getEngineConfig } from "../registry";
import { AI_FONT_SIZE_BOOST, AI_DOT_GRID, ENGINE_INFO } from "../constants";
import { useConnectionStore } from "@/shared/stores/connectionStore";
import { useNotificationStore } from "@/shared/stores/notificationStore";
import { dotClassName, statusVisual } from "@/shared/utils/statusVisual";
import { STATUS_BAR_HEIGHT } from "@/shared/constants/layout";
import PaneStripButtons from "@/features/terminal/components/PaneStripButtons";
import NotePanel from "@/features/terminal/components/NotePanel";
import { OVERLAY_BTN_CLS, OVERLAY_ICON_SM } from "@/features/terminal/components/TerminalPane";
import { useGitChangedCount } from "@/features/terminal/hooks/useGitChangedCount";
import { vibrate } from "@/shared/utils/vibration";
import {
  backgroundSrc,
  paneBackgroundKey,
  resolvableBackgroundKeys,
  effectiveFontSize,
  MAX_CHANGED_BADGE,
  DESKTOP_BREAKPOINT,
  TERMINAL_BG_ALPHA,
  TERMINAL_BG_VEIL_RGB,
  TERMINAL_BG_LIFT_RGB,
  TERMINAL_BG_LIFT
} from "@/features/terminal/constants/terminalConfig";
import { resolveTerminalTheme } from "@/shared/theme/themeConfig";

const DEFAULT_METADATA = { model: "", skills: [], mcpServers: [] };
const EMPTY_TASKS = [];

export const AiPaneView = memo(function AiPaneView({
  sessionId,
  engine = "claude",
  workspacePath = "",
  sessionName = "",
  bus = null,
  fileBus = null,
  isFocused = false,
  isDesktop = true,
  bgIndex = 0,
  onActivate = null,
  onOpenRemote = null,
  onOpenMobile = null,
  onOpenArtifact = null
}) {
  const [activeModal, setActiveModal] = useState(null); // 'skills' | 'mcp' | 'model'
  const [refreshing, setRefreshing] = useState(false);
  const [noteModalOpen, setNoteModalOpen] = useState(false);
  const { t } = useI18n();

  const { sendPrompt, resolvePermission, stop, runShell, rewindToMessage, previewRewind, listRewindPoints, escalateMode, dismissBlocked, hasOlder, loadOlder, reload, hydrating } = useAiSession({
    sessionId,
    engine,
    workspacePath,
    bus
  });

  // Manual re-pull of the host log. The turn ends up wherever the host says it is,
  // which is the point: a client that missed events shows the truth again.
  const handleRefresh = useCallback(() => {
    vibrate();
    setRefreshing(true);
    reload();
    // The round-trip has no ack to the caller, so the spinner is a fixed beat —
    // same as the terminal pane's own refresh button.
    setTimeout(() => setRefreshing(false), 700);
  }, [reload]);

  const activePermission = useAiStore((s) => s.bySession[sessionId]?.activePermission);
  const activeBlocked = useAiStore((s) => s.bySession[sessionId]?.activeBlocked);
  const metadata = useAiStore((s) => s.bySession[sessionId]?.metadata) || DEFAULT_METADATA;
  const tasks = useAiStore((s) => s.bySession[sessionId]?.tasks) || EMPTY_TASKS;
  const clearMessages = useAiStore((s) => s.clearMessages);
  const setPermissionMode = useAiStore((s) => s.setPermissionMode);

  const sessionState = useNotificationStore((s) => (sessionId ? s.sessionStatus[sessionId]?.state : null)) || "idle";

  const terminalBackgroundOpacity = useTerminalStore((s) => s.terminalBackgroundOpacity);
  const customBackgrounds = useTerminalStore((s) => s.customBackgrounds);
  const terminalBackgrounds = useTerminalStore((s) => s.terminalBackgrounds);
  const terminalTheme = useTerminalStore((s) => s.terminalTheme);
  const fontSize = useTerminalStore((s) => s.fontSize);
  const showFolderButton = useTerminalStore((s) => s.showFolderButton);
  const showNoteButton = useTerminalStore((s) => s.showNoteButton);
  const setRightPanelRoot = useTerminalStore((s) => s.setRightPanelRoot);
  const setRightPanelTab = useTerminalStore((s) => s.setRightPanelTab);
  const openRightPanel = useTerminalStore((s) => s.openRightPanel);
  // What the AI showed from this chat, newest first — same stack the terminal pane reads.
  const artifacts = useTerminalStore((s) => s.artifactsBySession[sessionId]);
  // One poll per workspace path, shared with any terminal standing in the same one.
  const changedCount = useGitChangedCount(workspacePath, fileBus, { enabled: isFocused && showFolderButton });
  const { theme } = useTheme();

  // Chat text is plain prose, not terminal output — take only fg/bg from the
  // terminal palette so a theme switch keeps the two panes in step. Surfaces stay
  // on the app theme; the theme menu only offers palettes of the current mode.
  const palette = useMemo(() => resolveTerminalTheme(theme, terminalTheme), [theme, terminalTheme]);
  const fontPx = useMemo(() => effectiveFontSize(fontSize) + AI_FONT_SIZE_BOOST, [fontSize]);

  // Background styling: a picked terminal wallpaper wins over the palette colour,
  // mirroring TerminalPane — including its dark-mode-only rule, since the veil is
  // tuned for a dark ground. The dot grid sits on top either way.
  const bgStyle = useMemo(() => {
    const { alpha, size } = AI_DOT_GRID;
    const dotGrid = `radial-gradient(color-mix(in srgb, ${palette.foreground} ${alpha}%, transparent) 1px, transparent 1px) 0 0 / ${size}px ${size}px`;
    const paneBgKey = paneBackgroundKey(resolvableBackgroundKeys(terminalBackgrounds, customBackgrounds), bgIndex);
    const bgSrc = theme === "dark" ? backgroundSrc(paneBgKey, customBackgrounds) : null;
    if (bgSrc) {
      const veil = `rgba(${TERMINAL_BG_VEIL_RGB},${terminalBackgroundOpacity ?? TERMINAL_BG_ALPHA})`;
      const lift = `rgba(${TERMINAL_BG_LIFT_RGB},${TERMINAL_BG_LIFT})`;
      return {
        background: `${dotGrid}, linear-gradient(${veil},${veil}), linear-gradient(${lift},${lift}), center / cover no-repeat url("${bgSrc}")`,
        backgroundBlendMode: "luminosity, normal, screen, normal"
      };
    }
    return { background: `${dotGrid}, ${palette.background}` };
  }, [terminalBackgrounds, customBackgrounds, terminalBackgroundOpacity, palette, theme, bgIndex]);

  const skills = metadata.skills || [];
  const mcpServers = metadata.mcpServers || [];

  const handleClear = useCallback(() => {
    vibrate();
    clearMessages(sessionId);
    // Force: /clear resets on the host and must work while a turn is streaming.
    sendPrompt("/clear", { force: true });
  }, [clearMessages, sessionId, sendPrompt]);

  const handleSelectSkill = useCallback((skillName) => {
    sendPrompt(`/${skillName}`);
  }, [sendPrompt]);

  // Session options (model / effort / resume / flags) all travel over the bus. The
  // prop is not always supplied, so fall back to the connection store the same way
  // useAiSession does — otherwise the modal opens but picking an entry does nothing.
  const emitOptions = useCallback((options) => {
    const b = bus?.emit ? bus : useConnectionStore.getState().bus;
    b?.emit?.("ai:options", { sessionId, options });
  }, [bus, sessionId]);

  // Model is a session option, not a chat message: it must go through ai:options so
  // the host applies it to the CLI (a `/model x` prompt would just be sent as text).
  const handleSelectModel = useCallback((modelId) => {
    emitOptions({ model: modelId });
  }, [emitOptions]);

  // Resume a past conversation: hand the CLI the thread/session id it should
  // continue. The host applies it and rebuilds the adapter.
  const handleResumeSession = useCallback((row) => {
    if (!row?.sessionId) return;
    emitOptions({ resume: row.sessionId });
  }, [emitOptions]);

  // The empty state's history rows resume in place; its "all conversations" link
  // (no row) opens the full picker instead.
  const handleOpenResume = useCallback((row) => {
    if (row) return handleResumeSession(row);
    setActiveModal("sessions");
  }, [handleResumeSession]);

  // Apply a submenu value (effort, variant, sandbox) to the running session.
  const handleOptionChange = useCallback((key, value) => {
    if (!key) return;
    emitOptions({ [key]: value });
  }, [emitOptions]);

  const engineConfig = getEngineConfig(engine);

  // Switching mode — from the status-bar menu, Shift+Tab, the `/plan` command or the
  // permissions modal. The store is updated first so the status bar reflects the pick
  // without waiting for the host round-trip.
  const handleModeChange = useCallback((mode) => {
    setPermissionMode(sessionId, mode);
    emitOptions({ mode });
  }, [emitOptions, sessionId, setPermissionMode]);

  // Container-level fallback for Shift+Tab when focused outside composer
  const handleKeyDown = useCallback((e) => {
    if (activeModal) return;
    if (e.shiftKey && e.key === "Tab") {
      e.preventDefault();
      vibrate();
      const modes = engineConfig.permissionModes || [];
      const currentMode = useAiStore.getState().bySession[sessionId]?.permissionMode || engineConfig.defaultMode;
      const currentIdx = modes.findIndex((m) => m.id === currentMode);
      const nextIdx = currentIdx === -1 ? 0 : (currentIdx + 1) % modes.length;
      const nextMode = modes[nextIdx]?.id;
      if (nextMode) handleModeChange(nextMode);
    }
  }, [sessionId, engineConfig, handleModeChange, activeModal]);

  return (
    <div
      onMouseDown={() => { if (!isFocused) onActivate?.(); }}
      onKeyDown={handleKeyDown}
      className="ai-pane w-full h-full flex flex-col bg-bg overflow-hidden relative select-text"
      style={{
        ...bgStyle,
        // Palette text colour wins over the app theme's for the whole pane
        "--color-text": palette.foreground,
        "--ai-fs": `${fontPx}px`
      }}
    >
      {/* Title bar — the pane names itself and carries the buttons the header keeps
          desktop-only (Remote/Mobile/Sites), so a phone has a way in. */}
      <div
        style={{ height: STATUS_BAR_HEIGHT }}
        className="flex items-center gap-2 px-2 border-b border-border-subtle bg-surface text-[11px] select-none shrink-0 relative z-10"
      >
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dotClassName(sessionState)}`} style={{ background: statusVisual(sessionState).dot }} />
        <span className="flex-1 min-w-0 truncate text-text">{sessionName || ENGINE_INFO[engine]?.label || engine}</span>
        <PaneStripButtons onOpenRemote={onOpenRemote} onOpenMobile={onOpenMobile} />
      </div>

      {/* Same floating cluster, same order, as a terminal pane's — a chat is the other
          way to sit in a workspace, so the two panes must not drift apart. */}
      {isFocused && (
        <div className="absolute right-2 top-8 z-10 flex flex-col items-end gap-2 pointer-events-auto touch-none">
          <div className="flex flex-row gap-2">
            {showNoteButton && (
              <button
                onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
                onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
                onClick={(e) => { e.stopPropagation(); vibrate(); setNoteModalOpen(true); }}
                className={OVERLAY_BTN_CLS}
                title={t("terminalPane.note")}
              >
                <ListChecks size={16} className={OVERLAY_ICON_SM} />
              </button>
            )}
            <button
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onClick={(e) => { e.stopPropagation(); handleRefresh(); }}
              className={OVERLAY_BTN_CLS}
              title={t("terminalPane.refresh")}
            >
              <RefreshCw size={16} className={`${OVERLAY_ICON_SM} ${refreshing ? "animate-spin" : ""}`} />
            </button>
          </div>
          {showFolderButton && workspacePath && (
            <button
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onClick={(e) => {
                e.stopPropagation(); vibrate();
                setRightPanelRoot(workspacePath, workspacePath);
                // Desktop jumps to files; mobile keeps the workspace's saved tab
                if (window.innerWidth >= DESKTOP_BREAKPOINT) setRightPanelTab("files", workspacePath);
                else openRightPanel();
              }}
              className={`relative ${OVERLAY_BTN_CLS}`}
              title={t("terminalPane.openFolderHere")}
            >
              <Folder size={16} className={OVERLAY_ICON_SM} />
              {changedCount > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 flex items-center justify-center text-[10px] font-semibold text-white bg-brand-500 rounded-full">
                  {changedCount > MAX_CHANGED_BADGE ? `${MAX_CHANGED_BADGE}+` : changedCount}
                </span>
              )}
            </button>
          )}
          {/* Reopen what this chat showed. Hiding the app closes the panel but not the
              stack, so this is the way back to it. */}
          {onOpenArtifact && artifacts?.length > 0 && (
            <button
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onTouchStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onClick={(e) => { e.stopPropagation(); vibrate(); onOpenArtifact(sessionId, artifacts[0]); }}
              className={`relative ${OVERLAY_BTN_CLS}`}
              title={t("terminalPane.artifacts")}
            >
              <Sparkles size={16} className={OVERLAY_ICON_SM} />
              <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 flex items-center justify-center text-[10px] font-semibold text-white bg-brand-500 rounded-full">
                {artifacts.length}
              </span>
            </button>
          )}
        </div>
      )}

      {/* Pinned Task Checklist Strip at the Top */}
      <AiTaskCard sessionId={sessionId} />

      {/* Scrollable Message List */}
      <AiMessagesList
        sessionId={sessionId}
        engine={engine}
        workspacePath={workspacePath}
        fileBus={fileBus}
        onSendPrompt={sendPrompt}
        onResolvePermission={resolvePermission}
        onRewind={rewindToMessage}
        onPreviewRewind={previewRewind}
        onListRewindPoints={listRewindPoints}
        hasOlder={hasOlder}
        onLoadOlder={loadOlder}
        onOpenResume={handleOpenResume}
        hydrating={hydrating}
      />

      {/* Pinned blocked-action card: codex/opencode cannot prompt, so this offers a mode escalation */}
      {activeBlocked && !activePermission && (
        <div className="px-3 pb-2 select-none animate-in fade-in slide-in-from-bottom-2 duration-150 flex-shrink-0 z-30">
          <AiBlockedCard
            engine={activeBlocked.engine || engine}
            message={activeBlocked.message}
            escalate={activeBlocked.escalate}
            onEscalate={escalateMode}
            onDismiss={dismissBlocked}
          />
        </div>
      )}

      {/* Pinned Active Permission or Question Gate directly above composer */}
      {activePermission && (
        <div className="px-3 pb-2 select-none animate-in fade-in slide-in-from-bottom-2 duration-150 flex-shrink-0 z-30">
          {activePermission.tool === "AskUserQuestion" ? (
            <AiQuestionCard
              requestId={activePermission.requestId}
              questions={activePermission.input?.questions || []}
              onResolve={(reqId, answers) => resolvePermission(reqId, "allow", "", answers)}
            />
          ) : (
            <AiPermissionCard
              requestId={activePermission.requestId}
              tool={activePermission.tool}
              input={activePermission.input}
              onResolve={resolvePermission}
            />
          )}
        </div>
      )}

      {/* Composer Input Box with integrated Model and Mode pickers */}
      <Composer
        sessionId={sessionId}
        engine={engine}
        onSend={sendPrompt}
        onStop={stop}
        onRunShell={runShell}
        onSelectModel={handleSelectModel}
        onModeChange={handleModeChange}
        onOpenModal={setActiveModal}
        onOptionChange={handleOptionChange}
        onActivate={onActivate}
        isFocused={isFocused}
        fileBus={fileBus}
        workspacePath={workspacePath}
        modalOpen={activeModal !== null}
      />

      {/* Status Bar with Session Name, Skills, MCP & Actions */}
      <AiStatusBar
        sessionId={sessionId}
        sessionName={sessionName}
        engine={engine}
        isDesktop={isDesktop}
        onModeChange={handleModeChange}
        onOpenSkills={() => setActiveModal("skills")}
        onOpenMcp={() => setActiveModal("mcp")}
        onClear={handleClear}
      />

      {/* Modals */}
      {activeModal === "skills" && (
        <SkillsModal
          skills={skills}
          onClose={() => setActiveModal(null)}
          onSelectSkill={handleSelectSkill}
        />
      )}

      {activeModal === "mcp" && (
        <McpModal
          mcpServers={mcpServers}
          onClose={() => setActiveModal(null)}
        />
      )}

      {activeModal === "model" && (
        <ModelModal
          currentModel={metadata.model}
          currentEffort={metadata.effort || ""}
          models={metadata.modelOptions?.length ? metadata.modelOptions : engineConfig.models}
          onClose={() => setActiveModal(null)}
          onSelectModel={handleSelectModel}
          onSelectEffort={(effort) => emitOptions({ effort })}
        />
      )}

      {activeModal === "sessions" && (
        <SessionsModal
          engine={engine}
          workspacePath={workspacePath}
          onClose={() => setActiveModal(null)}
          onResume={handleResumeSession}
        />
      )}

      {activeModal === "config" && (
        <ConfigModal
          engine={engine}
          options={useAiStore.getState().bySession[sessionId]?.metadata}
          onClose={() => setActiveModal(null)}
          onApply={(options) => emitOptions(options)}
        />
      )}

      {activeModal === "mode" && (
        <ModeModal
          modes={engineConfig.permissionModes || []}
          currentMode={useAiStore.getState().bySession[sessionId]?.permissionMode || engineConfig.defaultMode}
          onClose={() => setActiveModal(null)}
          onSelectMode={handleModeChange}
        />
      )}

      {activeModal === "doctor" && (
        <DoctorModal
          engine={engine}
          workspacePath={workspacePath}
          onClose={() => setActiveModal(null)}
        />
      )}

      {activeModal === "tasks" && (
        <TasksModal
          tasks={tasks}
          onClose={() => setActiveModal(null)}
        />
      )}

      {activeModal === "rewind" && (
        <RewindModal
          sessionId={sessionId}
          onListPoints={listRewindPoints}
          onPreview={previewRewind}
          onApply={(messageId) => rewindToMessage(messageId)}
          onClose={() => setActiveModal(null)}
        />
      )}

      {/* The same checklist a terminal keeps, keyed to this chat's session. */}
      {noteModalOpen && showNoteButton && (
        <NotePanel
          bus={bus}
          sessionId={sessionId}
          onClose={() => setNoteModalOpen(false)}
        />
      )}
    </div>
  );
});

export default AiPaneView;
