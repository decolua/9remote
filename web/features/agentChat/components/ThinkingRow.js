"use client";

import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/shared/components/ui/Collapsible";
import { useI18n } from "@/shared/i18n";

// Reasoning is long and rarely what the user came for — collapsed by default, one line.
export default function ThinkingRow({ text }) {
  const { t } = useI18n();
  return (
    <Collapsible className="chat-row my-1 pl-8">
      <CollapsibleTrigger className="flex items-center gap-1.5 py-0.5 font-mono text-[11px] text-text-subtle transition-colors hover:text-text-muted">
        {t("terminalPane.agentChatThought")}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap break-words border-l-2 border-border-subtle pl-3 text-[12px] italic leading-relaxed text-text-subtle">
        {text}
      </CollapsibleContent>
    </Collapsible>
  );
}
