"use client";

import { memo, useState, useCallback, useMemo } from "react";
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
import { AiPermissionCard } from "./cards/AiPermissionCard";
import { AiQuestionCard } from "./cards/AiQuestionCard";
import { AiTaskCard } from "./cards/AiTaskCard";
import { getEngineConfig } from "../registry";
import { Loader2 } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import {
  backgroundSrc,
  paneBackgroundKey,
  resolvableBackgroundKeys,
  TERMINAL_BG_ALPHA,
  TERMINAL_BG_VEIL_RGB,
  TERMINAL_BG_LIFT_RGB,
  TERMINAL_BG_LIFT
} from "@/features/terminal/constants/terminalConfig";

const DEFAULT_METADATA = { model: "", skills: [], mcpServers: [] };

const StepLogStrip = memo(function StepLogStrip({ sessionId }) {
  const isTurnRunning = useAiStore((s) => s.bySession[sessionId]?.isTurnRunning);
  const lastMsg = useAiStore((s) => {
    const list = s.bySession[sessionId]?.messages;
    return list && list.length > 0 ? list[list.length - 1] : null;
  });

  if (!isTurnRunning) return null;

  const activeTool = lastMsg?.tools?.find((t) => t.status === "running");

  // Tool activity only — "thinking" already renders in the message bubble above
  if (!activeTool) return null;

  return (
    <div className="px-3 py-1 flex items-center gap-2 text-xs text-text-muted bg-surface-2/30 border-t border-border-subtle/50 select-none">
      <Loader2 size={12} className="animate-spin text-brand-500 shrink-0" />
      <span className="truncate font-mono text-[11px]">
        Running <span className="text-text font-semibold">{activeTool.name}</span>: {activeTool.command || activeTool.path || ""}
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
  onActivate = null
}) {
  const [activeModal, setActiveModal] = useState(null); // 'skills' | 'mcp' | 'model'

  const { sendPrompt, resolvePermission, stop, runShell, rewindToMessage } = useAiSession({
    sessionId,
    engine,
    workspacePath,
    bus
  });

  const activePermission = useAiStore((s) => s.bySession[sessionId]?.activePermission);
  const metadata = useAiStore((s) => s.bySession[sessionId]?.metadata) || DEFAULT_METADATA;
  const clearMessages = useAiStore((s) => s.clearMessages);
  const setPermissionMode = useAiStore((s) => s.setPermissionMode);

  const terminalBackgroundOpacity = useTerminalStore((s) => s.terminalBackgroundOpacity);
  const customBackgrounds = useTerminalStore((s) => s.customBackgrounds);
  const terminalBackgrounds = useTerminalStore((s) => s.terminalBackgrounds);
  const { theme } = useTheme();

  // Background styling: prioritize custom terminal background image, else render subtle dot-grid.
  // Light theme skips the image entirely (veil is tuned for dark, washes out on light).
  const bgStyle = useMemo(() => {
    if (theme === "light") return {};
    const paneBgKey = paneBackgroundKey(resolvableBackgroundKeys(terminalBackgrounds, customBackgrounds), 0);
    const bgSrc = backgroundSrc(paneBgKey, customBackgrounds);
    if (bgSrc) {
      const veil = `rgba(${TERMINAL_BG_VEIL_RGB},${terminalBackgroundOpacity ?? TERMINAL_BG_ALPHA})`;
      const lift = `rgba(${TERMINAL_BG_LIFT_RGB},${TERMINAL_BG_LIFT})`;
      return {
        background: `linear-gradient(${veil},${veil}), linear-gradient(${lift},${lift}), center / cover no-repeat url("${bgSrc}")`,
        backgroundBlendMode: "normal, screen, normal"
      };
    }
    return {
      backgroundImage: "radial-gradient(rgba(255, 255, 255, 0.08) 1px, transparent 1px)",
      backgroundSize: "18px 18px",
      backgroundPosition: "center center"
    };
  }, [terminalBackgrounds, customBackgrounds, terminalBackgroundOpacity, theme]);

  const skills = metadata.skills || [];
  const mcpServers = metadata.mcpServers || [];

  const handleClear = useCallback(() => {
    vibrate();
    clearMessages(sessionId);
    sendPrompt("/clear");
  }, [clearMessages, sessionId, sendPrompt]);

  const handleSelectSkill = useCallback((skillName) => {
    sendPrompt(`/${skillName}`);
  }, [sendPrompt]);

  const handleSelectModel = useCallback((modelId) => {
    sendPrompt(`/model ${modelId}`);
  }, [sendPrompt]);

  const engineConfig = getEngineConfig(engine);

  const handleModeChange = useCallback((mode) => {
    setPermissionMode(sessionId, mode);
    bus?.emit?.("ai:options", { sessionId, options: { mode } });
  }, [sessionId, setPermissionMode, bus]);

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
      className="w-full h-full flex flex-col bg-bg overflow-hidden relative select-text"
      style={bgStyle}
    >
      {/* Pinned Task Checklist Strip at the Top */}
      <AiTaskCard sessionId={sessionId} />

      {/* Scrollable Message List */}
      <AiMessagesList
        sessionId={sessionId}
        engine={engine}
        onSendPrompt={sendPrompt}
        onResolvePermission={resolvePermission}
        onRewind={rewindToMessage}
      />

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

      {/* Step log strip when running */}
      <StepLogStrip sessionId={sessionId} />

      {/* Composer Input Box with integrated Model and Mode pickers */}
      <Composer
        sessionId={sessionId}
        engine={engine}
        onSend={sendPrompt}
        onStop={stop}
        onRunShell={runShell}
        onSelectModel={handleSelectModel}
        onModeChange={handleModeChange}
        onActivate={onActivate}
        isFocused={isFocused}
        fileBus={fileBus}
        workspacePath={workspacePath}
      />

      {/* Status Bar with Session Name, Skills, MCP & Actions */}
      <AiStatusBar
        sessionId={sessionId}
        sessionName={sessionName}
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
          models={engineConfig.models}
          onClose={() => setActiveModal(null)}
          onSelectModel={handleSelectModel}
        />
      )}
    </div>
  );
});

export default AiPaneView;
