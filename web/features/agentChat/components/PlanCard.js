"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Icon from "@/shared/components/ui/Icon";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/shared/components/ui/Collapsible";
import { useI18n } from "@/shared/i18n";
import PromptCardShell from "./PromptCardShell";
import { MARKDOWN_COMPONENTS } from "./markdownComponents";

/**
 * Shows the plan and — only when the agent could read the real menu — offers its options.
 *
 * The plan menu's option count and wording differ between Claude builds, so the buttons
 * are built from what the agent counted on screen. With no verified count we render the
 * plan read-only and point at the terminal, rather than sending a number that might pick
 * a branch the user did not choose.
 */
export default function PlanCard({ prompt, onRespond, busy, optionCount }) {
  const { t } = useI18n();
  const [sending, setSending] = useState(false);
  const plan = prompt?.toolInput?.plan || prompt?.toolInput?.content || "";
  const canDecide = Number.isInteger(optionCount) && optionCount > 0;

  const decide = async (choice) => {
    setSending(true);
    await onRespond(choice);
    setSending(false);
  };

  const disabled = busy || sending;

  return (
    <PromptCardShell
      eyebrow={t("terminalPane.agentChatPlanEyebrow")}
      icon={<Icon name="ClipboardList" size={15} />}
      footer={
        canDecide ? (
          <>
            <button
              type="button"
              onClick={() => decide({ action: "deny" })}
              disabled={disabled}
              className="rounded-[8px] px-3 py-1.5 text-[12px] font-medium text-text-muted transition-colors hover:bg-surface-3 hover:text-text disabled:opacity-40"
            >
              {t("terminalPane.agentChatKeepPlanning")}
            </button>
            <div className="flex items-center gap-1.5">
              {Array.from({ length: optionCount }, (_, i) => i + 1).map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => decide({ optionIndex: n })}
                  disabled={disabled}
                  className={`rounded-[8px] px-3 py-1.5 text-[12px] font-semibold transition-all duration-150 active:scale-[0.97] disabled:opacity-40 ${
                    n === 1
                      ? "btn-cta bg-brand-500 text-white shadow-lg shadow-brand-500/30 disabled:animate-none"
                      : "border border-border-subtle text-text-muted hover:bg-surface-3 hover:text-text"
                  }`}
                >
                  <span className="font-mono text-[10px] opacity-70">{n}</span>
                  <span className="ml-1.5">{t("terminalPane.agentChatPlanOption")}</span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <span className="text-[11px] text-text-subtle">{t("terminalPane.agentChatAnswerInTerminal")}</span>
        )
      }
    >
      <Collapsible defaultOpen className="mt-1">
        <CollapsibleTrigger className="flex items-center gap-1.5 py-0.5 text-[11px] text-text-subtle transition-colors hover:text-text">
          {t("terminalPane.agentChatViewPlan")}
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-1.5 max-h-72 overflow-y-auto pr-1 text-[13px] leading-relaxed text-text-muted">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
            {plan}
          </ReactMarkdown>
        </CollapsibleContent>
      </Collapsible>
    </PromptCardShell>
  );
}
