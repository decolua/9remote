"use client";

import { useState } from "react";
import Icon from "@/shared/components/ui/Icon";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/shared/components/ui/Collapsible";
import { useI18n } from "@/shared/i18n";
import PromptCardShell from "./PromptCardShell";

// Two buttons only. There is no remembered-permission store on this side — the TUI owns
// that decision, so offering "allow & remember" here would be a promise we cannot keep.
export default function PermissionCard({ prompt, onRespond, busy }) {
  const { t } = useI18n();
  const [sending, setSending] = useState(null);

  const decide = async (action) => {
    setSending(action);
    await onRespond({ action });
    setSending(null);
  };

  const disabled = busy || sending != null;
  const raw = (() => {
    try { return JSON.stringify(prompt.toolInput, null, 2); } catch { return ""; }
  })();

  return (
    <PromptCardShell
      eyebrow={t("terminalPane.agentChatPermissionEyebrow")}
      icon={<Icon name="ShieldQuestion" size={15} />}
      footer={
        <>
          <button
            type="button"
            onClick={() => decide("deny")}
            disabled={disabled}
            className="rounded-[8px] px-3 py-1.5 text-[12px] font-medium text-text-muted transition-colors hover:bg-surface-3 hover:text-text disabled:opacity-40"
          >
            {t("terminalPane.agentChatDeny")}
          </button>
          <button
            type="button"
            onClick={() => decide("allow")}
            disabled={disabled}
            className="btn-cta rounded-[8px] bg-brand-500 px-4 py-1.5 text-[12px] font-semibold text-white shadow-lg shadow-brand-500/30 transition-all duration-150 active:scale-[0.97] disabled:animate-none disabled:opacity-40"
          >
            {t("terminalPane.agentChatAllow")}
          </button>
        </>
      }
    >
      <p className="mt-0.5 truncate font-mono text-[13px] text-text">{prompt.toolName}</p>

      {raw && (
        <Collapsible className="mt-1.5">
          <CollapsibleTrigger className="flex items-center gap-1 py-0.5 text-[11px] text-text-subtle transition-colors hover:text-text">
            {t("terminalPane.agentChatViewDetails")}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-[8px] border border-border-subtle bg-surface-2 p-2 font-mono text-[11px] text-text-muted">
              {raw}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      )}
    </PromptCardShell>
  );
}
