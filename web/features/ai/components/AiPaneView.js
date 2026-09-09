"use client";

import { memo, useState, useCallback } from "react";
import { useAiSession } from "../hooks/useAiSession";
import { useAiStore } from "@/shared/stores/aiStore";
import { AiMessagesList } from "./AiMessagesList";
import { Composer } from "./Composer";
import { AiStatusBar } from "./AiStatusBar";
import { SkillsModal } from "./modals/SkillsModal";
import { McpModal } from "./modals/McpModal";
import { ModelModal } from "./modals/ModelModal";
import { AiPermissionCard } from "./cards/AiPermissionCard";
import { AiQuestionCard } from "./cards/AiQuestionCard";
import { Loader2 } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";

const StepLogStrip = memo(function StepLogStrip({ sessionId }) {
  const isTurnRunning = useAiStore((s) => s.bySession[sessionId]?.isTurnRunning);
  const lastMsg = useAiStore((s) => {
    const list = s.bySession[sessionId]?.messages;
    return list && list.length > 0 ? list[list.length - 1] : null;
  });

  if (!isTurnRunning) return null;

  const activeTool = lastMsg?.tools?.find((t) => t.status === "running");
  const hasThinking = Boolean(lastMsg?.thinking && !lastMsg?.content);

  // Only show strip if active tool or thinking is running
  if (!activeTool && !hasThinking) return null;

  return (
    <div className="px-3 py-1 flex items-center gap-2 text-xs text-text-muted bg-surface-2/30 border-t border-border-subtle/50 select-none">
      <Loader2 size={12} className="animate-spin text-brand-500 shrink-0" />
      <span className="truncate font-mono text-[11px]">
        {activeTool ? (
          <>Running <span className="text-text font-semibold">{activeTool.name}</span>: {activeTool.command || activeTool.path || ""}</>
        ) : (
          "Reasoning..."
        )}
      </span>
    </div>
  );
});

export const AiPaneView = memo(function AiPaneView({
  sessionId,
  engine = "claude",
  workspacePath = "",
  bus = null,
  fileBus = null,
  isFocused = false
}) {
  const [activeModal, setActiveModal] = useState(null); // 'skills' | 'mcp' | 'model'

  const { sendPrompt, resolvePermission, stop, runShell } = useAiSession({
    sessionId,
    engine,
    workspacePath,
    bus
  });

  const activePermission = useAiStore((s) => s.bySession[sessionId]?.activePermission);
  const metadata = useAiStore((s) => s.bySession[sessionId]?.metadata || { model: "", skills: [], mcpServers: [] });
  const clearMessages = useAiStore((s) => s.clearMessages);
  const setPermissionMode = useAiStore((s) => s.setPermissionMode);

  const branch = workspacePath ? workspacePath.split("/").pop() : "main";
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

  const handleModeChange = useCallback((mode) => {
    setPermissionMode(sessionId, mode);
    bus?.emit?.("ai:options", { sessionId, options: { mode } });
  }, [sessionId, setPermissionMode, bus]);

  return (
    <div className="w-full h-full flex flex-col bg-bg overflow-hidden relative select-text">
      {/* Scrollable Message List */}
      <AiMessagesList
        sessionId={sessionId}
        engine={engine}
        onSendPrompt={sendPrompt}
        onResolvePermission={resolvePermission}
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

      {/* Composer Input Box */}
      <Composer
        sessionId={sessionId}
        engine={engine}
        onSend={sendPrompt}
        onStop={stop}
        onRunShell={runShell}
        fileBus={fileBus}
        workspacePath={workspacePath}
      />

      {/* Status Bar with Mode Selector & Quick Actions */}
      <AiStatusBar
        sessionId={sessionId}
        branch={branch}
        onOpenSkills={() => setActiveModal("skills")}
        onOpenMcp={() => setActiveModal("mcp")}
        onClear={handleClear}
        onModeChange={handleModeChange}
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
          onClose={() => setActiveModal(null)}
          onSelectModel={handleSelectModel}
        />
      )}
    </div>
  );
});
