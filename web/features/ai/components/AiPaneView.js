"use client";

import { memo, useState, useCallback, useMemo, useEffect, useRef } from "react";
import { useAiSession } from "../hooks/useAiSession";
import { useAiStore } from "@/shared/stores/aiStore";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { useTheme } from "@/shared/theme/ThemeProvider";
import { AiMessagesList } from "./AiMessagesList";
import { Composer } from "./Composer";
import { AiStatusBar } from "./AiStatusBar";
import { SkillsModal } from "./modals/SkillsModal";
import { McpModal } from "./modals/McpModal";
import { ModelModal } from "./modals/ModelModal";
import { SessionsModal } from "./modals/SessionsModal";
import { ConfigModal } from "./modals/ConfigModal";
import { DoctorModal } from "./modals/DoctorModal";
import { TasksModal } from "./modals/TasksModal";
import { AiPermissionCard } from "./cards/AiPermissionCard";
import { AiBlockedCard } from "./cards/AiBlockedCard";
import { AiQuestionCard } from "./cards/AiQuestionCard";
import { AiTaskCard } from "./cards/AiTaskCard";
import { getEngineConfig } from "../registry";
import { AI_FONT_SIZE_BOOST, AI_DOT_GRID, AI_TURN_VERBS, AI_TURN_VERB_INTERVAL_MS } from "../constants";
import { useConnectionStore } from "@/shared/stores/connectionStore";
import { vibrate } from "@/shared/utils/vibration";
import {
  backgroundSrc,
  paneBackgroundKey,
  resolvableBackgroundKeys,
  effectiveFontSize,
  TERMINAL_BG_ALPHA,
  TERMINAL_BG_VEIL_RGB,
  TERMINAL_BG_LIFT_RGB,
  TERMINAL_BG_LIFT
} from "@/features/terminal/constants/terminalConfig";
import { resolveTerminalTheme } from "@/shared/theme/themeConfig";

const DEFAULT_METADATA = { model: "", skills: [], mcpServers: [] };
const EMPTY_TASKS = [];

const pad2 = (n) => String(n).padStart(2, "0");

// "1m 12s" while it runs, "1m 12s" once done — both are the same wall-clock span.
function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m ${pad2(s)}s`;
  if (m > 0) return `${m}m ${pad2(s)}s`;
  return `${s}s`;
}

// Token counts follow the CLI's shorthand: 1234 → 1.2k, 1234567 → 1.2M
function formatTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(v);
}

// One line at the foot of the pane: live progress while the agent works, then the
// finished summary (span + local completion time + tokens, as the CLI prints it).
const AiTurnStatus = memo(function AiTurnStatus({ sessionId }) {
  const isTurnRunning = useAiStore((s) => s.bySession[sessionId]?.isTurnRunning);
  const turnStartedAt = useAiStore((s) => s.bySession[sessionId]?.turnStartedAt);
  const stats = useAiStore((s) => s.bySession[sessionId]?.stats);
  const hasMessages = useAiStore((s) => (s.bySession[sessionId]?.messages?.length || 0) > 0);
  const lastMsg = useAiStore((s) => {
    const list = s.bySession[sessionId]?.messages;
    return list && list.length > 0 ? list[list.length - 1] : null;
  });

  const [now, setNow] = useState(Date.now());
  const [verbIdx, setVerbIdx] = useState(0);

  useEffect(() => {
    if (!isTurnRunning) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const verbTimer = setInterval(
      () => setVerbIdx((i) => (i + 1) % AI_TURN_VERBS.length),
      AI_TURN_VERB_INTERVAL_MS
    );
    return () => { clearInterval(timer); clearInterval(verbTimer); };
  }, [isTurnRunning]);

  // Freeze the summary against the same clock the live line used.
  const [finished, setFinished] = useState(null);
  const prevRunningRef = useRef(isTurnRunning);
  useEffect(() => {
    if (prevRunningRef.current && !isTurnRunning && turnStartedAt) {
      const end = Date.now();
      setFinished({
        ms: end - turnStartedAt,
        doneAt: new Date(end),
        outputTokens: stats?.outputTokens || 0
      });
    }
    if (isTurnRunning) setFinished(null);
    prevRunningRef.current = isTurnRunning;
  }, [isTurnRunning, turnStartedAt, stats?.outputTokens]);

  // Nothing to show in a session that has not run a turn yet.
  if (!isTurnRunning && !finished) return null;
  if (!isTurnRunning && !hasMessages) return null;

  if (!isTurnRunning) {
    return (
      <div className="px-3 py-1 flex items-center gap-2 text-xs text-text-muted bg-surface-2/30 border-t border-border-subtle/50 select-none">
        <span className="truncate font-mono text-[11px]">
          Worked for <span className="text-text">{formatDuration(finished.ms)}</span>
          <span className="text-text-muted/60"> · </span>
          done {pad2(finished.doneAt.getHours())}:{pad2(finished.doneAt.getMinutes())}
          {finished.outputTokens > 0 && (
            <>
              <span className="text-text-muted/60"> · </span>
              ↓ {formatTokens(finished.outputTokens)}
            </>
          )}
        </span>
      </div>
    );
  }

  const activeTool = lastMsg?.tools?.find((t) => t.status === "running");
  const outputTokens = stats?.outputTokens || 0;

  return (
    <div className="px-3 py-1 flex items-center gap-2 text-xs text-text-muted bg-surface-2/30 border-t border-border-subtle/50 select-none">
      <span className="text-brand-500 shrink-0 animate-cli-glyph">✻</span>
      <span className="truncate font-mono text-[11px] ai-sheen-text">
        {activeTool ? (
          <>
            Running <span className="text-text font-semibold">{activeTool.name}</span>: {activeTool.command || activeTool.path || ""}
          </>
        ) : (
          <>
            <span className="text-text">{AI_TURN_VERBS[verbIdx]}</span>…
          </>
        )}
        <span className="text-text-muted/60"> · </span>
        {formatDuration(now - (turnStartedAt || now))}
        {outputTokens > 0 && (
          <>
            <span className="text-text-muted/60"> · </span>
            ↓ {formatTokens(outputTokens)}
          </>
        )}
      </span>
    </div>
  );
});

export const AiPaneView = memo(function AiPaneView({
  sessionId,
  engine = "claude",
  workspacePath = "",
  sessionName = "",
  bus = null,
  fileBus = null,
  isFocused = false,
  bgIndex = 0,
  onActivate = null
}) {
  const [activeModal, setActiveModal] = useState(null); // 'skills' | 'mcp' | 'model'

  const { sendPrompt, resolvePermission, stop, runShell, rewindToMessage, escalateMode, dismissBlocked, hasOlder, loadOlder } = useAiSession({
    sessionId,
    engine,
    workspacePath,
    bus
  });

  const activePermission = useAiStore((s) => s.bySession[sessionId]?.activePermission);
  const activeBlocked = useAiStore((s) => s.bySession[sessionId]?.activeBlocked);
  const metadata = useAiStore((s) => s.bySession[sessionId]?.metadata) || DEFAULT_METADATA;
  const tasks = useAiStore((s) => s.bySession[sessionId]?.tasks) || EMPTY_TASKS;
  const clearMessages = useAiStore((s) => s.clearMessages);
  const setPermissionMode = useAiStore((s) => s.setPermissionMode);

  const terminalBackgroundOpacity = useTerminalStore((s) => s.terminalBackgroundOpacity);
  const customBackgrounds = useTerminalStore((s) => s.customBackgrounds);
  const terminalBackgrounds = useTerminalStore((s) => s.terminalBackgrounds);
  const terminalTheme = useTerminalStore((s) => s.terminalTheme);
  const fontSize = useTerminalStore((s) => s.fontSize);
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

  // Apply a submenu value (effort, variant, sandbox) to the running session.
  const handleOptionChange = useCallback((key, value) => {
    if (!key) return;
    emitOptions({ [key]: value });
  }, [emitOptions]);

  const engineConfig = getEngineConfig(engine);

  const handleModeChange = useCallback((mode) => {
    setPermissionMode(sessionId, mode);
    emitOptions({ mode });
  }, [emitOptions, sessionId, setPermissionMode]);

  // Container-level fallback for Shift+Tab when focused outside composer
  const handleKeyDown = useCallback((e) => {
    if (e.shiftKey && e.key === "Tab") {
      e.preventDefault();
      vibrate();
      const modes = engineConfig.permissionModes || [];
      const currentMode = useAiStore.getState().bySession[sessionId]?.permissionMode || "default";
      const currentIdx = modes.findIndex((m) => m.id === currentMode);
      const nextIdx = currentIdx === -1 ? 0 : (currentIdx + 1) % modes.length;
      const nextMode = modes[nextIdx]?.id;
      if (nextMode) handleModeChange(nextMode);
    }
  }, [sessionId, engineConfig.permissionModes, handleModeChange]);

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
      {/* Pinned Task Checklist Strip at the Top */}
      <AiTaskCard sessionId={sessionId} />

      {/* Scrollable Message List */}
      <AiMessagesList
        sessionId={sessionId}
        engine={engine}
        workspacePath={workspacePath}
        onSendPrompt={sendPrompt}
        onResolvePermission={resolvePermission}
        onRewind={rewindToMessage}
        hasOlder={hasOlder}
        onLoadOlder={loadOlder}
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

      {/* Turn status: live progress, then the finished summary */}
      <AiTurnStatus sessionId={sessionId} />

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
      />

      {/* Status Bar with Session Name, Skills, MCP & Actions */}
      <AiStatusBar
        sessionId={sessionId}
        sessionName={sessionName}
        engine={engine}
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
          models={metadata.modelOptions?.length ? metadata.modelOptions : engineConfig.models}
          onClose={() => setActiveModal(null)}
          onSelectModel={handleSelectModel}
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
          onClose={() => setActiveModal(null)}
          onApply={(flags) => emitOptions({ flags })}
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
    </div>
  );
});

export default AiPaneView;
