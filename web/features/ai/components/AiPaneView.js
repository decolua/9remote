"use client";

import { memo } from "react";
import { useAiSession } from "../hooks/useAiSession";
import { useAiStore } from "@/shared/stores/aiStore";
import { AiMessagesList } from "./AiMessagesList";
import { Composer } from "./Composer";
import { AiStatusBar } from "./AiStatusBar";
import { Loader2 } from "@/shared/components/ui/Icon";

const StepLogStrip = memo(function StepLogStrip({ sessionId }) {
  const isTurnRunning = useAiStore((s) => s.bySession[sessionId]?.isTurnRunning);
  const lastMsg = useAiStore((s) => {
    const list = s.bySession[sessionId]?.messages;
    return list && list.length > 0 ? list[list.length - 1] : null;
  });

  if (!isTurnRunning) return null;

  const activeTool = lastMsg?.tools?.find((t) => t.status === "running");
  const hasThinking = Boolean(lastMsg?.thinking && !lastMsg?.content);

  return (
    <div className="px-4 py-1.5 flex items-center gap-2 text-xs text-text-muted bg-surface-2/40 border-t border-border-subtle/50 select-none">
      <Loader2 size={13} className="animate-spin text-brand-500 shrink-0" />
      <span className="truncate">
        {activeTool ? (
          <>Running <span className="font-mono text-text">{activeTool.name}</span>: {activeTool.command || activeTool.path || ""}</>
        ) : hasThinking ? (
          "Reasoning and analyzing context..."
        ) : (
          "Generating response..."
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
  const { sendPrompt, resolvePermission, stop, runShell } = useAiSession({
    sessionId,
    engine,
    workspacePath,
    bus
  });

  const branch = workspacePath ? workspacePath.split("/").pop() : "main";

  return (
    <div className="w-full h-full flex flex-col bg-bg overflow-hidden relative select-text">
      {/* Scrollable Message List */}
      <AiMessagesList
        sessionId={sessionId}
        engine={engine}
        onSendPrompt={sendPrompt}
        onResolvePermission={resolvePermission}
      />

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

      {/* Status Bar */}
      <AiStatusBar sessionId={sessionId} branch={branch} />
    </div>
  );
});
